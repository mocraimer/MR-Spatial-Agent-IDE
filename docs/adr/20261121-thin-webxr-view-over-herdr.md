# ADR: A thin WebXR view over the owner's Herdr sessions

## Status
Accepted

## Area
Spatial view

## Context
The owner runs eight agents in six Herdr workspaces on a monitor and wants them around them in a Quest 3 at the desk. The earlier native Quest app never got past pairing, and nobody has worn any version of this product. The least-proven question is whether hours of reading terminal text in the headset work at all, so the first version had to be wearable early and small (the owner's standing instruction: KISS). Herdr 0.9.3 exposes a socket API (protocol 22) with workspaces, panes, agent states and pane reads, but no stream of pane output.

## Decision
One small bridge process in WSL reads Herdr and serves one WebXR page to the headset's browser. The page requests an `immersive-ar` session and draws every session's text itself, onto 2D canvases shown as WebGL quads; it never shows a picture of a terminal. Herdr owns focus: bringing a session forward asks Herdr to focus it, so the desk keyboard types into the session in front. The bridge keeps the one copy of the shelf, polling `session.snapshot` and `pane.read` every 33 ms, and compares text, because protocol 22 has no output stream. It sends the page the whole shelf, and each session's text when it changes. All actions, with their button labels and spoken forms, live in one registry (`view/shared/actions.ts`) that page and bridge share.

## Alternatives Considered
- **Continue the native Quest app**: more capable rendering — but unproven at pairing, far heavier to change, and it would delay the first wearable step.
- **Stream a picture of the terminal**: no text drawing to write — but terminal pixels resampled in a headset are not legible.
- **The bridge as a generic proxy for Herdr's API, with the logic in the page**: thinner bridge — but it would expose every Herdr method over the network, and the page would hold state that speech routing also needs.
- **three.js for rendering**: familiar — but a 1 MB dependency for textured quads and ray hits.
- **Herdr event subscriptions for live text**: protocol 22 has none for output; events carry only states and layout.

## Consequences

### Positive
- The owner can wear a view of their real sessions after one bridge, one page and one Windows step.
- Herdr stays the single source of sessions and focus; the view adds no session state of its own.
- Tests start their own Herdr and drive the page in Chromium with a WebXR emulator.

### Negative
- Live text is polled: a single burst of more than 500 lines between two reads skips lines in the mirror. The lines are still in Herdr, whose reads are capped at 1000 lines.
- Sharpness relies on canvas textures; compositor layers, which could be sharper on Quest, are not used yet.

## Source
- Session: /do run (2026-11-21)
- Related: 20261121-wifi-link-with-pairing.md, 20261121-local-speech-on-the-pc.md
