# ADR: Model and effort are changed by typing Claude Code's own slash command

## Status
Accepted; amended by [20261123-model-and-effort-defaults-are-restored-after-the-command](20261123-model-and-effort-defaults-are-restored-after-the-command.md): the bridge now restores the owner's defaults after each command so only the running session is changed

## Area
Spatial view

## Context
In the headset the owner cannot type `/model` or `/effort` into the session in front, and asked for "a command that can change the effort and model on whatever is in front". A Claude Code session has no outside control for its model. A test in a real session showed that `/model sonnet` prints "Set model to Sonnet 4.6 and saved as your default for new sessions": Claude Code also writes the owner's default for new sessions. Typing text into a session is the one way the view must not use carelessly (20261122-spoken-prompts-wait-for-go): into a session that waits on a question the words are keys, and after a draft they are joined to it.

## Decision
The command is part of the shared action registry, with a spoken form and a button for each choice: "model haiku|sonnet|opus" and "effort low|medium|high|extra high|max" (with "set" and "to" optional), the buttons in the shelf's fourth row. The bridge types `/model <name>` or `/effort <level>` and Enter into the session that was in front when the speech began. It does so only for a Claude Code session that is idle or done and whose input holds no draft; otherwise it types nothing and says why. With listening off it is asked first and done only after the owner's "yes", like any command that is not view-only. The text typed is built only from the registry's names. The answer is what the session printed ("Set model to …", "Set effort level to …"); when it prints nothing within a short bound, the answer says the command was sent and did not show that it took effect. The owner accepts that `/model` also changes their default for new sessions; the session's own line, spoken, says so.

## Alternatives Considered
- **Restart the session with `--resume --model`**: no change to the owner's default — but the screen is lost, the session must be idle anyway, and the view would have to know how each session was started.
- **Type it while the session works**: the owner could switch at any time — but what `/model` does in the middle of a turn was not verified, and a refusal that says "when it is done" costs little.
- **Other agent kinds (Codex and the rest)**: wider reach — but their slash commands differ and every pane in the owner's Herdr is Claude; they are refused in words.
- **Report success as soon as the command is typed**: simpler — but a command that did nothing would be spoken as done.

## Consequences

### Positive
- Model and effort change by voice, with no new channel to a session and no new Claude Code feature.
- The owner hears what the session itself said, not the view's guess.

### Negative
- `/model` changed the owner's default for new sessions every time it was used. Amended: the bridge now restores the defaults after the command (20261123-model-and-effort-defaults-are-restored-after-the-command).
- Whether `/effort` also saves a default, and how it behaves when it shows a picker, was not tested against a real session: those answers are read from the pane. The owner's first use is the check.
- A session that is working, waits on a question or holds a draft must be cleared first.

## Source
- Session: /manifest-dev:auto run (2026-11-23)
- Related: 20261122-spoken-prompts-wait-for-go, 20261123-spoken-answers-made-on-the-pc-by-the-windows-voice
