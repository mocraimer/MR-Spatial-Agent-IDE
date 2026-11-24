# ADR: Groups are resized by grabbing corner arc handles

## Status
Accepted; supersedes [20261124-groups-are-resized-by-their-edges]

## Area
Spatial view

## Context
The edge-strip affordance (7 % of panel width on all four edges at 22 % opacity) worked
mechanically but had two drawbacks the owner called out in use: the strips are visually
heavy — they frame every panel continuously — and the interaction zone spans the full edge
length, making it easy to trigger accidentally when reaching past the edge of a panel. The
owner asked for "a small curve on each corner that we can grab" instead, and noted that the
view now also supports direct hand interaction, so the grab zone should be easy to reach
with a fingertip approaching at an angle.

## Decision
Each resizable panel draws four quadrant arc handles — one at each corner — in place of
full-width edge strips. The arc is a quarter circle of radius 12 % of the smaller canvas
dimension, stroked (not filled) at 20 % opacity at rest, 50 % on hover, and 90 % while
a drag is active. The grab zone is the same 12 % square at each corner (CORNER_FRAC = 0.12).

The resize mechanic is unchanged: grabbing any corner and dragging away from the head scales
the group about its own centre at constant distance (ASM-13). All arc radii stay fixed; widths
and intra-group angular and vertical offsets scale by k so that the group's angular size
actually grows. Scale bounds are 0.6×–1.8×, persisted in localStorage with az/dy, and
Recenter resets the scale to 1.0.

Buttons always win: a press in the corner zone starts a resize only when
`events.target(hit)` returns null — no button or region target is under the pointer.

## Alternatives Considered
- **Keep edge strips**: The strips are discoverable but visually heavy and span full edges,
  making accidental triggers more likely. The owner explicitly asked to replace them.
- **Invisible corner zones (no visual affordance)**: Zero visual weight, but the interaction
  would be entirely undiscoverable. The owner needs to find resize without being told.
- **Filled square corners**: Heavier than stroked arcs and would obscure content near the
  corners. Stroked arcs make the grab curve clear while leaving text readable.

## Consequences

### Positive
- Smaller grab area reduces accidental resize triggers
- Arc handles curve inward from each corner — directly suggests the pinch/grab gesture
  natural to both controllers and tracked hands
- Rest opacity is subtle; panels no longer appear framed by resize affordances
- 12 % corner zone is wider than the previous 7 % edge strip, giving a larger target
  area for each of the four discrete handles

### Negative
- Four corners must each be grabbed individually; the previous full-edge strip was
  reachable anywhere along an edge
- Corner arcs at 20 % opacity may be less immediately legible than 7 % strips at 22 %
  on small controls panels; the first hover brightens them substantially

## Source
- Owner feedback during the session on 2026-11-24: "it should be just a small curve on
  each corner that we can grab"
- Session: https://claude.ai/code/session_01Hr3SWq1ThZ3L5m8R3Qguaj
