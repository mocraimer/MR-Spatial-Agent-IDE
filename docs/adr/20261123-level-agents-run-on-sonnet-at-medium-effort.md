# ADR: The helper and the project agents run on Sonnet at medium effort

## Status
Accepted

## Area
Spatial view

## Context
The helper was started as "a small, fast agent": Claude Code with Haiku (20261121-helper-closes-only-on-the-owners-yes). The project agents were started on Claude Code's own default model. After using both, the owner asked for the same setting for the overview agent and the project agents: "we want the default model to be sonnet on med effort for project and overview agents". The closing rule that record exists for does not depend on the model: it is held by a hook outside the agent. A resumed agent runs with no start arguments (20261122-level-agents-keep-their-rules-in-their-own-folder), so a model given only as an argument would be lost on a Herdr restart.

## Decision
Both kinds of level agent start with `--model sonnet --effort medium`, and each agent's folder `settings.json` carries `model` `sonnet` and `effortLevel` `medium`. The two values are constants in `view/bridge/agents.ts`. "sonnet" is Claude Code's own name for its current Sonnet; on this PC at the time of writing it resolves to Sonnet 4.6 while the owner's own sessions ran Sonnet 5.5, so pinning `claude-sonnet-5-5` is a one-constant change if the owner prefers it. Nothing else about the agents changes: the guard hook, the helper's unprompted mode and the project agent's one tool stay as those records decided. The first record's sentence "The helper is Claude Code with Haiku" no longer holds; its other decisions stand.

An agent that is already running keeps the model it started with. The view does not restart or close it; the owner closes its tab and goes to its level again.

## Alternatives Considered
- **Keep the helper on Haiku**: faster and cheaper for quick orders — but the owner asked for Sonnet for both, and a misheard order to an agent with full access is better met by the stronger model.
- **Pin `claude-sonnet-5-5`**: the newest Sonnet — but the owner said "sonnet", and the alias follows what Claude Code ships; the pin stays one constant away.
- **Opus for the overview**: deeper answers across projects — not asked for, and slower to answer a spoken order.
- **Start arguments only**: nothing in the folder to keep — but a resumed agent would run on the owner's own default model, not Sonnet.

## Consequences

### Positive
- Both agents answer from the same model and effort, and keep them after a Herdr restart.
- The model is set in one place.

### Negative
- Each answer takes longer and uses more of the owner's Claude quota than Haiku did.
- The alias can resolve to an older Sonnet than the owner's own sessions use.
- Running agents need a restart by hand to pick it up.

## Source
- Session: /manifest-dev:auto run (2026-11-23)
- Related: 20261121-helper-closes-only-on-the-owners-yes, 20261122-level-agents-keep-their-rules-in-their-own-folder
