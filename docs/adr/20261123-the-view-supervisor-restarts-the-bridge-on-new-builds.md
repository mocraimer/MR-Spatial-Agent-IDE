# ADR: `npm run view` runs a supervisor that restarts the bridge when a new build lands

## Status
Accepted

## Area
Spatial view

## Context
During development, `npm run build` replaces `build/view/bridge/main.js`. The owner has to interrupt `npm run view`, rebuild, and restart manually every time. The bridge is stateless enough that restarting it is safe: pages reconnect via SSE and the bridge sends its full state on each connect. A restart detector on the page side (the `instance` UUID event) allows showing "The view restarted." so the owner knows the new build is live.

## Decision
`npm run view` now runs `build/view/bridge/supervise.js` instead of `main.js`. The supervisor watches `build/` recursively for `.js` file changes. When a change settles (no new change for 1 s), it kills the current bridge via SIGTERM and starts a new one. The new child gets `SPATIAL_RESTARTED=1` in its environment. A crash-loop guard: a child that exits within 10 s of starting is treated as a bad build; the supervisor logs one line and waits for the next build change rather than looping. The page detects a bridge restart by comparing the `instance` UUID it receives on each SSE connect; when the UUID changes, it shows "The view restarted." and stops any playing voice phrase.

## Alternatives Considered
- **Watch a build-complete sentinel file**: a single controlled signal — but tsc does not write one; detecting it would require a wrapper script.
- **Have tsc call a reload hook via `--listEmittedFiles` output**: cleaner than watching files — but adds a wrapper and the hook would have to signal the supervisor through a socket or file.
- **Use `nodemon` or a similar tool**: off-the-shelf solution — but adds a dependency and the crash-loop guard and restart-notice behaviour are specific to this project.
- **Restart immediately on each file change**: simpler — but tsc writes many files; restarting mid-write would launch a half-built bridge.

## Consequences

### Positive
- New builds are live in the headset within about 2 s of `tsc` finishing, with no manual restart.
- The page shows "The view restarted." so the owner knows the new code is running.
- A bad build (bridge crashes immediately) does not loop; the owner sees one log line and can fix it.

### Negative
- The supervisor adds a small process overhead on the owner's machine while the view runs.
- The 1-s settle delay means a new build is not live for at least 1 s after tsc finishes.
- If the supervisor itself crashes, the view goes down and must be restarted manually.

## Source
- Session: /manifest-dev:auto run (2026-11-23)
- Related: 20261121-thin-webxr-view-over-herdr
