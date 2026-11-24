# ADR: Shelf surfaces move as two independent groups

## Status
Accepted

## Area
Spatial view — layout

## Context
The shelf's surfaces (front session, tiles, chips, strip, talk button, button rows, draft bar) are
placed in the room relative to a recenter anchor, using fixed poses from `layout.ts`. The owner's
desk position and reading angle vary: the screens need to sit at eye height and reading distance, and
the controls need to sit at a comfortable reach angle, often lower. A single group with one recenter
was not enough; two independent groups that can each be repositioned were wanted.

The two natural groups are:
- **Screens**: the front session panel, the status strip, the tile columns, the project chips, and
  the draft bar — everything the owner reads.
- **Controls**: the Talk microphone strip, the button rows, and the draft-send bar — everything the
  owner acts on.

## Decision
Each group has an offset matrix (`screensOffset`, `controlsOffset`) stored in `main.ts`. Each
surface's pose is `multiply(groupOffset, basePose)`, where `basePose` is the natural world-space
pose (computed by `onArc`). Group offsets are **delta** transforms: `identity()` means "default
position"; the user drags to accumulate a non-identity offset. A grab bar surface (`bar:screens`,
`bar:controls`) sits below each group; grabbing it with a controller ray or mouse sends
`groupBarStart` and `groupMove` events to `main.ts`, which moves the offset by the ray's delta on
the bar's depth plane.

Offsets are encoded as `[x, y, z, yaw]` tuples and saved in `localStorage` under
`spatial-view-group-offsets`. Recenter resets both offsets to `identity()`. The controls group's
base poses use `CONTROLS_DEFAULT_Y = -0.35` and `CONTROLS_DEFAULT_DISTANCE = 0.6`, so they sit
0.35 m below and 0.6 m ahead by default without needing a non-identity offset.

The group mechanism lives entirely in `main.ts`, not in `Scene`. `Scene` gains `groupBar`,
`groupBarStart`, `groupMove` callbacks to report bar interactions, and `followBar()` to project the
ray onto the bar's depth plane, but it has no concept of a group.

## Alternatives Considered
- **A single movable group**: simpler — but the screens and controls have different optimal positions
  and the owner asked for two independent groups.
- **Arbitrary surface dragging**: maximum flexibility — but no spatial grouping, and every surface
  would need a drag handle, far more UI complexity.
- **Separate anchor nodes in Scene**: Scene would own two anchors — but that leaks layout knowledge
  into the renderer. Keeping offsets in `main.ts` keeps Scene ignorant of the shelf's structure.
- **Store offsets as full 4×4 matrices in localStorage**: complete — but matrices have floating-point
  precision issues in JSON and are harder to reason about. Storing `[x, y, z, yaw]` tuples is
  enough for a simple translation + Y-rotation offset.

## Consequences

### Positive
- Screens and controls each sit where the owner finds them most comfortable.
- Positions survive sessions (localStorage).
- Recenter resets both groups, same as before.
- Scene stays ignorant of shelf layout.

### Negative
- Two localStorage values to migrate if the encoding changes.
- The bar depth heuristic (project ray onto the z-plane at the bar's current depth) drifts when the
  owner moves a lot; it is not a physical rigid-body constraint.
