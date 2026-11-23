# ADR: Levels ride on Herdr workspaces: an overview and one space per project

## Status
Accepted; narrowed by 20261123-typing-from-the-headset: the headset keyboard and physical keys paired to the headset also type into the session in front, via the page's type-text bridge action; Herdr still owns focus for the desk keyboard

## Area
Spatial view

## Context
The first view put every session of every project on one shelf. The owner wore it on 2026-11-22 with their real sessions and found it working, then asked for what the October plan had and the shelf lacks: separate projects, and jumping between them. With seven Herdr workspaces the shelf's fourth column of tiles sits behind the owner's left shoulder, so one shelf for everything also stops fitting. Herdr already has the structure: a session is a pane in a workspace. A probe on a test Herdr (0.9.3, protocol 22) showed that Herdr reports the focused workspace, and that focusing a workspace brings back the pane last focused there. The owner's standing instruction is KISS.

## Decision
A project is a Herdr workspace. The overview is the helper's workspace. Where the owner is, is the workspace of Herdr's focused pane; the view keeps no level of its own, so Herdr stays the one owner of focus and the desk keyboard still types into the session in front.

- Inside a project the shelf holds only that project's sessions, larger than the first view's tiles. Each other project is one small chip with its state lights. Selecting a chip, or saying "go to" and the project's name, goes there.
- "Go to" a project always puts that project's agent in front (see 20261122-an-agent-of-its-own-at-each-level). The owner picked this over bringing back the last session, because a plain sentence after going in then goes to the project.
- "Overview" shows every project as one node with its lights, beside the sessions that belong to no project.
- "Next waiting" lands on the waiting session itself, in whatever project it is, and "back" returns.
- There are three levels: overview, project, task session. Child spaces are left out until one project has too many sessions for one shelf.

The owner chose the inside view, the "go to" rule and the three levels. The mapping onto Herdr is this session's choice on the probe; the build may revise it on evidence.

## Alternatives Considered
- **Only this project, nothing else shown**: the cleanest view — but the owner would learn that something waits elsewhere only by asking.
- **All projects stay, the current one stands out**: no new level to learn — but there is no overview, and it does not fix the shelf running out of room.
- **The overview as a zoom level kept in the page**: no workspace needed for it — but the headset would then show something in front that Herdr has not focused, and the desk keyboard would type somewhere else.
- **"Go to" brings back the last session**: nothing starts until asked — but a plain sentence after going in goes to a task, not to the project.
- **Child spaces now, as Herdr tabs**: closer to the October plan — but none of the owner's workspaces needs one today, and new sessions are already started as tabs.

## Consequences

### Positive
- The view adds no state of its own for levels: Herdr holds where the owner is and what was last in front in each project.
- The sessions of the project in hand get the near space and can be read without bringing each one forward.

### Negative
- This narrows the first view's shelf, where every session was visible at once: sessions of other projects are now lights only.
- Going into a project changes Herdr's focused workspace, so the monitor follows the headset.
- A session that belongs to no project has to live in the helper's workspace to show at the overview.

## Source
- Session: figure-out on 2026-11-22
- Related: 20261121-thin-webxr-view-over-herdr, 20261122-an-agent-of-its-own-at-each-level
