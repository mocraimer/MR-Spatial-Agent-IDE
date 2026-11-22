# Personal installation and readiness

This is a build/setup runbook, not evidence that the full release is activated.
The production Manifest still requires real host/provider, supervised service,
paired-device, voice, operations activation and complete workflow evidence. No operation
below authorizes a live coordinator replacement, grant, account change, or service
restart. Use the existing owner change controls described in
[OPERATIONS.md](OPERATIONS.md) and coordinator `docs/OPERATING.md`.

## What is built, and what remains blocked

| Surface | Actual baseline | Remaining proof/prerequisite |
|---|---|---|
| Quest client | Unity 6000.6.0f1 / OpenXR 1.18.0, Android ARM64/IL2CPP; personally signed native APK built | Authorized install/boot and real Quest VR/MR/input/voice/stream/performance acceptance |
| Host/companion | TypeScript, Node >=22.13, SQLite, private HTTPS native endpoint, loopback-only owner console | Actual supervised-service setup and real owner setup/readiness journey; runtime account/login proof and owner activation remain required |
| Task tools | Offline Docker/WSL Linux: Chromium, PTY terminal, Mousepad desktop | Current broker/image readiness and actual bounded task evidence; stopped-volume 20 MiB export proof exists, not live cleanup/activation acceptance |
| Interactive agents | Coordinator integration for Pi-local and Claude-local | Configured owner-authorized real adapters/provider login/capacity and live turn/follow-up proof |
| Speech | Host-supplied bounded WAV transcription/synthesis ports | Explicit provider credentials, paid-call scope/allowance, device microphone enable/permission and real speech proof |
| Recovery | Detached SQLite/tree backup, restore inspection, migration/rollback, streamed raw-tar retention and verified cleanup orchestration tests | Existing reviewed explicit owner activation; no raw restored coordinator root may be launched |

Offline browser means local pages only, **not** unrestricted internet research.
The Docker sandbox has no network, no host bind mounts, no Docker socket and no
personal desktop attachment. Windows-only applications remain unavailable until a
separately bounded dedicated worker/app/license path is demonstrated. Do not attach
the owner's Windows desktop or describe missing external-account GUI automation as
safe. Legacy coordinator runs are not automatically labelled newly confined.

## Installed package startup

