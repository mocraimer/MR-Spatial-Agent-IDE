# Offline task environment

This baseline runs **real Linux Chromium, xterm with a PTY shell, and Mousepad/GTK** in a dedicated Docker container for each logical task. Each application has its own 1280×800 Xvfb display. Frames are actual PNG screenshots; input reaches those displays. The terminal API returns the shell's real output, not agent narration. Local files and HTML work. External browsing/research and Windows applications are **unavailable**.

## Build and verify

Prerequisites: Linux Docker (tested Engine 29.3.0), cgroup-v2, Node 22+, host Python 3 (stdlib archive validation), an OS-private Linux data filesystem, and enough resources for the app image and task containers. The build needs Debian package registry access; workloads do not get network access. No model/provider calls occur here.

```sh
node scripts/environment-build.mjs
npm run build
node --test build/host/tests/environment-broker.test.js
node scripts/environment-verify.mjs
node scripts/environment-export-verify.mjs
```

The real verification creates only product-labelled containers and private workspace volumes. It captures real screens, stops its workloads, screens the complete workspace tar and verifies every exported file's byte count and SHA-256 before archive and exact-ID destruction. It removes only its newly created workloads and volumes; failed proofs or exports retain that new private root for inspection, with no destructive failure cleanup. It also checks the running image's `runtime.py` digest against current source and proves that the PTY service survives oversized output and accepts the next command. It retains screenshots, identities, verified raw archives, file inventories and result JSON under `~/.local/share/spatial-agent-workspace/environment-verification/<random-id>/`. The local image is `spatial-workspace-task:offline-v1`. Fast fake-engine tests exercise races/faults; they do **not** prove application capability.

## Host API

Construct `new EnvironmentBroker(privateEnvironmentDataDirectory)`. Keep this directory separate from pairing/provider/coordinator storage. It holds private metadata and a single-writer lock, **not** a container mount. Workspace files live in a labelled, app-owned Docker volume.

| Host API | Contract |
|---|---|
| `create(taskId)` | Create/start the dedicated environment; same logical task returns its existing snapshot, including unavailable/starting states. No automatic retry of uncertain work. |
| `snapshot(taskId)`, `snapshots()`, `views()` | Observed lifecycle, lease, detail and task-owned tool views. |
| `readiness()` | Docker/image prerequisites; create additionally probes actual app windows and PTY. |
| `frame(taskId, viewId)` | `{png, identity: FrameIdentity}`; task/view/generation/epoch and capture time identify the actual frame. |
| `terminal(taskId)` | Bounded actual PTY output (128 KiB tail). |
| `reconnect(taskId)` | Invalidate view generation when reconnecting/replacing the view transport. Call once at that boundary, not on each polling snapshot. |
| `agent()` | Frozen trusted agent tool port: `exec(taskId, expectedEpoch, command)`, `read(taskId, relativePath)`, `write(taskId, expectedEpoch, relativePath, content)`, `input(TaskInput)`. |
| `owner()` | Authenticated owner port with the same tools plus `takeControl`, `resume`, `stop`, `exportArchive`, `archive`, `destroy`. |

The composition layer selects these ports from **trusted caller identity**, never a model argument or caller-supplied role. Agent tool schemas must not contain role selection, control/cleanup methods, Docker access, container names, host paths, or the broker itself. The owner server must authenticate before using the owner port. Coordinator authority and trusted-host inference remain the parent's responsibility; this broker is not a competing authority store.

All mutating tool calls require the current **single task-wide epoch**. All three views share it. Input additionally checks task/environment/view/generation; the server must not rewrite stale identities into current ones. Files are relative to `/workspace` with no dot components or symlink traversal; the small read/write API accepts regular files up to 1 MiB. Raw shell code can operate other files **inside its container**, never host paths. Shell execution uses the actual PTY; its 20-second timeout or lost acknowledgement leaves the environment uncertain, not safely cancelled. Shell output is untrusted task content. Terminal command capture is bounded to 1 MiB of raw PTY bytes, including the completion marker's final chunk. Crossing the bound returns an uncertain error, never a success followed by a second acknowledgement, and leaves the PTY service running. Deterministic chunk-boundary tests run via `node --test build/host/tests/environment-terminal.test.js` (Python stdlib, no real shell). Container resource bounds: two CPUs, 1536 MiB memory, 256 PIDs, bounded transient home and `/tmp`; workspace disk quotas are not implemented.

## Control and cleanup

`owner.takeControl(taskId, expectedEpoch, confirmRestart=false)` and `owner.resume(...)` first return a `ControlLease` with `owner: 'handoff'` and `confirmation-required` detail. This is a **request result, not an exclusive lease**: the current actual lease is unchanged and current processes keep running. Display the detail and explicitly obtain confirmation; do not silently retry with confirmation enabled.

