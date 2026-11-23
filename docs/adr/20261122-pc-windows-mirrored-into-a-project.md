# ADR: A PC window is mirrored into a project as a session; diffs, PRs, files and .md open in terminal viewers

## Status
Accepted

## Area
Spatial view

## Context
The owner directs agents from the headset, but sees nothing of their work except terminal text: not a page an agent serves on the PC, a diff, a pull request, a file or a `.md` document. For those, the owner takes off the headset. The view draws only the text of Herdr panes (20261121-thin-webxr-view-over-herdr). The Quest browser cannot place a web page inside an `immersive-ar` session: DOM overlays are reported unsupported or in conflict on Quest, and Meta's overlay browser opens only by a system gesture, as one centred window over a blurred session, and its state is unclear (immersive-web/webxr#1365, 2024 and 2026). A probe on a test Herdr on 2026-11-22 showed that terminal viewers already come through `pane.read` whole: lazygit, delta and bat keep their layout, 256 colours and true colour, and the page draws those colours. The front window draws 120 columns and the last 32 rows, so a larger viewer loses its top rows. The owner, choosing the shelf over the Quest browser: "seems to me like a way to mirror a window from pc into a project would be a good way to have something verstaile".

## Decision
- Any window of the PC can be shown in a project as a window mirror. It joins the project like a session: a numbered tile, in front when selected, closed only on the owner's yes. Its picture comes from the PC. Pointing clicks and scrolls in the window, and keys typed at the desk into its session go to that window.
- A window gets into a project in two ways. "mirror", or a button, lists the PC's open windows as numbered tiles, and the owner picks one by hand or number. Or an agent, on the owner's order ("show me localhost 3000"), opens the page in a browser window on the PC and mirrors it into its project. For a project agent this is one power more than 20261122-level-agents-keep-their-rules-in-their-own-folder gave it.
- Diffs, pull requests, files and `.md` documents also open as ordinary sessions running terminal viewers (lazygit, delta, bat, glow, gh), drawn as text. The front window fits a viewer's full size.

The owner chose the shelf, a mirror beside terminal viewers, and both ways in (list and agent). This session's working choices, which the build may revise on evidence: a window mirror rides on a Herdr pane (a small process in a session of the project), so Herdr still owns sessions, focus and closing; a small Windows helper lists windows, captures one through Windows Graphics Capture (the `windows-capture` library or .NET) and passes clicks and keys; OBS is not used. The first step is one mirrored window that the owner wears and judges for sharpness.

## Alternatives Considered
- **Leave mixed reality for the Quest browser**: sharp, and a full browser — but the shelf is gone while the owner looks, and pages served on the PC need a forward through the bridge.
- **A Chromium on the PC whose picture is drawn on the shelf**: clicks and keys come free through the DevTools protocol — but it shows only web pages, and the owner wanted any window.
- **The mirror for everything**: one way to see things, with VS Code or GitHub in the browser for diffs and `.md` — but text is then only as sharp as the mirror, and terminal viewers already work.
- **Skip web pages for now**: nothing to build — but the owner wanted pages beside the sessions.
- **OBS window capture streamed to a relay**: already installed — but heavy, and the owner streams with it.

## Consequences

### Positive
- Anything the PC shows can be seen in a project, beside the sessions that made it.
- An agent can put what it made in front of the owner.
- Diffs, files and `.md` stay sharp text that the desk keyboard drives.

### Negative
- A window mirror is a picture; how sharp it is in the headset is unknown until the owner wears it. The 20261121 record turned pictures down for terminal text, which stays text.
- A Windows-side helper runs beside the bridge, a second process outside WSL.
- A window must stay on the PC's desktop, not minimized, to be captured, and it shows on the monitor too.
- There are two focuses: Herdr's focused pane and the Windows window in front.
- A project agent may open pages and windows on the PC, which reaches beyond Herdr.

## Source
- Session: figure-out on 2026-11-22 (`~/.manifest-dev/logs/figure-out-log-20261122-193712-4da0.md`)
- Related: 20261121-thin-webxr-view-over-herdr (narrowed), 20261122-level-agents-keep-their-rules-in-their-own-folder (amended), 20261122-an-agent-of-its-own-at-each-level (amended)
