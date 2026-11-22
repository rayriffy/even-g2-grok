# Grok Bot for Even G2

Read and message Grok Bots on Even Realities G2. Grok Bot for Even G2 runs in the Even app on your phone. A stateless Hono gateway handles the browser-to-provider connection, so your computer can be off.

The phone dashboard uses the [Even Toolkit](https://github.com/fabioglimb/even-toolkit) light theme and web components, bundled into the EHPK.

See the [gateway integration guide](docs/gateway-integration.md) for endpoint and header contracts, including the iPhone capture review. See [research and troubleshooting](docs/research-and-troubleshooting.md) for the evidence, fixes, and steps to reproduce the checks.

## Deploy and pack

Requires Node.js 24, pnpm 12, and Even App 2.2.10 or later.

### Deploys.app

The [gateway workflow](.github/workflows/gateway.yml) publishes `ghcr.io/rayriffy/grokbot-gateway` and deploys the tested image digest as `grokbot-gateway` in `gke.cluster-rcf2`. It runs on pushes to `main` and can also be run manually.

Set `DEPLOYS_AUTH_USER` and `DEPLOYS_AUTH_PASS` as repository secrets. Deployment defaults to the `rayriffy` project. For a private GHCR package, set `DEPLOYS_PULL_SECRET` to the Deploys.app pull secret name with read access to the image. CI checks the live route at `https://api.rayriffy.com/grokbot-gateway/ping`. Set `DEPLOYS_GATEWAY_BASE_URL` to check a different route and `DEPLOYS_PROJECT` to deploy into a different project.

### Other hosts and packaging

1. Run `pnpm install --frozen-lockfile`.
2. For a container host, build the [Dockerfile](Dockerfile) and expose port 3000 over HTTPS. Cloudflare Workers can deploy with `pnpm dlx wrangler deploy --config gateway/wrangler.toml`. Bun can serve the same export with `pnpm gateway`. Other hosts can mount the [gateway Fetch handler](gateway/index.ts) using their [Hono adapter](https://hono.dev/docs/getting-started/basic).
3. Check `https://YOUR-GATEWAY/ping` returns `pong`.
4. Run `VITE_GATEWAY_BASE_URL=https://api.rayriffy.com/grokbot-gateway pnpm pack:live`, substituting your own base URL if needed. The app keeps the path prefix in its requests, and the manifest whitelists the URL's origin. The output is `artifacts/grok-bot.ehpk`.
5. Create the EvenHub app for `com.rayriffy.grokbot` on first upload. Install it from **Me → Apps → Private builds** and launch it from the phone. Use a Beta build to launch from the glasses menu. Repack when the gateway base URL changes. [EvenHub app creation](https://hub.evenrealities.com/docs/cli/apps) · [Private testing](https://hub.evenrealities.com/docs/test/private-testing) · [Beta testing](https://hub.evenrealities.com/docs/test/beta-testing)

For updates to the existing listing, increment `version` in `app.json` before packing. EvenHub gives each uploaded version an immutable build. [EvenHub build uploads](https://hub.evenrealities.com/docs/cli/builds#evenhub-upload)

Grok Bot adopted its current EvenHub identity in 0.1.7. When moving from Bot Terminal (`com.rayriffy.botterminal`), install the new app and sign in again. Account storage is scoped to the EvenHub app.

The gateway takes no credential environment variables and uses no database, cookies, or credential logging. The phone generates a one-time sign-in verifier and stores each account's keys in EvenHub app-scoped local storage. For streaming dictation, the phone holds a short-lived Cursor session in memory for the duration of the recording. Each gateway request forwards the credential to its provider and ends without storing it. Run the gateway on a trusted host with request-header and body capture disabled.

When hosting behind a reverse proxy, allow the transcript response to stream and stay idle for up to 50 seconds. The Bun gateway applies this limit to the transcript read.

## Connect and use

- Open **Grok Bot** in the Even app and choose **Sign in with Cursor**, then **Copy sign-in link**. If a link field appears, copy it from there. Paste the link into your phone browser and sign in with the account that owns your bots. Return to the Even app to finish connecting. The Cursor SDK flow creates a named API key that expires after 90 days. **Use an existing API key** is available for accounts with manually provisioned keys.
- The inbox loads existing bots and group chats from the account’s roster when it connects. Group chats open and accept messages the same way as bot conversations. The phone offers exact-name linking for individual bots if discovery cannot resolve a conversation. That fallback can create a bot for an unfamiliar name and requires confirmation.
- On G2, swipe to highlight a bot and tap to open it. The inbox shows up to two lines of the latest available message and moves by one row when the highlight leaves the visible list. Conversations show a continuous transcript with a fixed status strip. Swipe line by line to read earlier messages. Swipes stop at either end of the inbox and transcript. New replies keep your place in the transcript. Tap to jump to the latest page.
- Bot replies show formatted Markdown in the phone conversation. On G2 and in inbox previews, replies show plain text with link labels and readable lists.
- Hold to speak and release to send the finalized transcript. The G2 app streams audio to Grok Bot using the selected Cursor account. This requires a gateway with streaming support. A capture is capped at 30 seconds. The phone dashboard also supports typed messages.
- Open the G2 contextual menu and choose **Switch account**. Account rows show the name and email on one line when available. Swipe to choose an account and tap to select it. Double tap to return to the inbox, then double tap again to open the system exit prompt.
- Use **Accounts** in the phone dashboard to add or remove accounts on this phone. Revoke the key in the Cursor dashboard to disable it before expiry.

The integration uses the account's Grok Bot roster, transcript, message, and audio RPCs. The Cursor Bot Development Kit session API supports exact-name links. Use the Cursor account connected to your Grok Bots when approving sign-in. Attachment and rich-card text directs you to the official Grok Bot app.

## Verify

```sh
pnpm test
pnpm build
pnpm pack:demo
```

The demo EHPK at `artifacts/grok-bot-demo.ehpk` uses package ID `com.rayriffy.grokbot.demo` and two sample accounts. It can run without network or keys. Voice capture goes through the EvenHub mic API, with a fixed demo transcript.

For simulator QA, start `pnpm dev` and `pnpm simulate` to see first-run setup, or open `http://localhost:5173/tests/simulator.html` in the simulator to load both test accounts. The fixture uses disposable in-memory storage. The automated tests cover voice capture and WAV format, reply and preview rendering, account isolation, duplicate-send retry, and the client-to-gateway contract with mocked providers.

Live Cursor sign-in, bot discovery, transcript reading, and text delivery with a bot reply were verified through the deployed gateway. A live diagnostic streamed one synthetic clip through Grok Bot using a Cursor SDK sign-in and received the expected final transcript. Integration tests exercise the full hold-to-talk path through Hono with a simulated Cursor upstream. Physical G2 streaming still needs verification.

### Physical G2 check

Use the live EHPK and keep the development server and simulator off.

1. On first launch, confirm the G2 directs you to your phone. Finish sign-in and return to the Even app. The bot inbox should populate on the phone and glasses.
2. Highlight a bot with a message long enough to wrap. Check that its preview stops at two lines. Tap into the conversation and swipe through earlier messages. Confirm the status strip stays in place.
3. With a Cursor account selected, hold to talk. Confirm that recording appears during the hold. Release and check that one message and its reply appear in that conversation.
4. Add a second account on the phone, then select it from **Switch account** on the G2. Confirm the inbox switches to its bots. Exit and relaunch to check that both accounts and the selected account are restored.

## References

- [Grok Bot listing icon](docs/app-icon.md)
- [Everything EvenHub](https://github.com/even-realities/everything-evenhub)
- [EvenHub networking](https://hub.evenrealities.com/docs/build/networking)
- [EvenHub contextual menu](https://hub.evenrealities.com/docs/build/contextual-menu)
- [Cursor SDK browser authentication](https://cursor.com/docs/sdk/typescript#cursorauth)