For a compiled private host package, follow [Private host setup](HOST-SETUP.md#start-an-installed-package) and run `npm start` from its version directory. The source checkout's installer builds it and installs locked runtime dependencies offline into a new private directory. It copies public runbooks but not development tools, declarations, native artifacts, credentials, or coordinator runtime/state. Startup does not authorize activation.

The source and native build commands in the following section require their respective checkouts; they are not installed-package commands.

## Build reproducibly before activation

Use the product checkout, its lockfile and the documented Node version. The declarations of the coordinator's spatial API are committed, so `npm ci` is enough to compile; [Coordinator build and type seam](COORDINATOR-BUILD.md) describes verifying them against a selected build. Then run:

```sh
npm run typecheck
npm run lint
npm run build
npm test
npm run test:ui
node scripts/operation-rehearse.mjs
```

Playwright Chromium must already be available to `test:ui`; follow its reported
missing-browser action if not. Dependency/browser installation is a separate
owner-authorized action when required. Rehearsals use labelled private fixtures,
not simulated-agent defaults in the installed app. Keep command, revision, build
identity and results with release evidence. Run coordinator checks against the
reviewed feature checkout separately; passing product tests does not establish
coordinator compatibility or authorize a shared-state cutover.

Native build/test commands and selected versions are documented in
[`native/README.md`](../native/README.md). From Windows PowerShell:

```powershell
.\scripts\native-build.ps1 -Mode EditMode
.\scripts\native-build.ps1 -Mode PlayMode
.\scripts\native-build.ps1 -Mode Build
```

The built APK and summary are under `native/artifacts/`; verify the script's
SHA-256 and actual signing identity for the selected build. Current personal
signing uses Unity's local Android debug signing key, not a store/release-signing
setup. Keep that key separately protected for compatible updates; never export it
in an operations backup. No build script installs/launches an APK, enables global
device settings, grants microphone permission or publishes a release. This document
does not supply an unreviewed ADB install/update command.

## Compose the actual host, then start it

For either a built source checkout or an installed private package, the entry is:

```sh
npm start
```

It runs `node build/host/src/main.js`. Verify that file exists first. Build it in the source checkout; the installer supplies it in the private package.
`npm start` is not an installer, a provider configurator or a supervisor. Main's host data root (`HostConfig.root`)
defaults to `~/.local/share/spatial-agent-workspace/host`;
`SPATIAL_HOST_ROOT` selects another explicit OS-private Linux root.
`SPATIAL_HOST_CONFIG` selects the private owner JSON parsed by `host/src/config.ts`.
Main holds `<hostDataRoot>/host.lock` for its lifetime, with `workspace.sqlite`,
`auth/`, `tls/` and `environments/` under that same root. Never create a different
operations lock or unlink this stable inode. Use these actual bindings for
`StateSources` in [OPERATIONS.md](OPERATIONS.md).

Read main's actual configuration/startup diagnostics and supplied owner config
before use. Explicit app-owned Pi/Claude CLI profiles keep their private config
and runtime-history directories separate. Profile directories/catalogues do not
prove login/account identity; current execution remains blocked where that proof
cannot be supplied. Harness/personal logins are never copied into the app or an
operations export. Speech keys and explicit approved per-call/daily budgets need
owner setup; a missing key, price/allowance, runtime usage identity or activation
approval remains **BLOCKED**, not a paid fallback or widened authority. Do not
invent an `install-host` command or supply fake providers/credentials to make
readiness green.

The explicit composition boundary is [`host-integration.md`](host-integration.md):
`createHostServer({store, auth, certificate, services})`. It constructs neither
authority nor paid providers. Trusted main owns app-data paths, its permanent kernel
lifetime lease, store/broker close, explicit native/console bind and service ports,
provider/pay controls, durable submission reconciliation and process supervision.
The companion remains loopback-only; no reverse proxy or public setup endpoint.
An HTTPS fingerprint must come independently from trusted setup, not the untrusted
pairing endpoint. Missing providers remain visibly blocked.

Service activation requires the owner's existing approved supervisor procedure,
actual executable/config/root identity and a demonstrated single lifetime owner.
Record the effective service command, Restart/KillMode/timeout, selected and loaded
build, private state roots and restart behavior. Shutdown must stop accepting new
requests, preserve uncertain submissions and outstanding coordinator reservations,
close server/providers/stores/broker and release descriptor leases without unlinking
lock files. Recovery must not silently replay an unknown effect. An undocumented
unit file or successful foreground start is not supervised-service acceptance;
service installation/changes remain **BLOCKED** until that owner procedure is
approved and exercised. Do not alter the existing factory service to pass setup.

## Owner setup/readiness sequence

1. Inventory the two current stores and every shared writer before any authorized
   cutover. Preserve the existing coordinator operator/grants/policies/paid limits;
   product setup does not mint authority. Register only owner-approved real projects
   and sources. Uploaded text/provenance is retained project context, not permission
   for arbitrary host filesystem access.
2. Resolve actual runtime readiness through coordinator capability checks. Pi/Claude
   coding login does not supply speech credentials. Provider/speech keys belong
   only to private host setup and bounded provider adapters, never client state,
   task tools, prompts, telemetry, backup metadata or logs. Missing login, model,
   authority, worker or capacity must explain a real owner recovery action.
3. Check actual Docker cgroup-v2 and the app-owned offline image. The source checkout's
   build entry is `node scripts/environment-build.mjs`; it is not shipped in the private host package. It builds an image and is
   **not** part of read-only setup or these operations rehearsals. Run only under
   separate owner authorization. Actual browser/PTY/Mousepad readiness must come
   from the broker, not a placeholder button or screenshot.
4. Configure speech credentials and explicit paid-call controls through the delivered
   host setup; preserve coordinator budget ownership. Unknown usage/cost stays
   blocked or held, never zero. No automatic account signup, allowance increase,
   fallback spend or broadened external connector is part of this runbook.
5. From trusted setup obtain actual HTTPS origin, certificate SHA-256 pin and current
   one-time pairing code. Enter them in the native client's Pair this Quest flow.
   Reject an unpaired/revoked client and test re-pairing with owner approval. Client
   token storage uses Android app-private Keystore-backed ciphertext; microphone
   and spoken replies begin off. No raw audio is retained by default.
6. Follow [`host-api.md`](host-api.md), [`CLIENT-API.md`](CLIENT-API.md) and native
   device acceptance docs for the actual project/space/task/Inbox/tool journeys.
   Readiness green is not proof that a task executed or that device comfort,
   stream/input identity or confinement passed.

On native, deliberate task activation selects that task's conversation; otherwise
the current space owns the receiver. Speech fixes its recipient at onset, not at
gaze/navigation. Inbox is All projects, has no agent, and jump/return retains the
original receiver. **Left-controller app Menu** opens Inbox. Keyboard **F1** provides
the same shortcut. **Right-controller A** is PTT only after explicit enable.
Those bindings still need actual device confirmation.
Hands-free/PTT need explicit owner enable and microphone permission; capture stops
on lost listening/session ownership. Stop output, Interrupt turn and Cancel task
are distinct; an uncertain cancel retains evidence/limits. Take control/resume
require current environment/epoch acknowledgment and explicit reset confirmation
when unsaved state will be lost.

## Diagnose and recover honestly

| Symptom | Valid recovery |
|---|---|
| `npm start` cannot load main/config | Build/check the real main entry and owner config; do not use a stub service |
| Missing/expired TLS pair | Preserve app-private TLS state; rotate through trusted setup and independently verify/re-pair the new pin |
| Revoked device | Keep revocation; owner may pair anew, never import historical client trust |
| Runtime/speech unavailable | Configure the actual missing credential/capability with owner/pay approval; text/PTT paths remain honest recovery options where supported |
| Lease busy | Another descriptor owns the root; stop/reconcile under approved maintenance, never remove its stable lock |
| Host/worker loss | Keep uncertain effects/claims and inspect retained product outbox/coordinator evidence; do not retry unknown work |
| Storage/update/restore failure | Retain quiet hold and original/current state; inspect detached output using OPERATIONS.md, preserving all newer work |

Environment cleanup binds the actual broker's owner-only streamed `ExportArtifact`
API and preserves all regular-file bytes plus a byte-exact private raw tar with
empty directories/modes/xattrs. The operations consumer hashes/counts every stream
and actual written file, screens raw metadata and supported compressed content,
and never extracts the tar onto the host. Unsupported compressed formats block
cleanup; screening is not proof that arbitrary content is secret-free. Existing
real-Docker 20 MiB export evidence and the new broker/fixture-engine integration
rehearsal are described in [OPERATIONS.md](OPERATIONS.md). Neither authorizes live
destruction, overwrite or coordinator activation, nor passes the full privacy,
confinement or recovery gates by itself.

A future tool/runtime must use the existing coordinator authority/admission and
capability-aware execution ports, dedicated environment identity and current input
lease/frame generation. It cannot widen parent budgets, accept owner identity from
model arguments, inherit personal credentials or bypass raw-shell/network limits.
Read the public host contracts before extending the installed release, and add
positive/negative automated tests plus the relevant real runtime/device evidence.
No unsupported app, platform or missing release gate is described here as shipped.
