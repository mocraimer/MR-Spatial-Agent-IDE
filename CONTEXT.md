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
- **Session:** in the spatial view, one Herdr pane: an agent, a shell, or a **Window mirror**. Herdr owns it; the view shows it as a tile or in front.
- **Shelf:** the spatial view's arrangement of one place's sessions: one session large in front (the receiver), the place's other sessions as numbered tiles with state lights beside it, and every other project as a chip with its lights above.
- **Waiting:** a session Herdr reports as `blocked`, an agent asking a question or awaiting approval. "Next waiting" brings the next one to the front and "back" returns; the spatial view has no Inbox panel.
- **Helper:** the overview's agent: a Herdr session of its own, Claude Code on Sonnet at medium effort like every project agent; it answers across projects, and spoken orders starting with "helper" reach it from anywhere. A close happens only after the owner's yes.
- **Project agent:** a project's own agent, a real Herdr session in that project's workspace that knows of the project's other sessions. Inside a project it is the receiver while no task session is selected.
- **Overview:** in the spatial view, the space above all projects: each project is one node with its lights, beside the sessions that belong to no project. Its agent is the helper.
- **Chip:** a project shown as one small card with its name and one state light per session; at the overview the larger form is a node.
- **Draft:** spoken words typed into a session's input and not yet sent; "go" sends them, "scratch that" clears them, and further speech is added to them.
- **Standby:** the microphone open while listening is off: speech is heard only for commands, each done after the owner's yes (those that only change the view run at once), and no spoken words are sent to a session.
- **Voice:** the PC's Windows speech, heard in the headset. It says short answers for commands, questions and failures; with **reading replies** on it also reads each finished reply of the session in front, and "read that" reads the last one once. It is never taken for the owner: the microphone hears nothing while it plays.
- **Window mirror:** a window of the PC shown in a project like one of its sessions: its picture comes from the PC, and clicks and keys go back to that window. It is not an **Environment** (the window is the owner's own, not isolated), and not the bridge's "mirror", its copy of Herdr's sessions.
