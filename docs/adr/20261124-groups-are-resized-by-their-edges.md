# ADR: Groups are resized by grabbing any edge

## Status
Superseded by [20261124-groups-are-resized-by-corner-handles]

## Area
Spatial view

## Context
The owner tested moving the two panel groups (Screens and Controls) in the headset
and found that it worked well, but noted that resizing was also needed. Three
approaches were on the table: per-group +/− buttons on the grab bar, a two-hand
pinch gesture, and grabbing any edge of a panel to drag the whole group.

## Decision
Grabbing any edge of a panel in a group drags the whole group uniformly about the
group's own centre at constant distance. All arc radii are kept fixed; panel widths
scale by k; each surface's vertical offset from the group's centre height and its
angular offset from the group's centre angle both scale by k, so that the group's
angular size (what the owner sees) actually grows and panels stay evenly spaced.
Canvas pixel resolutions are unchanged so text stays crisp; only world-space sizes
and angular separations scale. The bounds are
0.6×–1.8×. The scale is kept in localStorage alongside az/dy for each group, and
Recenter resets it to 1.0. While a scale drag is active, the edge affordance fills
to 90 % opacity; at rest it draws at 22 % opacity (matching the 7 % grab zone
width) so the owner can discover the interaction without being told.

## Alternatives Considered
- **Per-group +/− buttons on the grab bar**: Discoverable and familiar, but coarse —
  each press would need to jump by a noticeable increment to feel useful, which makes
  fine-grained positioning hard. Requires a UI element that takes up space on the bar.
- **Two-hand pinch gesture**: Natural for phone users, but difficult with a controller
  (requires both input sources simultaneously) and awkward for the owner who works
  alone and often holds a controller in only one hand while the other rests. WebXR
  hand-tracking pinch detection is also less reliable than a ray-cast grab.

## Consequences

### Positive
- One direct-manipulation gesture — no mode switch, no increments
- The same edge-grab mechanic works in both controller and hand-tracking modes
- Scale stored with place, so the layout survives a restart without resetting
- Scaling about the group's own centre keeps panels evenly spaced and the group visually centred

### Negative
- The 7 % grab zone slightly reduces the usable inner area of each panel
- An accidental edge grab can resize when the owner intended only to look at the edge
  region; Recenter recovers immediately

## Source
- Retroactive — decision emerged from owner feedback during the Deliverable 9 session on 2026-11-24
- Session: https://claude.ai/code/session_01Hr3SWq1ThZ3L5m8R3Qguaj
