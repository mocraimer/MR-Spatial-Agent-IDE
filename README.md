# Spatial Agent Workspace

Your Herdr sessions, agents and shells, around you in a Quest 3 in mixed reality at your desk, one project at a time and readable. Each project has an agent of its own you can ask about the project and tell to start or prompt its sessions; at the overview, above all projects, a helper agent answers across them and starts, renames and closes sessions. You act by voice, hands, controllers or keyboard.

This is one person's own tool, published as is under the MIT license. It is built for its owner's desk and headset; no support is promised, and issues and pull requests may go unanswered. Read it, fork it, change it.

## What it needs

- Windows with WSL 2, running Node 22.13 or later, [Herdr](https://github.com/herdrdev/herdr) 0.9.3 (socket protocol 22), and OpenSSL in WSL.
- A Quest 3 on the same Wi-Fi, to use the view. The checks run without one.
- Chromium for the browser tests: `npx playwright install chromium`.
- For window mirrors (optional): Python 3.12 on Windows with `py -3.12 -m pip install --user windows-capture pywin32`. For viewers (optional): `lazygit`, `delta`, `bat`, `glow` and `gh` in WSL.

## Quick start

One small bridge process on the PC (`view/bridge`) reads your Herdr sessions through Herdr's socket API and serves one WebXR page (`view/page`) to the headset over Wi-Fi, behind a pairing code and the view's own certificate. Speech becomes text on the PC with a small local model, and short spoken answers come back from Windows' own voice on the PC; nothing leaves the PC. The view shows your real sessions; Herdr stays the owner of focus, so the desk keyboard types into the session the view shows in front.

Start Herdr first, then:

```sh
npm ci
npm run build
npm run view:setup   # once: fetches the speech model (about 31 MB)
npm run view         # prints the address to open on the headset
```

Spoken prompts do not reach an agent unseen: each is typed into the session's input as a **draft**, and you say "go" to send it or "scratch that" to clear it (say "send at once" to switch the wait off). With listening off in mixed reality the microphone stands by for commands: those that only change the view run at once, and every other one is asked with "yes" before it is done. Failures are written to the terminal and to `view.log` in the data directory (`~/.local/share/spatial-agent-workspace/view`), which never holds your words or session text.

Start with the [user guide](docs/USER-GUIDE.md): the one-time Windows step for the Wi-Fi link (and how to undo it), pairing, the overview and the projects, speaking, the agents at each level, and what to do when something goes wrong. Architecture choices are recorded in [docs/adr](docs/adr/README.md).

## Checks

Type checking, lint, unit tests and browser tests:

```sh
npm run typecheck
npm run lint
npm test
npm run test:ui
```

The view's tests never touch your Herdr. Each starts a Herdr of its own (`view/bench/bench.ts`) with scripted stand-in agents, and drives the page in desktop Chromium with Meta's WebXR emulator (IWER) for the immersive parts. The speech tests use phrases synthesized on the PC; regenerate them with `node build/view/bench/make-speech.js`. The tests of the real helper and project agent spend model quota, so they run only when asked: `VIEW_HELPER_TESTS=1 npx playwright test view/tests/helper.spec.ts view/tests/project-agent.spec.ts`. `node build/view/bench/windows-run.js [screenshot-folder]` checks window mirrors on this PC end to end with the real Windows helper, using only windows it opens itself (a test window and a browser with a temporary profile). `node build/view/bench/demo.js` runs the view on a bench shaped like a real desk, and `node --expose-gc build/view/bench/soak.js [minutes]` watches its memory under sustained output.

What these checks cannot show is sharpness, comfort and your own voice in the real headset. Only wearing it shows those.

Tests that need something the machine must supply are skipped, and each says what to set. The tests that drive the real coordinator need `SPATIAL_COORDINATOR_DIST`, the `dist/` directory of an agent-system build (see [Coordinator build and type seam](docs/COORDINATOR-BUILD.md)). The two tests of the installed Pi and Claude tools need `pi` and `claude` on `PATH`, or `SPATIAL_PI_BIN` and `SPATIAL_CLAUDE_BIN`.

`node scripts/rehearse-clean-clone.mjs` clones the repository and runs the quick start, `npm run typecheck`, `npm run lint` and `npm test` on a machine state with nothing of yours: an empty home and npm cache and no coordinator checkout. It prints each step's exit code and the skipped tests and suites; it does not run `npm run test:ui`.

## The earlier host and Quest app

The guides for the earlier product were written for the owner's own setup; steps that mention the owner's signing key, records or manifests apply only to the owner. The repository also holds the earlier product: a private host (`host/`), a native Quest app (`native/`), and task environments (`environments/`). Sandboxed agents remain an opt-in path built on that code. The spatial view does not depend on any of it, except that it reuses the host's pairing and certificate code (`host/src/auth.ts`). See the [earlier Quest app guide](docs/QUEST-APP-GUIDE.md), [private host setup](docs/HOST-SETUP.md), [host integration](docs/host-integration.md) and [API](docs/host-api.md).

To build and start the earlier host from a source checkout, first read [Coordinator build and type seam](docs/COORDINATOR-BUILD.md) for the coordinator build it needs, then run `npm run build` and `npm start`. Its isolated startup rehearsal is `node scripts/host-smoke.mjs`.

## Before you push

`scripts/leak-check.mjs` stops a push that carries a private value: a private key, a token, an email address outside its allow list in a file or a commit message, or any term from a private list you keep outside the repository. Turn the hook on once in each clone:

```sh
git config core.hooksPath .githooks
git config leakcheck.privateList ~/private-terms.txt   # optional
```

The list holds one `grep` basic regular expression per line, matched ignoring case; blank lines and lines starting with `#` are skipped. Without it the check still looks for the generic shapes and says so. The check reads text files; binary files are checked by name only. `node scripts/leak-check.mjs tree` checks the tracked files, and `node scripts/leak-check.mjs range <git rev-list arguments>` checks commits. GitHub runs the generic part on every push (`.github/workflows/leak-check.yml`).

## License

MIT; see [LICENSE](LICENSE). The fonts in `view/page/fonts` keep their own licenses ([LICENSES.md](view/page/fonts/LICENSES.md)).
