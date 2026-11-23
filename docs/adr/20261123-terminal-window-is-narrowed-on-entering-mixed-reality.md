# ADR: The terminal window running Herdr is narrowed when mixed reality starts

## Status
Accepted

## Area
Spatial view

## Context
The front panel renders at 120 columns (FRONT_COLS). When the session in front is wider than 120 columns, text runs off the right edge of the panel and the view cuts it. The terminal window running Herdr on Windows starts at whatever size the owner left it; in the owner's normal desktop use it is typically wider than 120 columns. The Windows helper already speaks a JSON-line protocol to the bridge; it can be extended with window-management operations.

## Decision
When the page posts `{ inMR: true }` to `/api/mr`, the bridge calls `fitWindow` from `window-fit.ts`. That function reads the front pane's column count via `pane.layout`, finds the Windows Terminal window by its title ending with `: <workspace-label>` via the `find-window` helper operation, and proportionally scales the window width to target 120 columns. Up to three correction passes follow the first resize. The original rect is saved before any change and restored when the page posts `{ inMR: false }` after a 30-second grace period (to survive brief headset sleeps). If the window cannot be found or the terminal cannot be narrowed enough, a notice is shown instead of an error. The Python helper receives three new operations: `find-window`, `get-rect`, and `set-rect`; `maximize` restores the previous maximize state.

## Alternatives Considered
- **Resize the terminal's font instead of the window**: no Windows API changes — but the pane's column count does not change, so ANSI text is still wider than 120 columns.
- **Show a notice only, without resizing**: no window management needed — but the owner would see cut text every session.
- **Resize on every frame of text**: always current — but constant window moves would fight the owner's intentional resizing.
- **Ask the owner to set the window size manually**: zero code — but the owner asked for automatic fitting.

## Consequences

### Positive
- Text up to 120 columns is uncut in the front panel without the owner adjusting anything.
- The original window size is restored on leaving mixed reality, preserving the owner's desktop layout.

### Negative
- The bridge now adjusts a window the owner may have sized intentionally; a hand-resize during a session is tracked and used as the new restore target, but the first fit still overrides what was there.
- Finding the terminal window by title relies on the workspace label appearing in the title; a workspace without a label, or one whose label appears elsewhere in the title, will not be found.
- The wait for REFLOW_WAIT_MS (300 ms) per correction pass adds up to about 1.2 s in the worst case before the view is fully ready.

## Source
- Session: /manifest-dev:auto run (2026-11-23)
- Related: 20261122-pc-windows-mirrored-into-a-project
