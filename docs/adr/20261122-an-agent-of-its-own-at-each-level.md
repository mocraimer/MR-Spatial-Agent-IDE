# ADR: Each level has an agent of its own, as a real Herdr session

## Status
Accepted; amended by 20261122-pc-windows-mirrored-into-a-project: on the owner's order a project agent also opens a page or window on the PC and mirrors it into its project

## Area
Spatial view

## Context
The October plan gave every place its own agent: one for the overview, one for each project, and the task sessions themselves. The owner's words then: "if we are focused on a certain window it should be to the agent running in that window if not should be the agent in that space". The first view has no such agents. Every session is a task, and the helper takes spoken orders that start with its name. On 2026-11-22 the owner asked to talk to an agent at every level, as planned, and said of the project's agent: "Own real session and it knows of the other sessions in the project".

## Decision
Each project has a project agent: a real Herdr session in that project's workspace. It starts the first time the owner goes into the project, with no prompt sent, and it is in front whenever the owner goes in. It knows of the project's other sessions by reading them through Herdr. It answers questions about the project, and on the owner's order it starts task sessions and sends prompts to sessions in its project. It never acts unasked. Closing a session still needs the owner's yes.

The helper is the overview agent. At the overview it is in front and hears the owner, and "helper" followed by an order still reaches it from inside any project. It knows all projects and their sessions.

The rule for who hears the owner does not change: the session in front is the receiver. A level's agent is simply the session in front when no task session is selected.

## Alternatives Considered
- **One helper for every level, told where the owner is**: no new sessions — but one small agent with one memory for all projects is not an agent of the project's own.
- **No project agent**: nothing to build — but then a project only changes what is seen, and nobody answers for the project as a whole.
- **A project agent that only tells**: the least reach — but the October ruling was delegation on request: the agent starts and prompts task sessions when asked.
- **A project agent that runs the project on its own**: fewer interruptions — but sessions would get prompts the owner did not give.
- **A separate overview agent on a larger model**: deeper answers across projects — but two top agents to keep apart, and the helper already holds the cross-project job.
- **An empty seat that starts at the owner's first words**: nothing starts on going in — but the first answer waits for the start, and until then the window in front is a plain shell that spoken words and the desk keyboard would type into.
- **Call the project agent by a word, and start it then**: nothing starts until asked — but a plain sentence after going in goes to a task.

## Consequences

### Positive
- A level's agent is a window like any other, so the owner reads what it did.
- No new agent runtime: the agents are sessions of the tool the owner already uses, started through Herdr as the helper is.

### Negative
- Each project the owner goes into gets one more idle agent session and one more tab in its Herdr workspace.
- A level agent has to be found again by its pane. On a test Herdr an agent's name was gone after a restart, while pane ids and pane labels came back.
- Starting an agent takes time, and spoken orders are handled one after another, so a start would hold up the next utterance unless it runs beside that queue.
- A project agent's reach beyond the powers above is not decided here. The helper's wider reach (20261121-helper-closes-only-on-the-owners-yes) is not carried over to project agents by this record.

## Source
- Session: figure-out on 2026-11-22
- Related: 20261122-levels-ride-on-herdr-workspaces, 20261121-helper-closes-only-on-the-owners-yes
