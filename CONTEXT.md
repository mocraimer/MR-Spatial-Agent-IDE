# Spatial Agent Workspace

A personal Quest VR/MR workspace for directing real agents and reviewing their work across projects.

## Language

- **Space:** an entered place with its own logical conversation. Overview, project and child spaces follow the same ownership rule.
- **Task window:** one task agent's conversation, tool views and results; changing apps does not change its agent. In the spatial view, a task window is one session's window, agent or shell.
- **Receiver:** the current space's conversation or a deliberately selected task conversation. A spoken turn retains the receiver captured at onset.
- **Environment:** the isolated browser/workspace/desktop a task actually operates; a visible window is not the isolation boundary.
- **Execution segment:** a bounded coordinator-admitted agent attempt or turn; it is not the lifetime of the logical conversation.
- **Inbox:** owner requests across all projects, with direct destination links and a separate return to origin.
- **Coordinator:** agent-system, authoritative for execution permissions, capacity, attempts and evidence. Product state links to those records instead of replacing them.
- **Session:** in the spatial view, one Herdr pane: an agent or a shell. Herdr owns it; the view shows it as a tile or in front.
- **Shelf:** the spatial view's arrangement of the owner's Herdr sessions: one session large in front (the receiver), every other session a small numbered tile with a state light, grouped by project to the left and right.
- **Waiting:** a session Herdr reports as `blocked`, an agent asking a question or awaiting approval. "Next waiting" brings the next one to the front and "back" returns; the spatial view has no Inbox panel.
- **Helper:** a small, fast agent that is itself a Herdr session; spoken orders starting with "helper" start, rename and close sessions. A close happens only after the owner's yes.
