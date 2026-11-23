---
summary: How to regenerate the EvenHub listing screenshots with the current glasses UI.
read_when:
  - Refreshing the listing images after a HUD change.
  - Adding a glasses screen or changing the sample conversations.
---

# Listing screenshots

From the repository root, run `pnpm install --frozen-lockfile`, then run:

```sh
pnpm capture:listing
```

Use a desktop session that can run EvenHub Simulator. The command starts its own simulator and loopback server, then closes them when the capture finishes or you press Ctrl+C. Allow about a minute for the full set. The recording timeout alone takes 30 seconds.

The command prints the path to a new versioned, timestamped directory under `artifacts/`. Open `index.html` to see the suggested listing order and all 25 states. Upload the original 576×288 RGBA images from `png/`. The `frames.json` file records each capture’s state and SHA-256 hash. To choose a different directory, use `pnpm capture:listing --output path/to/new-folder`. Use a fresh folder for each run.

## Capture source

The fixture drives the current app’s session, Markdown and HUD code with fictional accounts and local replies. It covers first launch, inbox, conversation history, group chat, the voice flow, account switching, empty and error states, and the context menu. The simulator’s framebuffer API supplies the PNGs. In the original listing capture, its output for the same frame matched the camera-button export byte for byte. [Simulator screenshot API](https://www.npmjs.com/package/@evenrealities/evenhub-simulator) · [Scenario order](../scripts/listing/scenes.json) · [Sample chats](../scripts/listing/fixture.ts)

If a HUD change makes two scenes look identical, the command reports where it stopped. Check the scene transitions and keep the distinct states you want in the full set. The simulator clears its framebuffer on exit, so the gallery ends with the context menu.
