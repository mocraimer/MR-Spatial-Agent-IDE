# ADR: Tabs opened by the view carry descriptive labels

## Status
Accepted

## Area
Spatial view

## Context
Every `tab.create` call in `view/bridge` (agents.ts, level-tool.ts, mirrors.ts) now passes a `label` parameter. Before this change, the label was absent; the pane was renamed after creation, but the tab's own label in Herdr's tab bar remained blank. A blank tab label gives the owner and any agent working with the workspace no immediate hint of what lives in the tab.

The same session name that `pane.rename` applies to the pane's label (and that the view already shows in the shelf) is now also set on the tab at creation time, so both levels carry the name before anything runs.

## Decision
- **Seat tabs** (`agents.ts`): `tab.create` passes `label: SEAT_LABEL[role]` — `'helper'` or `'project agent'`.
- **Mirror tabs** (`mirrors.ts`): `tab.create` passes `label: labelFor(window.title)` — `'window: <title>'` (truncated).
- **Level-tool start tabs** (`level-tool.ts`): `tab.create` passes `label: name || kind` — the caller's chosen name, or the agent kind when none was given (e.g. `'claude'`, `'shell'`).
- **Level-tool view tabs** (`level-tool.ts`): `label` is computed before `tab.create` (not after) and passed to both the tab and the subsequent `pane.rename`. Labels follow the existing convention: `'changes'`, `'diff'`, `'pr N'`, `'view filename'`, `'view mdfile'`.
- **Agent instructions** (helper and project agent `CLAUDE.md`): both are told to pass `--label "<name>"` on `herdr tab create` calls so that any tab they open themselves also carries a name.

The convention is: ASM-14 — a tab's label is the same name the pane will carry.

## Alternatives Considered
- **Leave the tab label blank and rely on pane.rename only**: the shelf already shows pane labels, so the view's own UI is unaffected — but Herdr's native tab bar stays unlabelled, which matters when the owner navigates Herdr directly.
- **Set the label only after the pane is known** (never on tab.create): possible, but tab.create already fires before pane.rename; passing the label at creation costs nothing extra.

## Consequences

### Positive
- Herdr's tab bar names each tab the same way the view's shelf does.
- Agents that open their own tabs are instructed to follow the same rule.
- A static test verifies every `tab.create` in `view/bridge` passes a label.

### Negative
- If the pane is later renamed to something different, the tab label and pane label diverge; the view does not update the tab label after creation.

## Source
- Session: /manifest-dev:auto run (2026-11-24)
- Related: ASM-14 (tab label = pane name)
