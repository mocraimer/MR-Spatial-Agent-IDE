# ADR: The owner's default model and effort are restored after the slash command

## Status
Accepted; amends 20261123-model-and-effort-are-set-by-typing-the-slash-command: the bridge now restores the defaults so the command only changes the current session.

## Area
Spatial view

## Context
The existing ADR (20261123-model-and-effort-are-set-by-typing-the-slash-command) noted that `/model` changes the owner's default for new sessions every time it is used. The owner asked to change only the current session, not the default. Claude Code writes `model` (top-level) and `modelSettings.<id>.effortLevel` to `~/.claude/settings.json` when `/model` or `/effort` is typed; reading that file back and restoring it after the confirmation is therefore sufficient.

## Decision
Before typing `/model <name>` or `/effort <level>`, the bridge saves the current top-level `model`, `effortLevel`, and the entire `modelSettings` object from `~/.claude/settings.json` (or `CLAUDE_CONFIG_DIR/settings.json`). After the session confirms the command took effect, the bridge restores exactly those fields using an atomic write (temp file + rename). The rest of the file, including keys Claude Code added in the same write, is preserved. If the restore fails, the outcome says "The default for new sessions may have changed" so the owner knows to check manually. The file path is configurable (`BridgeOptions.claudeSettingsPath`, `null` to skip) and tests use a temp file, so the owner's real settings are never touched during tests.

## Alternatives Considered
- **Leave the default changed**: no extra code — but the owner wanted session-only changes.
- **Write only the model/effort fields back**: simpler read path — but Claude Code's modelSettings block holds per-model effort defaults for all models; patching only the matched model's entry risks corrupting others.
- **Use a Claude Code flag or API to scope to the session**: cleaner separation — but no such flag exists yet.
- **Snapshot the entire settings file**: simpler restore code — but other concurrent writes (another Claude Code instance opening) would be lost; patching only the tracked keys is safer.

## Consequences

### Positive
- `/model` and `/effort` change only the running session; the owner's defaults for new sessions are unchanged.
- Tests can point the bridge at a temp settings file and verify the restore without touching `~/.claude/settings.json`.

### Negative
- There is a small window between the command typing and the restore during which a new Claude Code session started would see the changed default.
- If the bridge crashes after the command but before the restore, the default is changed and must be fixed manually.

## Source
- Session: /manifest-dev:auto run (2026-11-23)
- Related: 20261123-model-and-effort-are-set-by-typing-the-slash-command
