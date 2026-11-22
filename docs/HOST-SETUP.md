# Private host setup

The host can run empty: owner setup, pairing, projects, spaces, and retained product history work without a coordinator or speech login. Missing execution and speech stay **BLOCKED**. Setup does not seed business content, copy harness credentials, create grants, or activate shared services.

## Requirements and start

Use Linux/WSL, Node >=22.13, npm, and OpenSSL.

### Start an installed package

From the private version directory, run:

```sh
npm start
```

The installer supplies the compiled host and locked runtime dependencies. Do not run source preparation, `npm ci`, or TypeScript build commands in this directory. The declaration API is a development artifact, not a runtime dependency. Runtime activation loads a separate explicitly configured reviewed coordinator factory.

### Build a source checkout

The coordinator's spatial API is public only on the agent-system branch `feature/spatial-api` until its pull request is merged; [Coordinator build and type seam](COORDINATOR-BUILD.md) says where to get it and how to point `SPATIAL_COORDINATOR_DIST` at its build. The declarations are committed, so `npm ci` is enough to compile; verifying them against a selected build is described there. Then run:

```sh
npm run typecheck
npm run lint
npm run build
npm start
```

Defaults:

| Setting | Value |
| --- | --- |
| Private root | `~/.local/share/spatial-agent-workspace/host` (the current user's home) |
| Native HTTPS | `127.0.0.1:47843` |
| Owner console HTTP | `127.0.0.1:47844`, always loopback |
| Product database | `ROOT/workspace.sqlite` |
| Pairing / certificate | `ROOT/auth/`, `ROOT/tls/` |
| Broker / private evidence | `ROOT/environments/`, `ROOT/evidence/` |
| Lifecycle lease | `ROOT/host.lock`, descriptor-owned, never unlink |
| Speech / telemetry | Unconfigured / off |

Open `http://127.0.0.1:47844/` directly. Never reverse-proxy the owner console. The native endpoint starts on loopback; Quest requires an owner-selected host LAN IP. Native clients must pair and verify the independently obtained certificate pin. A self-signed certificate is not a reason to disable verification.

Set `SPATIAL_HOST_ROOT` to an absolute, canonical OS-private directory to select another root. `SPATIAL_HOST_CONFIG` names an existing owner-owned JSON file with mode 0600. No file is generated automatically. Unknown fields, public permissions, links, and invalid choices are refused. Root directories use 0700; durable private files use 0600. Do not put host data on a filesystem whose ownership/mode behavior you have not verified.

Minimal owner JSON, changing only the native bind:

```json
{ "nativeHost": "192.168.1.10" }
```

Replace that address with the owner's actual LAN IP. Neither this example nor starting the host permits paid inference. Ports can be set to `0` for isolated tests; normal installs use the stable defaults.

## Exact configuration

Top-level fields are optional unless their section requires them:

| Field | Contract |
| --- | --- |
| `nativeHost` | Explicit IPv4/IPv6 address, default `127.0.0.1` |
| `nativePort`, `consolePort` | Integers 0–65535, defaults 47843 / 47844; distinct unless ephemeral |
| `telemetry` | `{ enabled?: boolean, maxBytes?: number }`; off, 8 MiB default; 16 KiB–16 MiB per file |
| `coordinator` | Required fields `buildDirectory`, `stateRoot`, `operator`, `activationEvidence` |
| `profiles` | At most one explicit profile per `pi-local` / `claude-local` |
| `scopes` | Owner registrations described below; no inferred project scope |
| `runtimeAccounts` | Optional private Claude identity registrations `{ runtime: "claude-local", orgId: string, email: string }` |
| `speechConfig` | Private JSON options file under the selected root |

`coordinator.buildDirectory` is the absolute selected compatible built `dist` directory. Its actual `commands.js` must export `adapterFor` and `createCoordinatorCommands`, and `build-identity.json` must identify the approved build digest. The product does not use a second scheduler, admission system or permission store.

`stateRoot` is **mandatory** and separate from product data. The host never defaults to live/main `.state` or takes ambient `AGENTSYS_STATE` as permission. When configured, the host sets process-local `AGENTSYS_STATE` before importing commands; a different inherited value blocks integration. The state must already exist and be private. Nothing creates or overwrites it.

### Compatible coordinator activation

Building the feature worktree is not activation. The owner must follow the coordinator's `docs/OPERATING.md` writer-compatibility and reviewed-version controls. Inventory every CLI/MCP/UI/loop writer plus active, reserved, and uncertain work; prevent incompatible writers from restarting; back up the quiesced store; update all writers together only after explicit approval. Do not count on the product's root lease to fence coordinator writers.

`activationEvidence` points to a private owner-authored record under `ROOT`, with exactly these string fields:

- `stateRoot`, `buildDigest`, `operator`: the selected existing state, exact 64-character build digest, and configured operator.
- `approvedAt`: nonfuture ISO timestamp of the owner's cutover approval.
- `mergedPr`: the existing reviewed merged PR URL.
- `writerInventory`, `quiescenceEvidence`, `backupEvidence`: nonempty private evidence files alongside that record (at most 1 MiB each).

This consumes evidence; it does not create approval, verify a merge with the forge, settle unknown effects, or stop writers. The host requires an existing coordinator active-version record whose coordinator digest, activating operator and reviewed PR match. It rechecks record/evidence fingerprints and current version/operator on guarded operations. Changes block further execution. There is no `activated: true` escape hatch. The owner must ensure the evidence describes a real, approved compatible cutover; do not manufacture files to enable a run.

### Runtime profiles and receiver scope

Every profile requires: `runtime`, absolute `bin`, private `configDirectory` and `dataDirectory` below `ROOT`, absolute `scriptDirectory`, `models`, and the actual `subscriptionId`. Configuration and history directories must be separate, nonoverlapping across profiles, and outside host auth/TLS/environment/evidence directories. `scriptDirectory` names the delivered `runtime-*.mjs` files; it is not generated from model input. Provision the app CLI login deliberately; do not copy `.pi`, `.claude`, harness extensions or secrets. Models are explicit `{ id, efforts: string[] }` entries; Pi IDs are exact `provider/model` pairs. No aliases, defaults or effort substitutions are inferred.

**Authentication:** Claude has a functioning read-only proof path. Its app-profile `claude auth status` and the default CLI used by the selected coordinator's legitimate reader must both report OAuth, first-party login, the exact owner-registered org/email and matching subscription type. The actual `ClaudeWebAdapter.accountIdentity()` must also agree. Missing fields, login failure, different identities or ambient provider/API-token/endpoint overrides block settings/queue **before** usage reads, admission or provider calls. These local checks run again at the runtime's preprompt boundary; they do not copy a key or change process-global credential settings. Private `runtimeAccounts` metadata never enters a client/model response or log.

**Pi blocker:** the current legitimate Codex usage reader exposes no comparable current account identity. Its source explicitly describes Pi/Codex account sharing as an assumption. Pi therefore stays BLOCKED rather than treating a directory, subscription label or decoded unsigned token as proof. The owner must supply a runtime/coordinator identity capability before enabling it. No real account login or inference was tested by host assembly; Claude proof tests use a clearly labelled local CLI fixture.

Each scope registration requires `projectId`, `spaceId`, `receiver` (`space` or `task`), `runtime`, and `scope`. IDs must match existing product records, not titles or source text. `scope` requires coordinator `repo`, `workClass`, `profile`, `actions`, `estimate`, and `timeoutMs` (1000–3600000); optional fields are `approvalId` and `triggerSource`. `estimate` requires `basis` (`operator-bound`, `comparable-history`, `calibration-approval`, `none`), `detail`, and 0–100 `fiveHourPercent`, `weeklyPercent`, `uncertaintyPercent`. A missing basis is not replaced with fabricated zero-cost evidence.

Actions are `conversation`, `task-tools`, and `delegate-task`, with `conversation` required. A pure conversation space registers only `conversation`. To support requested child work, the owner must explicitly register `delegate-task` for that exact project/space/runtime. Include `task-tools` in that space's envelope only when its delegated children may use task environments; `conversation` plus `task-tools` without `delegate-task` is rejected. A space never receives an environment, so this child envelope does not enable direct space tools or cross-task access. Each entered child space needs its own registration; project membership and navigation confer no authority.

A delegated task needs no separate task registration when its durable agent-delegation origin resolves to that registered space's actual coordinator parent run. Resolution checks the parent submission/conversation/task identities, same project and space, current core authority, exact admitted owner envelope (including estimates/timeout), and the parent's runtime/model/effort. Queued children and follow-ups retain that original parent run even after history pagination or a newer parent turn. A separate task registration, if present, must match this inherited envelope; conflicting registrations block rather than choose broader authority. Changed registration or revoked/narrowed parent authority blocks subsequent tools/admission. Reconcile retained effects before an owner changes the setup; nothing replays automatically.

Existing task registrations still admit explicit owner tasks in their registered space/runtime. A public owner task's `parentTaskId` alone is only a product relationship: it cannot inherit space authority or trusted execution ancestry. Origin, parent-run metadata, actors, runtime choices, and scopes never come from tool arguments or source text. Scopes are requests against current coordinator authority, **not grants**. Core admission and the shared family attempt/concurrency, aggregate and paid-call limits remain authoritative; child windows cannot raise them.

After admitted-run creation, main calls `bridge.assertTaskToolAllowed`, creates/reuses the actual broker environment, persists `task.environmentId`, and captures the lease epoch once. Agent tools and frames carry the same guard inside the broker's queue/read boundary. Revocation, unavailable destinations, a different environment, takeover/reset, or epoch change refuse further tools. HTTP receives only the owner broker port; it never receives a model-selected role.

### Inbox authority handoff (manual, explicit owner action)

Only an actual coordinator `awaiting-approval` refusal produces **Confirm existing coordinator authority**. Missing runtime/login/scope/environment/speech or activation stays a blocker, not a permission request. Inspect the complete retained envelope: product receiver, submission and coordinator task IDs, exact runtime/model/effort, repo/class/profile/actions, trigger source, estimates, and timeout. Its fingerprint belongs to the original refused turn and never changes.

Use the **selected** `coordinator.buildDirectory`, `stateRoot`, and configured operator from the private owner configuration. Do not use a global `agentsys` alias, another build, or default live state. Set these shell variables to those exact selected values and the displayed envelope; choose every budget yourself. The following is a command template, not permission to run it against live authority:

```sh
AGENTSYS_STATE="${COORD_STATE:?exact selected private state}" \
node "${COORD_BUILD:?exact selected buildDirectory}/cli/main.js" approve \
  --as "${OPERATOR:?configured owner}" --repo "${REPO:?displayed repo}" \
  --scope "${OWNER_SCOPE:?owner description}" --class "${WORK_CLASS:?displayed class}" \
  --runtime "${RUNTIME:?displayed runtime}" --profile "${PROFILE:?displayed profile}" \
  --actions "${ACTIONS:?displayed comma-separated actions}" \
  --model "${MODEL:?displayed model}" --effort "${EFFORT:?displayed effort}" \
  --max-attempts "${ATTEMPTS:?owner-chosen}" --max-concurrent "${CONCURRENT:?owner-chosen}" \
  --max-paid-usd "${PAID_USD:?owner-chosen}"
```

The actual command is `approve --scope`, **not** `approve --task`. The existing coordinator approval is persistent scope authority; it does not enforce the product task ID, prompt, or human `--scope` description. Do not describe it as permission for only this task. The existing Authority UI has implicit budgets, so it is not this exact-budget handoff channel.

For an existing standing-grant registration, the owner may instead explicitly issue a grant through the same selected CLI/state. Supply all limits; nothing in the product creates this grant:

```sh
AGENTSYS_STATE="${COORD_STATE:?}" node "${COORD_BUILD:?}/cli/main.js" grant create \
  --as "${OPERATOR:?}" --repos "${REPO:?}" --classes "${WORK_CLASS:?}" \
  --sources "${TRIGGER_SOURCE:?existing registered triggerSource}" \
  --runtimes "${RUNTIME:?}" --profiles "${PROFILE:?}" --actions "${ACTIONS:?}" \
  --max-attempts "${ATTEMPTS:?}" --max-concurrent "${CONCURRENT:?}" \
  --max-paid-usd "${PAID_USD:?}" --max-dispatches "${DISPATCHES:?owner-chosen}" \
  --max-aggregate-concurrent "${AGGREGATE_CONCURRENT:?owner-chosen}" \
  --window-hours "${WINDOW_HOURS:?owner-chosen}" --reason "${OWNER_REASON:?}"
```

A grant must match the **existing** receiver registration and trigger source. If the coordinator chooses another matching grant, confirmation refuses the entered receipt instead of silently substituting it. Issuing an approval alone does not bind it: the coordinator uses an approval only when `approvalId` is supplied.

For an approval receipt, follow this controlled reload procedure:

1. Record the printed existing receipt ID/version and exact owner-chosen limits privately. Preserve both stores and evidence. Do not edit the refused interactive record, its fingerprint, grants, or run state.
2. Quiesce this product host's admission and let `close()` drain admitted work. Respect existing coordinator writer/activation controls; changing the receiver registration does not authorize a new build or shared-state cutover. Unknown effects and reservations remain retained.
3. Edit only the matching receiver/runtime registration's `scope.approvalId` in the selected private `SPATIAL_HOST_CONFIG` (0600). Keep project/space/receiver/runtime, actions, estimates, and timeout unchanged. Keep the exact selected build/state/operator/activation record. Do not add an ID to old received envelopes.
4. Restart the same approved host with the same private root/config and selected coordinator. Reopen the same request/version and inspect its complete evidence. Reload reconciles identities; it does not replay the refused turn. If the original scope/settings, task attempt, parent, or activation changed, dismiss the obsolete request and start a new deliberate turn instead.
5. Enter the **existing receipt ID and exact current version** in native/companion **Confirm existing authority**. The coordinator's ordinary authorization decision checks the selected receipt under its shared fence. The product transaction checks the current Inbox version/evidence and stores the exact coordinator owner receipt. Revoked/narrowed/mismatched authority refuses. Typing `yes` cannot grant permission.
6. Confirmation means **current scope coverage only**. It does not prove capacity, create a grant, cancel work, release uncertain reservations, or start inference. Jump to the task and send a **new deliberate follow-up**. That new identity must pass ordinary fresh admission and inherited parent budgets. Never resume/replay the old blocked or uncertain identity.

A standing grant matching the existing trigger-source registration needs no config binding/reload. The selected receipt must still match the coordinator's returned authority ID/version. Delegated work must retain its parent's same current authority and resource envelope; an independent child receipt cannot widen it.

If SQL/transport acknowledgement fails, the coordinator may already retain the exact non-authorizing confirmation in `STATE/interactive-authority-confirmations/`. Preserve it. Refresh the request; retry only the same current request/version, receipt ID/version, and decision identity. Do not issue another grant to repair acknowledgement. The fixture tests cover CLI issuance, binding/reloaded bridge, exact receipt recovery, and a freshly admitted turn; they are not live activation/provider evidence.

### Questions, obsolete reviews and deferred requests

Answering retains the exact owner answer and evidence; no model keeps running while waiting. Jump and send a new follow-up. `task_context` exposes durable owner decisions for that exact receiver even after the answer falls outside recent conversation history.

A newer task attempt does not move an old review pin. Inbox marks the old review obsolete with its reason; complete old evidence stays readable. **Dismiss / obsolete** requires an owner reason and current request version, retains the old evidence/choice and closes only the request. It never grants, reviews a different attempt, completes work, cancels a task, or releases uncertain reservations. Answered/dismissed requests remain read-only history. Archive no longer counts dismissed requests as open, but all work/environment/uncertainty checks still apply.

Open and deferred requests remain visible and deliberately jumpable in both clients. Native evidence is paginated before decision controls, including request/version and attempt IDs. Batch/native fixture checks do not establish hands/controller behavior, wearer readability, or an actual VR/MR journey.

### Speech

`speechConfig` selects the actual optional `OpenAiSpeechService`. Its private JSON allows only:

- `journalPath`: absolute private path below `ROOT`, default `ROOT/speech.sqlite`.
- `approvedPerCallUsd`, `approvedDailyUsd`: positive owner-approved caps.
- `pricing`: `whisperUsdPerMinute`, `ttsUsdPerMillionCharacters`, `verifiedAt`; reviewed upper bounds expire after 30 days.
- `voice`: `alloy`, `echo`, `fable`, `onyx`, `nova`, `shimmer`.
- `timeoutMs`: 1–25000; `audioCacheBytes`: 0–64000000.

Provision a **new** billing journal once, while the host is stopped and private `speechConfig` is selected:

```sh
node scripts/host-speech-init.mjs
```

This explicit trusted command holds `ROOT/host.lock`, refuses any existing journal/identity, initializes with `initializeJournal: true`, and closes without a provider call. `npm start` never sets that flag or infers initialization approval from absence. A missing/lost journal or identity is BLOCKED; preserve it for recovery. `initializeJournal` is not accepted in the ordinary owner JSON.

Key only: `OPENAI_API_KEY` in the protected host process environment. No endpoint, key, transport or automatic model-login option is accepted. The fixed provider profile is OpenAI whisper-1 / tts-1; missing credentials, caps or price review blocks calls. Readiness never spends money. The HTTP layer supplies durable idempotency context to transcription/synthesis; assembly forwards it unchanged. Raw audio is not logged or retained on disk. Preserve the billing journal and uncertain reservations; do not delete it to reset a limit. Speech must still pass authorized real-provider/device tests; a configured key is not proof of account authorization.

### Native evidence

Telemetry is off unless explicitly enabled. `ROOT/evidence/native.jsonl` retains only selected typed native session, destination, listening, and timing fields plus derived client identity/time. Three files rotate at `maxBytes` each; records are at most 4096 bytes. No generic events, raw audio, prompts, keys, or extra caller fields are written. A client-reported number is **not performance acceptance evidence**. The `logs/` directory is reserved private space; startup/shutdown stdout contains fixed lifecycle records, never pairing codes or tokens.

## Private install and rehearsal

Run the installer from a prepared source checkout with development dependencies installed. It is not shipped in the compiled package. Install into a **new** private version directory, never over a running installation:

```sh
bash scripts/host-install.sh /absolute/new/private/version-directory
cd /absolute/new/private/version-directory
npm start
```

The installer builds, copies the compiled host, runtime/maintenance scripts, and public Markdown runbooks, then runs locked offline `npm ci --omit=dev --ignore-scripts`. It requires cached dependencies, including pinned `fs-native-extensions` 1.5.1; cache absence fails honestly. It installs no service, global configuration, credential, authority, or coordinator state. A selected coordinator build remains an explicit separately approved prerequisite, not an automatically copied live writer.

Run an isolated smoke rehearsal from either the source checkout or installed package:

```sh
node scripts/host-smoke.mjs /absolute/private/version-directory
```

This launches the **actual `npm start`** with a new OS-private temporary root, ephemeral ports, no inherited coordinator/provider/login environment, and no project seeds. It exercises empty setup, blocked capabilities, private SQLite/TLS state and SIGINT draining. It removes only that test root after shutdown. It does not test Quest, real agents, paid speech, or performance.

## Shutdown, restart and maintenance

SIGINT/SIGTERM stop HTTP admission, drain active service requests and admitted execution, close speech, then close broker/store and release the stable root lease. No forced-success timeout or `process.exit()` abandons callbacks. A shutdown error reports BLOCKED and retains ownership for investigation/retry. A supervisor must allow draining; do not treat killing the host as acknowledged cancellation.

Broker close **does not stop background workers**. Restart marks unreconciled environments uncertain; coordinator acknowledgement loss is reconciled by stable identity, never automatically replayed. Takeover/reset requires the broker's explicitly confirmed full-workload teardown, not a fake pause. Preserve unknown effects and reservations.

Nonempty archive now has a host-only lifecycle port, installed only from the already verified selected coordinator with public `interactiveArchive`, `interactiveArchiveLookup`, and `interactiveArchiveReconcile` commands. The actual deployment remains **BLOCKED** until its reviewed compatible build/state/operator activation exists; fixtures never enable production. Missing archive commands/activation leave `history-archive` blocked. Empty projects/spaces may still be tombstoned directly through the store's atomic guard.

The owner archive request derives exact receivers and retained task/run provenance, holds every stopped environment through actual engine verification, and commits product tombstones plus coordinator bindings in one synchronous SQLite transaction under the coordinator's durable prepared cutoff. Offline blocked, never-executed history can fence its explicit receivers with zero runs; a known linked run is never omitted. Task/model terminal labels alone do not prove inactive environments. History archive retains stopped volumes: no automatic stop, reset, export, removal or cleanup. Missing retained environments and unavailable verification refuse.

After a crash, a prepared cutoff remains read-only even if SQL did not commit. Repeat only the same owner archive request: fresh SQL binding reads reconcile a lost acknowledgement without a new tombstone, or retry the exact uncommitted input after fresh proof. Do not remove receipt/binding files or reset history to recover. Voice capture, paid transcription and owner controls consult the cutoff reader; retained execution history with an unavailable reader refuses effects. See `ARCHIVE.md` for the transaction and recovery contract.

Use documented maintenance operations under complete writer/workload quiescence; never grant, stop or destroy work merely to make archive pass. Backup/restore and update require the coordinator's existing cutover rules and product `operations.ts` verification, a new destination and separately authorized activation. Never overwrite live state or remove stable lock inodes.

## Verification and assembly API

Run these checks from the source checkout with development dependencies installed:

```sh
npm run typecheck
npm run lint
npm run build
node --test build/host/tests/config.test.js build/host/tests/main.test.js
node scripts/host-smoke.mjs
node scripts/host-install-verify.mjs
```

The install verification assembles a new temporary private version, checks shipped runbooks and links, refuses an existing destination, and runs the installed smoke. It removes only its own fixture directory. It does not activate owner state or services.

Tests exercise real host/SQLite/TLS/leases, local Claude identity-proof command fixtures, and the real optional speech constructor with calls blocked. The isolated empty-profile discovery used installed Claude 2.1.287 `auth status --help` and `auth status`: JSON metadata, no login or provider call. Fixed-task races use an explicitly labelled engine fixture, not Docker or live execution evidence.

`main.ts` exports `startHost(config?)`, returning actual ports/store/broker and idempotent async `close()`. Composition helpers are `authenticateHostOwner`, `resolveExecutionScope`, `bindTaskEnvironment`, and `nativeEvidenceRecorder`; they are trusted host APIs, not remote/model command schemas. `config.ts` exports the strict loader/parser and private-path helpers. See `host-integration.md` and `host-api.md` for the HTTP/service contracts. No private owner JSON is returned to clients.
