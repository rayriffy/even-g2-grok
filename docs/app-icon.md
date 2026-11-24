---
summary: Grok Bot listing icon, its design sources, and EvenHub upload rules.
read_when:
  - Creating or updating the EvenHub listing.
  - Revising the Grok Bot pixel icon.
---

# App icon

Use [Classic Orb](../assets/grok-bot-icon.png) as the EvenHub listing icon for `com.rayriffy.grokbot`. When running `evenhub create` or `evenhub update` from `apps/glasses`, pass `--icon ../../assets/grok-bot-icon.png`. The icon is listing metadata. You can update it independently of the EHPK. [EvenHub app commands](https://hub.evenrealities.com/docs/cli/apps)

The Even OS 2.0 icon grid in the public Figma guide uses a 32×32 canvas, a nominal 2 px inset, and proportional key shapes. The EvenHub listing requires a 24×24 PNG, so the artwork uses a 12×12 grid with each cell expanded to a 2×2 block. [Even Realities design guidelines](https://www.figma.com/design/X82y5uJvqMH95jgOfmV34j/Even-Realities---Software-Design-Guidelines--Public-?node-id=10001-75932) [EvenHub icon rules](https://hub.evenrealities.com/docs/cli/apps#icon-rules)

Classic Orb keeps the supplied Grok Bot reference’s round silhouette and two angled eyes. The first actual-size preview showed an eye crowding the right edge, so it moved inward one cell to keep the silhouette connected.

The [black Classic Orb export](../assets/grok-bot-icon-black.png) uses pure black and the same 24×24 transparency mask. EvenHub’s “Export with anti-aliasing off” error also applies to opaque pixels in the wrong color. Pixel `(8, 2)` in the black export is opaque `#000000`. The [listing export](../assets/grok-bot-icon.png) uses opaque `#F4F4F4` at that coordinate and passes the color check across all 576 pixels.

The comparison set includes Classic Orb, Pebble, Chat Orb, Visor, Outline, Terminal, Orbit, Voice, and Blink. Each PNG was checked for exact dimensions, the 1 MB limit, fully transparent or opaque `#F4F4F4` pixels, and uniform 2×2 blocks. The comparison sheet shows the icons enlarged and at upload size.
