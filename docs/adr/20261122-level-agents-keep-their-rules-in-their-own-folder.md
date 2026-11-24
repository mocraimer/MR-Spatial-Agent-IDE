# ADR: Level agents keep their rules in a folder of their own, and a project agent acts through one tool

## Status
Accepted; amended by 20261122-pc-windows-mirrored-into-a-project: on the owner's order a project agent also opens a page or window on the PC and mirrors it into its project; amended by 20261124-level-agents-run-on-explicit-sonnet-5-5-and-project-agents-use-auto-mode: project agents start in auto permission mode, not the per-prompt default mode

## Area
Spatial view

## Context
Each level has an agent of its own (20261122-an-agent-of-its-own-at-each-level): the helper at the overview and one agent per project. Two things had to hold for them that the first helper did not need. First, closing a session needs the owner's yes, enforced by a hook outside the agent; the first helper got its hook and its instructions from start arguments. On a test Herdr, stopping and starting Herdr brought back each pane and its label but not the agent in it, and the owner's own Herdr resumes agents as `claude --resume <id>`, without the arguments they were started with. A rule carried only by start arguments is lost on a restart. Second, the owner ruled that a project agent reads the project, and starts and prompts sessions in it on order, and nothing else unasked; the helper runs with the owner's full access.

## Decision
- Each kind of level agent works in a folder of its own under the view's data directory (`agents/helper`, `agents/project-agent`). The folder holds Claude Code's project settings (`.claude/settings.json`: model, permissions, the guard hook) and the instructions (`CLAUDE.md`). Claude Code reads both from the folder it runs in, so an agent that Herdr resumes keeps its rules.
- A level agent's pane is its seat, found by its pane label ("helper" in the workspace labelled "helper"; "project agent" in a project), never by agent name. An empty seat gets its agent started again in it.
- A project agent acts on sessions only through one tool (`view/bridge/level-tool.ts`). The tool takes the project from the pane's own workspace and refuses any session outside it; it starts sessions without changing focus, refuses to end a shell by a prompt, and sends closes to the bridge, which waits for the owner's yes. The agent's settings allow reading and that tool; everything else meets Claude Code's own permission prompt, which shows as a waiting session the owner answers.
- The close tool finds the bridge at its default place when a resumed pane has lost the variable that named it.

## Alternatives Considered
- **Keep rules in start arguments, as the first helper did**: no folder to keep — but a resumed agent runs without the hook, and closing would no longer wait for the owner.
- **Work in the project's own directory**: the agent sees the project's files — but each project would need the settings written into the owner's repositories, and most of the owner's sessions run from the home folder anyway.
- **Give a project agent the helper's reach**: no permission prompts — but the owner named only reading, starting and prompting for it.
- **Let the project agent use the `herdr` command line directly, held by patterns in the hook**: no tool to write — but the hook matches command text, so it cannot tell this project's sessions from another's.

## Consequences

### Positive
- The close rule and each agent's reach survive a Herdr restart.
- The view never sends a level agent anything on its own; what it receives is what the owner said or typed.

### Negative
- The first time an agent starts in its folder, Claude Code may ask whether to trust the folder; the owner answers once in its window.
- All project agents share one folder, so a file a project agent writes there is seen by the others.
- Renaming a seat's tab makes the view start a new agent beside it.

## Source
- Session: /do run (2026-11-22)
- Related: 20261122-an-agent-of-its-own-at-each-level, 20261121-helper-closes-only-on-the-owners-yes
