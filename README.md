# Bot Terminal for Even G2

Read and message Grok Bots on Even Realities G2. Bot Terminal runs in the Even app on your phone. A stateless Hono gateway handles the browser-to-provider connection, so your computer can be off.

## Deploy and pack

Requires Node.js 24, pnpm 12, and Even App 2.2.10 or later.

### Deploys.app

The [gateway workflow](.github/workflows/gateway.yml) publishes `ghcr.io/rayriffy/grokbot-gateway` and deploys the tested image digest as `grokbot-gateway` in `gke.cluster-rcf2`. It runs on pushes to `main` and can also be run manually.

Set `DEPLOYS_AUTH_USER` and `DEPLOYS_AUTH_PASS` as repository secrets. Deployment defaults to the `rayriffy` project. Set the repository variable `DEPLOYS_PROJECT` to target a different project. For a private GHCR package, set `DEPLOYS_PULL_SECRET` to the Deploys.app pull secret name with read access to the image. The workflow summary includes the HTTPS origin when Deploys.app returns one.

### Other hosts and packaging

1. Run `pnpm install --frozen-lockfile`.
2. For a container host, build the [Dockerfile](Dockerfile) and expose port 3000 over HTTPS. Cloudflare Workers can deploy with `pnpm dlx wrangler deploy --config gateway/wrangler.toml`. Bun can serve the same export with `pnpm gateway`. Other hosts can mount the [gateway Fetch handler](gateway/index.ts) using their [Hono adapter](https://hono.dev/docs/getting-started/basic).
3. Check `https://YOUR-GATEWAY/ping` returns `pong`.
4. Run `VITE_GATEWAY_ORIGIN=https://YOUR-GATEWAY pnpm pack:live`. The packer adds this exact origin to the EvenHub network whitelist and writes `artifacts/bot-terminal.ehpk`.
5. Upload the package in the EvenHub portal and install it through the Even app. Repack if the gateway origin changes.

The gateway takes no credential environment variables and uses no database, cookies, or credential logging. The phone generates a one-time sign-in verifier and stores each account's keys in EvenHub app-scoped local storage. The gateway uses short-lived Cursor tokens for key creation and Grok Bot calls within individual requests. It forwards credentials only to Cursor or xAI. Run it on a trusted host with request-header and body capture disabled.

## Connect and use

- Open **Bot Terminal** in the Even app and choose **Sign in with Cursor**, then **Continue to Cursor**. If the Even app keeps the link in its WebView, use **Copy sign-in link** and paste it into the phone’s browser. Finish the provider sign-in with the account that owns your bots, then return to the phone dashboard. The Cursor SDK flow creates a named API key that expires after 90 days. **Use an existing API key** is available for accounts with manually provisioned keys.
- The inbox loads existing bots and their conversations when an account connects. The phone offers exact-name linking if discovery cannot resolve a conversation. That fallback can create a bot for an unfamiliar name and requires confirmation.
- On G2, swipe to highlight a bot and tap to open it. The inbox shows up to two lines of the latest available message. In a conversation, swipe to read older pages. New replies keep your selected page in place. Tap to jump to the latest page.
- Hold to speak and release to transcribe and send. A capture is capped at 30 seconds. The phone dashboard also supports typed messages.
- Speech uses the Grok Bot account by default. If the account cannot use this endpoint, add a separate xAI API key under **Accounts → Speech provider** to use xAI Speech to Text.
- Open the G2 contextual menu and choose **Switch account**. Swipe to choose an account and tap to select it. Double tap to return to the inbox, then double tap again to open the system exit prompt.
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

Live SDK sign-in, bot discovery, and transcript reading were verified. The direct audio RPC returned an authorization error for the tested account. Simulator tests exercise transcription and message submission with a mocked provider. Physical glasses verification requires a deployed HTTPS gateway.

## References

- [Everything EvenHub](https://github.com/even-realities/everything-evenhub)
- [EvenHub networking](https://hub.evenrealities.com/docs/build/networking)
- [EvenHub contextual menu](https://hub.evenrealities.com/docs/build/contextual-menu)
- [Cursor SDK browser authentication](https://cursor.com/docs/sdk/typescript#cursorauth)
- [xAI speech to text](https://docs.x.ai/developers/model-capabilities/audio/speech-to-text)
