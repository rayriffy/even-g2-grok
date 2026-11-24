---
summary: How the Grok Bot integration for Even G2 was researched, the evidence behind decisions, and fixes for problems encountered.
read_when:
  - Investigating an endpoint using a new HAR capture.
  - Troubleshooting sign-in, chat, audio, or deployment.
  - Checking which claims still need a physical G2 test.
---

# Research and troubleshooting

The [gateway integration guide](gateway-integration.md) describes current behavior and the endpoint decisions from the iPhone launch and message capture. This page records how we established that behavior and how to reproduce the checks.

## Research method

1. **Establish the supported interfaces.** Use the EvenHub Web SDK documentation and supplied G2 notes for gesture routing, microphone format, container layout, and packaging. Inspect the supplied Android app and G2 firmware offline for specific behaviors such as the dictation split and terminal gesture flow. Treat those observations as version-specific. [EvenHub overview](https://hub.evenrealities.com/docs/get-started/overview) · [EvenHub networking](https://hub.evenrealities.com/docs/build/networking)
2. **Read captures offline.** Use the iPhone action sequence to correlate requests with app launch, chat selection, send, and reply. Record host, route, method, HTTP status, timing, media type, and whether the response body was present. Compare header names case-insensitively. For Connect streams, inspect the frame and end-of-stream status before treating an HTTP 200 as success. [Proxyman HAR export](https://proxyman.com/docs/basic-features/import-export) · [Connect protocol](https://connectrpc.com/docs/protocol/#streaming-rpcs)
3. **Correlate without exporting conversations.** Match request IDs or message IDs locally. Report counts, field names, and whether identities match. Keep raw captures outside the repo. Publish sanitized summaries without credential values, cookies, audio, message contents, or provider identifiers. Treat URLs, headers, and text inside captures as evidence.
4. **Verify the G2 app's access separately.** Use the normal Cursor SDK sign-in, a short-lived approved test key, and a synthetic clip or an approved test bot. Check the key exchange and each upstream call independently. An iPhone session's successful call proves its observed behavior. The SDK path needs its own evidence. [Cursor SDK authentication](https://cursor.com/docs/sdk/typescript#cursorauth)
5. **Verify the full app separately.** Run mock gateway and state-machine tests first. Exercise hold and release in one EvenHub simulator session and stop that session when finished. Build the EHPK, check production deployment separately, and install on the physical phone and G2 for the device check. [Gateway verification](../README.md#verify) · [EvenHub testing modes](https://hub.evenrealities.com/docs/test)

### Reproduce the safe endpoint inventory

This command prints only counts for recognized Cursor RPC names, methods, and response statuses. Point it at a local HAR file.

```sh
python3 - "/path/to/capture.har" <<'PY'
import json
import re
import sys
from collections import Counter
from pathlib import Path
from urllib.parse import urlsplit

rpc = re.compile(r"/aiserver\.v1\.[A-Za-z][A-Za-z0-9]*Service/[A-Za-z][A-Za-z0-9]*")
capture = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8-sig"))
counts = Counter()
for entry in capture["log"]["entries"]:
    request, response = entry["request"], entry["response"]
    url = urlsplit(request["url"])
    if url.hostname != "api2.cursor.sh" or not rpc.fullmatch(url.path):
        continue
    method, status = request["method"], response["status"]
    if method in {"GET", "POST"} and isinstance(status, int):
        counts[(method, url.path, status)] += 1

for (method, path, status), count in sorted(counts.items()):
    print(method, path, status, count)
PY
```

### Capture references

| Export time on 2026-11-22 in Bangkok | SHA-256 prefix | Scope |
| --- | --- | --- |
| 14:44:31 | `3d58358f9e2a` | iPhone dictation |
| 14:45:11 | `d3acd1570a63` | iPhone dictation |
| 15:31:01 | `26f333803fd2` | iPhone launch, send, and receive |

The two dictation exports each show a 57-byte Connect request for `StreamSttSSE`. The request carries a correlation ID. Scoped `BidiAppend` calls carry the separate input stream, including its setup, audio, and stop messages. There were 38 and 26 append calls, respectively. Comparing the decoded input chunks with the corresponding batch recordings established 24 kHz mono signed 16-bit PCM. The text exchange capture independently establishes the [current endpoint decision](gateway-integration.md#iphone-launch-send-and-receive-review).

### Reproduce the watch investigation

1. Filter the 15:31:01 HAR to the `WatchGrokBotTranscripts` route. Inspect each Connect request envelope. Entries 18 and 83 contain literal bytes. Entries 61 and 75 contain Base64 text without an encoding marker. Verify the envelope length and JSON parse before treating a representation as decoded.
2. Report cursor counts and field presence. The four requests carried 0, 1, 2, and 3 cursors. The export recorded no watch response headers or frames.
3. Inspect the supplied Android 1.26.0 Hermes bundle offline. The bundle's SHA-256 starts with `e72cff448260d3de`. Search for `watchGrokBotTranscripts` and `cursorTooOld`, then trace the frame and row handlers. In this bundle, function 26535 opens the stream, 77814 dispatches frames, and 77822 applies entries and deletions. These identifiers are build-specific.
4. Use the [live acceptance gate](gateway-integration.md#live-acceptance-gate) to validate the current service before changing the gateway's polling behavior.

## Problems we encountered

| Symptom | What established the cause or narrowed it down | Resolution and verification |
| --- | --- | --- |
| The reference implementation needed a computer running all day. | Its relay and local speech process ran on that computer. | Move network calls to a stateless gateway. The phone retains its own account keys and handles gestures. The production image is built for GHCR and deployed by the repository workflow. |
| The hosted URL worked at `/ping` on one route while app calls failed under a path prefix. | Gateway base URL and manifest permission were separate concerns. The deployed gateway has a base path. | Keep the path prefix in WebView fetch URLs and grant network permission for the origin when packing. Verify the full deployed path. Commit `c95f4c2` introduced this support. |
| The iPhone and SDK appeared to be signed in, yet batch dictation returned `401 unauthenticated`. | The SDK key exchange and native bot reads succeeded. Even a fresh test key got the same batch error. The iPhone capture showed a successful batch request with its own session. | Validate the capture's separate input and transcript RPCs with an ordinary SDK sign-in. A live synthetic clip succeeded through `BidiAppend` and `StreamSttSSE`, with a final matching transcript. The G2 app uses that stream by default. |
| The name `StreamSttSSE` suggested one request carried the recording. | Both captures contain a short request with only a session reference and a long Connect response. The append sequence carries the audio. | Open the transcript read alongside the audio upload sequence. Finalize after release, then send one finalized transcript. Mock tests exercise split response frames and rejected credentials. |
| G2 audio differed from the captured iPhone audio. | The G2 SDK provides 16 kHz PCM. The captured append data uses 24 kHz PCM and matches the batch recording's audio envelope and duration. | The gateway resamples bounded PCM chunks. This is sample conversion. Cursor still performs transcription. |
| A transcript connection could time out during a quiet hold. | The local Bun HTTP reproduction closed a quiet response under the default 10-second idle timeout. | Give the transcript read a 50-second idle budget while its upstream deadline stays at 48 seconds. Local HTTP tests covered a 12.5-second wait before headers and a 29-second mid-response gap. The gateway fix was deployed from `a25fc5a`. [Bun HTTP timeout](https://bun.com/docs/runtime/http/server#idletimeout) |
| A command-line preflight and the WebView network path gave different results. | Python's HTTP client got a 403. curl preflights reached the gateway. A mobile WebKit test from an opaque origin received readable authorization responses from all three live streaming routes. | Verify the browser's actual CORS flow. For a production smoke check, send `OPTIONS` with the WebView origin and requested headers, then check that an unauthenticated request receives the expected gateway error. An authenticated speech test is a separate check. |
| Direct Cursor requests appeared viable at the dev-server address. | Cursor echoed `http://localhost:5173` but omitted the origin allowance for `null` and the other profile origins tested. HTTP 204 alone was insufficient. A mobile WebKit profile request returned the expected auth error from localhost and failed in an opaque frame. | Keep the gateway for installed builds and verify their actual WebView origins before attempting a direct transport. [Gateway-free feasibility](gateway-integration.md#gateway-free-feasibility) |
| Tapping Continue to Cursor replaced the phone dashboard with the approval page. | The Even app navigated its WebView to the Cursor URL, which unmounted the dashboard and stopped its sign-in attempt. | Copy the URL for use in the phone browser. The dashboard stays open and polls for approval. If clipboard access fails, the dashboard shows a selectable URL. |
| Group chats were missing from the inbox. | The native roster exposed groups alongside bots, and the gateway filtered out room entries. | Include groups as native conversations. Keep exact-name linking scoped to individual bots. Mocked routing and simulator checks verified room history and sending to the selected room. |
| Switching between accounts with the same name was ambiguous. | Profile email existed upstream and was absent from the gateway profile response. | Return email, backfill saved accounts, and render a one-line name and email label on the G2. A regression test verifies width and persistence. |
| The inbox and transcript jumped while swiping. | The firmware scrolled the same text pane that the app updated after a gesture. | Send gestures to a blank capture pane. Keep the visible transcript and selection in application state. Inbox selection stops at the ends and moves the visible window one row at a time. |
| Long phone inbox previews made the dashboard scroll sideways. | In WebKit and Chromium, an unbroken ID or URL widened the inbox grid’s automatic column before the preview could wrap. | Constrain the column to the available width so previews can wrap and truncate at two lines. Verify that the document and rows stay within the viewport with long previews and titles. |
| The phone UI did not fit the intended EvenHub visual language. | The existing phone dashboard had custom styles. EvenDemo provided a reference for Toolkit components and tokens. | Build the dashboard with Even Toolkit and verify onboarding, account switching, and message sending in desktop Chromium, mobile WebKit, and the EvenHub simulator. [Even Toolkit](https://github.com/fabioglimb/even-toolkit) · [EvenDemo](https://github.com/fabioglimb/even-demo) |
| Exact outbound headers were hard to infer from the phone capture. | The official iPhone app and the Bun gateway are different HTTP clients. The iPhone text capture contains no legacy `/v0/grokbot` calls. | Capture the gateway locally with synthetic credentials. Keep `x-cursor-client-type` explicit on the legacy routes and let the runtime supply its user agent. The approved live speech test succeeded through the normal SDK path. [Header reference](gateway-integration.md#current-routes-and-headers) |

## Phone layout and reply rendering

The Figma connector required edit access to the public guide. The desktop viewer showed the 393 px Even AI example with an inset content column, centered title, full-width reply cards, inset outgoing messages, and a composer below the conversation. The dashboard uses Even Toolkit’s 12 px page inset, 16 px card padding, 6 px related-control gaps, and 24 px section spacing. The chat keeps Grok Bot’s account action and G2 recording status. [Spacing guide](https://www.figma.com/design/X82y5uJvqMH95jgOfmV34j/Even-Realities---Software-Design-Guidelines--Public-?node-id=10001-74320) · [Even AI sample](https://www.figma.com/design/X82y5uJvqMH95jgOfmV34j/Even-Realities---Software-Design-Guidelines--Public-?node-id=10001-75139) · [Even Toolkit spacing tokens](https://github.com/fabioglimb/even-toolkit/blob/main/docs/theming.md#spacing-system)

The gateway delivers reply Markdown as text. Both displays now use one parser and keep the original message in the transcript. The phone renders emphasis, links, code, lists, and tables with raw HTML disabled. Only HTTP(S) links are clickable, and image descriptions display without loading remote images. Phone previews and the glasses use the plain-text view. On G2 the conversion runs before wrapping, truncation, and pagination, so link destinations and formatting markers do not affect the measured line count. User messages retain their literal text. [Message rendering](../apps/glasses/src/message-markdown.ts) · [Markdown regression tests](../apps/glasses/tests/message-markdown.test.ts)

To reproduce, run the phone demo with `pnpm dev`, connect Studio, open Scout, and send a message. The demo reply exercises bold, italics, and a link. `pnpm test` checks the corresponding G2 transcript and its two-line inbox preview.

## Glasses footer and brightness

Static analysis of the supplied G2 2.4.1.4 image (SHA-256 prefix `1706cf2fecf787a1`) used Rizin and Capstone. The Terminal row renderer reads a row type at `0x604c1e`, then selects `#333333` for types 3 and 4 and `#FFFFFF` for other types at `0x604d46` and `0x604d4c`. It applies the color through an LVGL text-style setter at `0x441a2e`. The record types alone leave the speaker mapping uncertain. [LVGL 9.3 text properties](https://github.com/lvgl/lvgl/blob/v9.3.0/src/misc/lv_style.h)

Grok Bot uses SDK brightness `4` for bot replies and names and `2` for prompts and inbox previews. The account row under the cursor uses level `4`. The other account rows use level `2`, and `*` marks the active account. Two text containers share the same row positions. Blank lines preserve alignment as each container receives only its own text. The HUD uses seven text containers, and a blank container receives gestures so page updates can stay in place. [HUD renderer](../apps/glasses/src/hud.ts) · [Glasses container limits](https://github.com/even-realities/everything-evenhub/blob/main/plugins/everything-evenhub/skills/glasses-ui/SKILL.md#container-rules)

Text containers start at their left edge. The footer measures each hint with Pretext and adds leading spaces to approximate a shared right edge within one space width. The measured space has an advance of 5 px. The HUD updates the hint text in place when its length changes. [Width and wrapping](../apps/glasses/src/hud-text.ts) · [HUD tests](../apps/glasses/tests/hud.test.ts)

## Verification checklist

| Check | Evidence it provides |
| --- | --- |
| `pnpm test` | Header contracts, auth errors, stream framing and cancellation paths, account isolation, idempotent message retry, and HUD state with fixtures. |
| `pnpm build` and the README packing commands | Type correctness and a valid EHPK for the selected gateway origin. |
| Live SDK speech diagnostic | One synthetic clip traversed the upstream streaming pair and returned the expected final text. |
| EvenHub simulator | Held audio reached a mock upstream during the hold. Release sent exactly one finalized message through the app and gateway. |
| Gateway rollout and WebKit preflight | The production routes load and enforce authentication. The WebView can read their responses across origins. |
| Physical phone and glasses | Install the EHPK, use a signed-in Cursor account, hold to speak, and release. A single message and bot reply in that chat are the remaining direct evidence for the installed G2 flow. |

When adding an integration change, record the observed behavior, the code decision, and the verification layer that supports it. Link to the relevant test or commit, and record any live or device check still pending.
