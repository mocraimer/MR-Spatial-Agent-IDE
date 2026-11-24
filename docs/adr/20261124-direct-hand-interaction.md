# ADR: Direct hand interaction — fingertip poke fires buttons

## Status
Accepted

## Area
Spatial view — input

## Context
The view already supports hand tracking via WebXR `hand-tracking`: the session requests
it as an optional feature, and hands are rendered as joint dots. The ray from each hand's
`targetRaySpace` already drives pointer events (aim at a button and pinch to press it).

However, when the owner's hands are close to the panels — for example, reaching toward
a button — the ray-based interaction requires them to point and pinch at a distance, which
feels indirect. The owner asked to "click a button with our fingers": a direct-touch mechanic
where the index fingertip presses a button by physically touching the surface.

## Decision
When a hand input source is active, the view monitors the index-finger-tip (joint 9) each
frame. If the tip crosses a surface's plane from outside to within POKE_ENTER_THRESHOLD
(0.015 m), and the canvas projection of the tip falls within a button's region rect
(`events.target` returns non-null), the button fires (`select-start` then `select` events)
exactly once. The button does not re-fire while the tip stays inside the threshold.
The poke ends when the tip retreats past POKE_EXIT_THRESHOLD (0.030 m); re-entering within
threshold after that fires once more. Pokes on empty canvas area (no button target) do nothing.

Buttons still win: `events.target(hit)` is checked before firing, ensuring no poke action
lands on a non-button surface area.

The existing ray-based select (aim + pinch) continues to work alongside poke. Both paths
write through the same `events.pointer` callback so all downstream logic is shared.

The grab mechanic (bar grab and corner-resize grab) continues to use the ray from
`targetRaySpace`: for tracked hands, the WebXR runtime positions this ray from the
pinch point, so pinching still grabs bars and corners.

## Alternatives Considered
- **Ray-only interaction for hands**: Already works; the owner asked for the more direct
  touch approach specifically because it is more natural when close to panels.
- **Two-hand pinch for resize**: Considered in the edge-resize ADR and ruled out; the
  owner works alone with one dominant hand, making two-hand pinch awkward.
- **Poke on any surface area (not just buttons)**: Would fire unintentionally when the
  owner's hand passes close to a panel. Restricting to button targets is safer.

## Consequences

### Positive
- Natural direct-touch interaction when the hands are close to the panels
- No controller required: all interactions (poke, grab, corner-resize) work with tracked hands
- Hysteresis band (0.015 m in, 0.030 m out) prevents chattering at threshold

### Negative
- Poke detection runs per-frame for each hand input source, iterating over all surfaces;
  cost is proportional to surface count (currently ≤ ~12 surfaces), which is negligible
- If `getJointPose` returns null for joint 9 (joint tracking lost), poke is silently
  skipped that frame — no crash but no feedback either; existing joint-dot rendering
  already handles this gracefully

## Source
- Owner feedback on 2026-11-24: "we should be able to just click a button with our fingers"
- Session: https://claude.ai/code/session_01Hr3SWq1ThZ3L5m8R3Qguaj
