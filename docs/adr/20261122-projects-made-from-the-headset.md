# ADR: Projects are made from the headset, by the helper or from a list of git folders; new folders go in the home folder

## Status
Accepted

## Area
Spatial view

## Context
A project is a Herdr workspace (20261122-levels-ride-on-herdr-workspaces). Nothing in the view or in the level agents makes one: the helper's instructions start, rename and close sessions only. A Herdr workspace stores no folder (`herdr workspace get`); a project's folder is only where its sessions run, and most of the owner's sessions run in `the owner's home folder`. A project agent's new session takes the folder of another session in the project, or the home folder when there is none. The owner: "i dont see how we create a new project from scratch or into an existing folder that we dont have currently in our system". The owner's standing ruling is that every action can be spoken and hands still work.

## Decision
- "helper, new project <name>" makes `~/<name>` in the owner's home folder, sets up git in it, and makes a Herdr workspace with that label that starts in it. "helper, add the folder <name> as a project" finds the matching folders, names the one it found, and waits for the owner's yes.
- A New project button, or "new project" spoken, lists the git folders one level inside the owner's home folder, the owner's project drive and its Projects folder (the last two listed in untracked local configuration, a `project-roots` file in the view's data directory, as private values are by 20261122-public-mit-repository-for-the-spatial-workspace) that are not a project yet, most recently changed first and numbered. A spoken name filters the list. The owner picks one by hand or number, or gives a new name to make a new folder.
- The workspace starts in the folder, so the project's first shell is there and the project's sessions start there.

The owner chose both ways in, the home folder for new folders, and git folders listed newest first. This session's working choices: a new folder gets `git init`; a project the helper makes does not change what is in front (the helper's standing rule), and one picked from the list opens at once.

## Alternatives Considered
- **At the desk only, in Herdr**: nothing to build — but no work could start in a new place from the headset.
- **New folders on the owner's project drive**, beside the active repositories — the owner chose WSL's own disk (the stated trade-off: faster for git and node).
- **New folders in the project drive's Projects folder**: with the older projects — not chosen.
- **Every folder in the list, git or not**: covers folders that are not code — but the list gets long with the loose files and backups on D:.
- **By voice only, no list**: nothing to draw — but hands could not do it.

## Consequences

### Positive
- A new or existing folder becomes a project without the desk.
- A made project's sessions start in its folder.

### Negative
- Only the project's sessions hold its folder. When every session but the project agent is closed, new sessions start in the home folder again.
- A new folder on WSL's disk shows on Windows only under `\\wsl.localhost`.
- A folder without git is not in the list; the helper adds it by voice.

## Source
- Session: figure-out on 2026-11-22 (`~/.manifest-dev/logs/figure-out-log-20261122-193712-4da0.md`)
- Related: 20261122-levels-ride-on-herdr-workspaces, 20261121-helper-closes-only-on-the-owners-yes