Confirmed transitions fence the epoch immediately, reject queued old mutations, externally kill the entire container and verify Docker reports no running container/init process. They then remove the old physical container and reopen the **same logical environment and workspace volume** in a new physical container, with a new view generation. Using a different physical ID prevents a delayed old Docker exec from landing in the fresh workload. Only actual app/PTY readiness produces an owner/agent acknowledgement. Failure stays `uncertain`; neither role may mutate. Explicit confirmed reset can reconcile it.

**This baseline loses all running process state and unsaved app state on takeover AND resume. Only saved `/workspace` files survive.** Browser profile/session state and transient home are not preserved. It does not offer a non-destructive handoff. A pointer-only lease would be unsafe because shell/GUI code can fork daemons. The real test starts a detached writer and proves the confirmed reset stops it, while an ordinary request does not.

`owner.stop(taskId, expectedEpoch, confirmReset=false)` likewise requires confirmation before destructive process teardown. `archive(taskId, expectedEpoch)` retains the workspace and a verified full private tar capture; `destroy(...)` refuses until that capture is durable and verified at the current epoch/generation. Export, archive and destruction refuse running, queued, transitioning or uncertain work. Destroy retains the archive and a small private tombstone and forbids reusing that logical task ID, so an old shell epoch can never become valid in a recreated task. `close()` releases the kernel lease but intentionally does not stop tasks. Reopening marks formerly running work uncertain and bumps epoch/generation. `broker.lock` is a permanent stable inode: **never unlink it**, including after a crash. The kernel releases the dead process's lease; a new broker still requires explicit reconciliation of uncertain tasks.

### Full owner-only workspace export

`owner.exportArchive(taskId, epoch)` returns:

```ts
{ taskId, environmentId, epoch,
  files: [{ path, bytes, sha256, open(): Readable }],
  rawArchive: { bytes, sha256, open(): Readable } }
```

No host path, owner profile, token or container-control handle is returned. `open()` streams immutable captured bytes and refuses stale environment identities. The raw tar retains supported directory/file metadata and empty directories; the regular-file streams provide a full SHA-256/length inventory. This is an authenticated host-owner API, never an agent port or model schema.

Capture uses fixed `docker cp <owned-stopped-ID>:/workspace/. -`, streamed to a new 0600 file under a verified 0700 private directory. It never extracts task paths onto the host, follows task links, starts an export helper, or executes task code. Before and after capture the engine verifies stopped state, confinement, exact labels, local volume ownership and absence of additional volume consumers. Python reads the tar without extracting it and rejects every link, special file, unsafe/duplicate path, sparse member, unsupported metadata, truncation or trailing data. It hashes every file and the entire tar. Files and containing directories are fsynced before capture is committed. Failed/interrupted captures remain `workspace.pending.tar`; they never authorize destruction. Destruction reverifies archive bytes and source safety before removing anything.

There is no per-file byte cap on export. Disk exhaustion and the five-minute capture/validation limit fail without cleanup. Inventory supports up to 100000 entries / 64 MB; exceeding either fails explicitly rather than returning a partial archive. Host Python is required; no packages are downloaded. Saved workspace bytes can contain sensitive task data: keep raw captures private and let the operations layer screen and verify exports before writing any owner-approved portable archive. Unsupported links/special files must be repaired inside that task by an explicit owner reset, not silently omitted.

The real export proof writes and hashes a 20 MiB file and saved code, checks actual symlink/hardlink/FIFO refusal, and records exact-ID cleanup under `~/.local/share/spatial-agent-workspace/environment-export-verification/<random-id>/`. Fake-engine tests cover additional malformed paths, queued/stale generation, interruption and corrupt-archive cases; they are not real Docker evidence.

## Enforced boundary and limits

Containers run UID/GID 1000 with a read-only image, no added capabilities, all capabilities dropped, `no-new-privileges`, Docker's default seccomp/AppArmor where enabled, private PID/IPC/cgroup namespaces, and `--network none`. They have **no host bind mounts**, Docker socket, provider/owner credentials, coordinator state, or host control API. Only their private labelled named workspace volume is writable and durable. Engine helpers validate container and volume labels/configuration before operations and never accept arbitrary container names. Administrator-level host/Docker access is trusted and outside this boundary.

Chromium uses `--no-sandbox` **inside this non-root Docker boundary**, not an unconfined/privileged container. It is not an additional browser-process sandbox; do not treat local web content as isolated from other apps/files of the same task. Do not sign in or enter owner/provider credentials into task applications. Docker shares the host kernel; this baseline is not a VM or a defense against a hostile host administrator or kernel exploit.

A future anonymous-research feature must add and test a separately bounded proxy. Do not replace `--network none` with an ordinary Docker bridge: a host gateway service and other private host services must remain unreachable. No external-account capability is advertised by this image.
