# Bot Terminal for Even G2

Read and message Grok Bots on Even Realities G2. Bot Terminal runs in the Even app on your phone. A stateless Hono gateway handles the browser-to-provider connection, so your computer can be off.

The phone dashboard uses the [Even Toolkit](https://github.com/fabioglimb/even-toolkit) light theme and web components, bundled into the EHPK.

## Deploy and pack

Requires Node.js 24, pnpm 12, and Even App 2.2.10 or later.

### Deploys.app

The [gateway workflow](.github/workflows/gateway.yml) publishes `ghcr.io/rayriffy/grokbot-gateway` and deploys the tested image digest as `grokbot-gateway` in `gke.cluster-rcf2`. It runs on pushes to `main` and can also be run manually.

Set `DEPLOYS_AUTH_USER` and `DEPLOYS_AUTH_PASS` as repository secrets. Deployment defaults to the `rayriffy` project. For a private GHCR package, set `DEPLOYS_PULL_SECRET` to the Deploys.app pull secret name with read access to the image. CI checks the live route at `https://api.rayriffy.com/grokbot-gateway/ping`. Set `DEPLOYS_GATEWAY_BASE_URL` to check a different route and `DEPLOYS_PROJECT` to deploy into a different project.

### Other hosts and packaging

1. Run `pnpm install --frozen-lockfile`.
2. For a container host, build the [Dockerfile](Dockerfile) and expose port 3000 over HTTPS. Cloudflare Workers can deploy with `pnpm dlx wrangler deploy --config gateway/wrangler.toml`. Bun can serve the same export with `pnpm gateway`. Other hosts can mount the [gateway Fetch handler](gateway/index.ts) using their [Hono adapter](https://hono.dev/docs/getting-started/basic).
3. Check `https://YOUR-GATEWAY/ping` returns `pong`.
4. Run `VITE_GATEWAY_BASE_URL=https://api.rayriffy.com/grokbot-gateway pnpm pack:live`, substituting your own base URL if needed. The app keeps the path prefix in its requests, and the manifest whitelists the URL's origin. The output is `artifacts/bot-terminal.ehpk`.
5. Upload the package under **Builds** in the EvenHub portal. In the Even app, install it from **Me → Apps → Private builds** and launch it from the phone. Use a Beta build to launch from the glasses menu. Repack when the gateway base URL changes. See [EvenHub private testing](https://hub.evenrealities.com/docs/test/private-testing) and [EvenHub beta testing](https://hub.evenrealities.com/docs/test/beta-testing).

The gateway takes no credential environment variables and uses no database, cookies, or credential logging. The phone generates a one-time sign-in verifier and stores each account's keys in EvenHub app-scoped local storage. The gateway uses short-lived Cursor tokens for key creation and Grok Bot calls within individual requests. It forwards credentials only to Cursor or xAI. Run it on a trusted host with request-header and body capture disabled.

## Connect and use

- Open **Bot Terminal** in the Even app and choose **Sign in with Cursor**, then **Continue to Cursor**. If the Even app keeps the link in its WebView, use **Copy sign-in link** and paste it into the phone’s browser. Finish the provider sign-in with the account that owns your bots, then return to the phone dashboard. The Cursor SDK flow creates a named API key that expires after 90 days. **Use an existing API key** is available for accounts with manually provisioned keys.
- The inbox loads existing bots and group chats from the account’s roster when it connects. Group chats open and accept messages the same way as bot conversations. The phone offers exact-name linking for individual bots if discovery cannot resolve a conversation. That fallback can create a bot for an unfamiliar name and requires confirmation.
- On G2, swipe to highlight a bot and tap to open it. The inbox shows up to two lines of the latest available message and moves by one row when the highlight leaves the visible list. Conversations show a continuous transcript with a fixed status strip. Swipe line by line to read earlier messages. Swipes stop at either end of the inbox and transcript. New replies keep your place in the transcript. Tap to jump to the latest page.
- Hold to speak and release to transcribe and send. A capture is capped at 30 seconds. The phone dashboard also supports typed messages.
- Speech uses the Grok Bot account by default. If the account cannot use this endpoint, add a separate xAI API key under **Accounts → Speech provider** to use xAI Speech to Text.
- Open the G2 contextual menu and choose **Switch account**. Account rows show the name and email on one line when available. Swipe to choose an account and tap to select it. Double tap to return to the inbox, then double tap again to open the system exit prompt.
- Use **Accounts** in the phone dashboard to add or remove accounts on this phone. Revoke the key in the Cursor dashboard to disable it before expiry.

The integration uses the account's Grok Bot roster, transcript, message, and audio RPCs. The Cursor Bot Development Kit session API supports exact-name links. Use the Cursor account connected to your Grok Bots when approving sign-in. Attachment and rich-card text directs you to the official Grok Bot app.

## Verify

```sh
pnpm test
pnpm build
pnpm pack:demo
```

The demo EHPK at `artifacts/bot-terminal-demo.ehpk` has its own package ID and uses two sample accounts. It can run without network or keys. Voice capture still goes through the EvenHub mic API, with a fixed demo transcript.

For simulator QA, start `pnpm dev` and `pnpm simulate` to see first-run setup, or open `http://localhost:5173/tests/simulator.html` in the simulator to load both test accounts. The fixture uses disposable in-memory storage. The automated tests cover voice capture and WAV format, reply and preview rendering, account isolation, duplicate-send retry, and the client-to-gateway contract with mocked providers.

Live Cursor sign-in, bot discovery, transcript reading, and text delivery with a bot reply were verified through the deployed gateway. Grok Bot voice returned an authorization error with the test account's Cursor SDK key. The simulator verified that releasing the gesture sent one WAV for transcription and delivered one message with a simulated xAI response. Live xAI transcription and physical G2 behavior still need verification.

### Physical G2 check

Use the live EHPK and keep the development server and simulator off.

1. On first launch, confirm the G2 directs you to your phone. Finish sign-in and return to the Even app. The bot inbox should populate on the phone and glasses.
2. Highlight a bot with a message long enough to wrap. Check that its preview stops at two lines. Tap into the conversation and swipe through earlier messages. Confirm the status strip stays in place.
3. Hold to talk. Confirm that recording appears during the hold. Release and check that one message and its reply appear in that conversation. If Grok Bot voice reports an authorization error, add an xAI API key in **Accounts → Speech provider** and retry.
4. Add a second account on the phone, then select it from **Switch account** on the G2. Confirm the inbox switches to its bots. Exit and relaunch to check that both accounts and the selected account are restored.

## References

- [Everything EvenHub](https://github.com/even-realities/everything-evenhub)
- [EvenHub networking](https://hub.evenrealities.com/docs/build/networking)
- [EvenHub contextual menu](https://hub.evenrealities.com/docs/build/contextual-menu)
- [Cursor SDK browser authentication](https://cursor.com/docs/sdk/typescript#cursorauth)
- [xAI speech to text](https://docs.x.ai/developers/model-capabilities/audio/speech-to-text)
