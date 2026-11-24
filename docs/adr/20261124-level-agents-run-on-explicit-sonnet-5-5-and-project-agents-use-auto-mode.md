# ADR: Level agents run on explicit Sonnet 5.5 and project agents use auto permission mode

## Status
Accepted

## Area
Spatial view

## Context
Two related gaps emerged after the sonnet-at-medium-effort record (20261123-level-agents-run-on-sonnet-at-medium-effort):

1. **Model alias resolves to the wrong version.** The alias `sonnet` in this Claude Code build resolves to Sonnet 4.6, not Sonnet 5.5. The earlier record noted this explicitly: "pinning `claude-sonnet-5-5` is a one-constant change if the owner prefers it." The owner asked for it.

2. **Project agents start in default (manual) permission mode.** The earlier record
   (20261122-level-agents-keep-their-rules-in-their-own-folder) stated: "everything else meets Claude Code's own permission prompt, which shows as a waiting session." Each out-of-allow-list tool call required the owner to answer. The owner found this disruptive and chose auto mode instead.

## Decision
- `LEVEL_MODEL` is changed from the alias `'sonnet'` to the full id `'claude-sonnet-5-5'`. This applies to both the `--model` start argument and the folder `settings.json`. Settings-restore logic works with any string value, so it is unaffected.
- The `Model` controls in the view type full current model ids (`/model claude-sonnet-5-5`, `/model claude-haiku-5-5`, `/model claude-opus-5-5`). Spoken forms ("model sonnet") and button labels ("Model Sonnet") are unchanged; `MODEL_IDS` maps short names to full ids.
- `claudeProjectAgent` adds `--permission-mode auto` to its start arguments and sets `defaultMode: 'auto'` in its folder settings. The helper keeps `bypassPermissions`.

## Alternatives Considered
- **Keep the alias**: no change needed — but it would silently keep running Sonnet 4.6, diverging from the owner's expectation.
- **Keep project agents in default (per-prompt) mode**: no agent change needed — but each unallowed call interrupts the owner with a permission prompt.
- **Give project agents bypassPermissions**: no prompts ever — but that removes the allow-list enforcement the owner set up. Auto mode still honours the allow list; the owner must answer only when explicitly prompted by their own code.

## Consequences

### Positive
- Level agents run on the same model version as the owner's own sessions.
- Project agents work without interrupting the owner for every file write or shell call outside the allow list.
- The model id is explicit in both start arguments and folder settings; the constant is `LEVEL_MODEL`.

### Negative
- A running agent keeps its old model and permission mode until its pane is closed and re-opened.
- Auto mode means unreviewed tool calls outside the explicit allow list succeed silently.

## Source
- Session: /manifest-dev:auto run (2026-11-24)
- Related: 20261123-level-agents-run-on-sonnet-at-medium-effort, 20261122-level-agents-keep-their-rules-in-their-own-folder
