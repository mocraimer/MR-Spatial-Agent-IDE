# ADR: The helper runs without permission prompts; closing is held by a hook and the owner's yes

## Status
Accepted

## Area
Spatial view

## Context
The owner wants to start, close and rename sessions by voice through a small, fast agent, and picked "General quick tasks" for it: a normal agent with shell access on the PC. Spoken orders must act at once, without a permission prompt for each command. The owner also picked "Confirm close only": the helper names the session and nothing closes without the owner's yes, even if the order says not to ask. A model can ignore its instructions, so an instruction alone does not hold that line.

## Decision
The helper is Claude Code with Haiku, started as its own Herdr session in the owner's home folder, with `--permission-mode bypassPermissions`. A PreToolUse hook (`view/bridge/guard.ts`) runs on every tool call. It refuses anything that would close a session by any route other than the close tool: Herdr close commands, socket access, `kill`, and shell exits sent to a pane. It also refuses any call it cannot read. The close tool (`view/bridge/close-tool.ts`) asks the bridge over a socket file only the owner's user can open. The bridge names the session to the owner and closes it only on their yes; a no, or no answer within two minutes, leaves it open.

## Alternatives Considered
- **Claude Code's permission rules (deny lists) instead of a hook**: built in — but they match command prefixes, so a close wrapped in another command, or written into a script, passes.
- **Ask permission for every command**: the strongest gate — but it defeats a spoken quick order, the reason the helper exists.
- **No helper; the bridge parses "close X" itself**: no model involved — but the owner asked for an agent that also does other quick tasks in plain words.

## Consequences

### Positive
- A close cannot happen without the owner's yes, whatever the order or the model says.
- Starts, renames and quick tasks run at once.

### Negative
- Everything other than closing runs with the owner's full access, without asking. The owner accepted this when picking the helper's reach; a misheard order can still act.
- The guard matches patterns: a helper set on evading it (for example, a program it writes and then runs under another name) is not stopped by this hook alone.

## Source
- Session: /do run (2026-11-21)
- Related: 20261121-thin-webxr-view-over-herdr.md
