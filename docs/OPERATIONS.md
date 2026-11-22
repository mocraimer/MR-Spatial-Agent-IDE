# Operations and recovery

These are owner-local operations, not model tools or client APIs. They create new
private output only. They cannot activate a restored store, change authority, stop
services, install packages, call providers or control the headset. AC-6.2 live
activation remains an owner gate, not a result of these rehearsals.

## State and ownership

| State | Authority / contents | Recovery rule |
|---|---|---|
| Product SQLite | Projects, spaces, logical conversations, all messages, task/window identities, links, outbox/submission keys, source text/provenance, captured voice intents/audio digests (not audio), Inbox versions/decisions, archives/bindings, retained archive attempts and revision events | Keep the whole database; the bounded UI snapshot is not a backup |
| Coordinator state root (`AGENTSYS_STATE`) | Jobs, runs, interactive submissions, authority history, attempts, reservations, paid-call ledger, evidence, version and owner controls | Coordinator remains the only execution authority; preserve uncertainty and held reservations |
| Broker root | Root identity, environment/task/container/volume identities, generations, mutation epochs and lifecycle | State JSON alone is not a Docker volume backup |
| App-owned artifact root | Retained results and evidence files | Include in backup only when this is a reviewed app-owned root |
| Optional configured speech journal + `.identity` | Immutable financial policy, every call key/payload digest, transcripts, conservative reservations and complete/uncertain/pending liabilities | Inventory the exact pair; keep its identity and every liability. Backup does not settle calls or regain budget |
| Separate private auth/TLS/provider state | Pairing hashes, TLS key/certificate, provider credentials and paid-provider configuration | Never copy into these backups or task environments; recover through owner setup |
| Permanent host/broker lock files | Descriptor-held lifetime leases; PID text is diagnostic only | Never unlink, replace or restore a lock inode, even after a crash |

`StateSources` requires explicit `productDatabase`, `productLeasePath` and
`coordinatorRoot`; `environmentRoot` and `artifactRoot` are optional. Configured
speech requires **both** `speechJournal` and `speechIdentity`, where the latter is
exactly `<speechJournal>.identity`. Omit both only when speech has no configured
journal; missing credentials/budget or disabling calls is not permission to omit
an existing configured financial ledger. No command
uses an implicit `.state` or reads the existing factory to find one. The product
lease must be **the same permanent lifetime lease actually held by main**, not a
new operations-only lock. Operations also acquire `environmentRoot/broker.lock`
for backup/current-store inspection. A missing lock file or competing descriptor
holder blocks capture. Process death releases ownership; file presence does not
prove it. A restored root needs a fresh, distinct lock namespace, never a copied
namespace connected to live writers.

Main's actual host data root is `HostConfig.root`, selected by `SPATIAL_HOST_ROOT`
(default `~/.local/share/spatial-agent-workspace/host`).
`host/src/main.ts` holds **`<hostDataRoot>/host.lock`** for its lifetime and opens
`<hostDataRoot>/workspace.sqlite`; `auth/`, `tls/` and `environments/` are children
of that same root. Use that resolved root in the operation config:

| `StateSources` field | Actual binding |
|---|---|
| `productDatabase` | `<hostDataRoot>/workspace.sqlite` |
| `productLeasePath` | `<hostDataRoot>/host.lock` (stable inode, never recreated for operations) |
| `coordinatorRoot` | Explicit approved `HostConfig.coordinator.stateRoot`, never a guessed `.state` |
| `environmentRoot` | `<hostDataRoot>/environments` |
| `artifactRoot` | Optional separately reviewed app-owned retained-artifact directory |
| `speechJournal` | Exact private `loadSpeechOptions().journalPath`, default `<hostDataRoot>/speech.sqlite` when `HostConfig.speechConfig` is configured |
| `speechIdentity` | Exactly `<speechJournal>.identity`, the fsynced identity bound to `speech_identity` inside that database |

Do not set `artifactRoot` to the entire host root: auth/TLS, CLI profile logins and
speech keys/configuration have separate privacy and recovery rules. Select only the
journal pair explicitly, never the speech configuration, API key, app-CLI auth or
raw audio. The pair must be owner-private regular files within the configured host
jail; links, shared file aliases, absent/mismatched sidecars and corrupt/unsupported
databases block capture and inspection. Operations never initialize or provision
replacement journals to pass recovery. Setup supports
explicit private app-owned CLI profiles; profile-directory presence is not verified
account login, legitimate usage identity or permission to infer. Runtime account,
authority, activation and paid-budget gates remain blocked until their real proof
exists. Operations neither copy harness logins nor satisfy those gates.

## Owner maintenance is required

A product kernel lease does **not** fence every existing coordinator writer.
A before/after hash comparison detects drift but does not prove an online
cross-store transaction. These commands therefore require a verified quiet point
and never advertise online atomic coordinator backup.

Before live capture or destructive environment cleanup, follow the existing
coordinator `docs/OPERATING.md` writer-compatibility and guarded-upgrade procedure:

1. Obtain existing reviewed explicit owner cutover/maintenance approval. Inventory
   every CLI, MCP, UI, loop, direct/manual/scheduled launcher and product host;
   record loaded/on-disk/selected executable identities, state roots, effective
   service Restart/KillMode/timeout and owner controls. Unknown loaded build identity
   stays `unknown` with an inspection reference, not an inferred revision.
2. Inventory active, reserved, remote-uncertain and unknown effects, including worker
   descendants and escaped processes. Keep their IDs, attempts, logs and claims.
   Quiesce writers at a safe boundary and prevent all restart paths under the
   owner's approved procedure. Do not use stage pauses, `chmod`, disable alone,
   PID absence or a new lock as proof of a hold. If ownership cannot be proved,
   postpone capture/cutover; do not restart the factory to manufacture proof.
3. Record `MaintenanceEvidence`: `mode: owner-approved-quiesced`, owner identity,
   `reviewedCutover`, `inspectedAt`, `expiresAt`, complete `writers` entries
   (`name`, actual `version`, diagnostic `pid` or null, `stopped`,
   `restartPrevented`, inspection `evidence`),
   `workersAndRemoteEffectsInventoried: true` and `inventoryEvidence`.
   Evidence expires within five minutes. Each PID, when recorded, must be absent;
   this is an additional refusal check, **not** descendant/remote stop proof.
4. Keep that hold through capture, verification, candidate checks and any separately
   approved activation. A script reads owner attestations; it cannot discover all
   launchers, authenticate an owner by JSON text or prevent legacy writers from
   restarting. The trusted host's `verifyQuiescence()` must perform its real checks
   before/after capture. Task/agent/content input must never populate this callback
   or the owner's maintenance record.

For configured speech, `MaintenanceEvidence.speechWriters` is also required:
`{journal, identity, allInstancesStopped: true, restartPrevented: true, evidence}`.
Paths must match the exact inventoried pair. Inventory **all** independent service
instances, processes and restart launchers in `writers` and the inspection evidence;
close/stop every writer first under the existing owner procedure. Speech uses SQLite
`BEGIN IMMEDIATE` across instances, not the host's lifetime lease. Absence of a host
lease, process or an operations-owned speech object does not prove zero writers.
`verifyQuiescence()` must check the actual whole-writer hold before/after capture,
rollback comparison and configured-speech detached inspection. Restore inputs with
speech therefore also require `maintenance`. Host composition supplies the trusted
API callback; `scripts/operation-state.mjs` supplies a callback that rechecks the
fresh `owner-approved-quiesced` maintenance record at each API boundary. The API
also checks the exact speech pair and whole-writer evidence. The CLI can check
attestations and recorded PIDs, not independently discover writers, prove their
absence or grant maintenance approval.

Uncertain records can be retained in a quiet backup but are not settled by it.
Activation and cleanup require their distinct current reconciliation/stop evidence.
If the maintenance window expires, retain output and obtain fresh inspection; do
not extend timestamps without inspection.

## Backup and detached restore commands

Use an installed private host package, or build the product in its source checkout first. The installer ships `scripts/operation-state.mjs` and its compiled host API; installed packages do not need `npm run build`.

Commands require Node >=22.13, installed pinned native
lock support and an OS-private **Linux** destination parent that already exists.
Each destination must be new and outside every source/backup/current root.
Symlinks/special files and outputs with public mode bits are refused. DrvFS mode
changes are not a verified privacy or writer boundary. These backups are private
recovery evidence, not downloadable client/project diagnostics.

From the selected installed version directory or built source checkout, run only under the documented approved maintenance hold:

```sh
node scripts/operation-state.mjs backup "$BACKUP_CONFIG"
node scripts/operation-state.mjs verify "$BACKUP_DIRECTORY"
node scripts/operation-state.mjs restore-detached "$RESTORE_CONFIG"
node scripts/operation-state.mjs rollback-check "$ROLLBACK_CONFIG"
```

Set these variables from the actual owner-reviewed inventory; the configuration
files are private owner-local JSON, never credentials or sample business records.
Required configuration fields:

| Command | Input |
|---|---|
| `backup` | `sources: StateSources`, new `destination`, `maintenance: MaintenanceEvidence`, actual `productBuild` and `coordinatorBuild` |
| `verify` | Path to a completed backup directory, not a config file |
| `restore-detached` | `backup`, new `destination`, `current: StateSources` identifying every current store and actual lifetime lease; configured speech also requires fresh owner-approved `maintenance` (host API callers also supply `verifyQuiescence`) |
| `rollback-check` | `backup`, `current: StateSources`, fresh `maintenance` |

For speech, put the explicit `speechJournal` and exact `speechIdentity` fields in
`backup.sources` or restore/rollback `current` in that trusted JSON. No extra CLI
flag, default-root scan or credential loading is used. Configured-speech CLI
restore refuses missing/expired maintenance, fixture-mode evidence, missing or
wrong-pair speech writer proof and any recorded running writer. Missing pair files
stay missing after refusal; neither the CLI nor recovery APIs provision replacements.

`backupWorkspace()` validates schemas 1/2/3 and SQLite integrity/foreign keys.
Schema 3 requires `archive_intents`; backup/verification and detached restore retain
pending archive closure. It compares **all** table rows, including schema-2
`voice_intents`, schema-3 archive attempts, additive tables and source provenance,
uses SQLite `VACUUM INTO` to capture committed WAL records, copies the coordinator
and optional broker/artifact trees, fsyncs output, checks current quiet evidence
and hashes again, then commits `backup.json` last. A WAL main-file copy alone is
not supported. Configured speech gets its own fresh SQLite `VACUUM INTO` image,
not a main-file/WAL copy or a source checkpoint. `speech.sqlite` and
`speech.sqlite.identity` are inventoried with byte counts/SHA-256 and
`speechJournalVersion: 1`; verification checks SQLite integrity, required financial
tables, schema version and the exact sidecar/database identity. Logical fingerprints
include all speech tables and schema, including policy, replay digests, transcripts
and reserved/uncertain calls. Written bytes are reread before backup commit.
Pending liability is preserved when writers are stopped; it is not a backup refusal
or permission to release budget. Empty directories are not recovery records. Source files are not
rewritten/checkpointed, attempts are not retried, and reservations are not released.

Auth/TLS/provider/credential/secret directories, `.env` variants, key files,
`clients.json`, coordinator `locks` and `broker.lock` are excluded and named in the
manifest, not copied. Secret-shaped fields/tokens in evidence or transcripts cause
a refusal, not silent redaction. This conservative scanner is not a proof that
arbitrary binary/content data contains no secret. The owner must maintain credential
separation and review the exported evidence scope; an unknown credential format or
unrelated project file must not be made public. Store and evidence roots must be
app-owned. Full coordinator recovery evidence may include other shared work and
must remain owner-private. Hashes detect damage, not a malicious host administrator
rewriting both bytes and manifest; protect the backup through host access controls.

A completed backup needs valid member hashes, no unlisted files **and** `backup.json`.
Verification refuses added/untracked backup data as well as missing/damaged members.
Every output
also retains `INCOMPLETE.json` as its creation record; without the terminal manifest
it is incomplete. Never reuse that destination after a failure. Preserve it for
inspection and select a new destination once the cause is fixed.

`restoreDetached()` verifies members again while copying into a new inspection
root. Coordinator originals, including old grants/approvals/config/armed settings,
go under **`coordinator-history/`**, not an executable coordinator state root.
It restores no credentials or original locks. `RESTORE-BLOCKED.json` records its
source identity and current-store fingerprint. No dispatch, reconciliation command,
broker or factory is launched against that history. Product queued/uncertain
submissions remain retained evidence, not permission to replay them. A speech pair
restores as standalone **`speech.sqlite` + `speech.sqlite.identity`** (even if the
source journal had a custom filename), with the same financial identity and 0600
files inside the new 0700 root. Written bytes/identity are checked before the terminal
restore marker. No service opens the pair or resumes calls. At a separately approved
cutover, bind that exact restored filename explicitly; keep the current immutable
policy and reconcile newer records/liabilities before activation. Backup/current
speech inventories must agree; an older backup omitting a configured ledger cannot
claim financial recovery. Current work,
newer attempts, revoked grants and held reservations remain untouched.

`rollback-check` is comparison only. Any newer attempt, reservation, evidence,
source, owner control, product history **or speech-only journal/policy/replay revision**
change refuses whole-store rollback. Changing only the financial ledger leaves the
newer current ledger intact and prevents `unchanged`. Even
an `unchanged` result grants no activation or state-overwrite authority. Restore
never imports prior paired trust. At an approved cutover, keep current revocations,
reconcile scope/versions and re-pair through trusted setup. Never restore a raw
historical authority root or release uncertain reservations by hand.

## Update and migration composition

Public exports in `host/src/operations.ts` (the typed options in that file are authoritative):

- `backupWorkspace(BackupOptions): BackupManifest`
- `verifyBackup(path): BackupManifest`
- `restoreDetached(RestoreOptions): DetachedRestore` (`activation: blocked`)
- `rehearseMigration(RestoreOptions & {toVersion, migrate(db)}): MigrationRehearsal`
- `checkRollbackUnchanged(backup, current, maintenance, verifyQuiescence): void`
- `verifyMaintenance(MaintenanceEvidence): void`
- `archiveEnvironment(CleanupOptions): Promise<{archive, destroyed}>`
- Typed options/results and `OperationError` with a stable refusal `code`.

`rehearseMigration` restores a **new detached copy**, then runs reviewed migration
code in one outer SQLite transaction with version/integrity/foreign-key checks.
The callback may not commit/rollback that transaction, open live paths, call providers
or change services. A migration error produces `state: rolled-back` with a failure
code only after the original full logical image is proved unchanged. `compatible`
is candidate-copy evidence only; it is not installed-release acceptance. Preserve
both the verified baseline backup and candidate evidence. There is no public live
migration/activate command. Candidate schema 4 in tests is explicitly fixture-only;
this unreleased product build uses schema 3 for durable archive attempts. No live
schema migration or activation was performed.

Apply the coordinator's existing reviewed owner cutover procedure separately.
Keep all writer versions compatible and inventory state freshly before replacement;
never roll back one writer alone or resume old code under an incompatible policy.
A missing approval, stop proof, candidate loaded identity or current reconciliation
keeps activation **BLOCKED**. Preserve newer state for reconciliation rather than
merge histories by timestamps or overwrite them with a backup.

## Archive and cleanup

Product logical archive/export is separate from environment destruction. Current
`WorkspaceStore` archive/history hooks retain records and source provenance; a
hidden task is not a deleted execution or released reservation.

`archiveEnvironment` is host composition only. `CleanupOptions` requires a current
`taskId`/`expectedEpoch`, new output `destination`, `current: StateSources`, verified
maintenance/`verifyQuiescence`, explicit `destroy` and two trusted ports:

- `inspect(): Promise<CleanupEvidence>` from actual coordinator records: exact product
  and coordinator task IDs, terminal state, active/uncertain run IDs, held reservation
  IDs, retained evidence references and fresh inspection time.
- `environment: CleanupPort` with `snapshot`, `exportArchive`, `archive`, `destroy`.
  Bind the broker as `{snapshot: id => broker.snapshot(id), ...broker.owner()}`.
  `exportArchive(taskId, epoch)` returns the broker's exact `ExportArtifact`:
  `{taskId, environmentId, epoch, files: {path, bytes, sha256, open(): Readable}[],
  rawArchive: {bytes, sha256, open(): Readable}}`. Streams contain binary bytes;
  openers return fresh bounded offset streams over the broker's validated private
  uncompressed tar. The raw tar preserves empty directories, modes, ownership,
  timestamps and supported xattrs. Buffer-only exports are no longer accepted:
  they cannot prove retention of the complete raw metadata. This is an owner-only
  broker method, not a model-controlled filesystem reader.

The main writer must be stopped; operations hold its permanent product lease. A
maintenance-only broker owns its distinct broker lease and verifies inactive
container/volume ownership internally. Active, queued, uncertain, reserved or stale
work refuses cleanup. Operations write each stream to a **new `wx`, 0600 file**
under a 0700 private destination, with incremental count/hash and chunk-spanning
secret screening. No 8 MB limit, read-all Buffer or truncation applies to task files
or raw tar. `workspace/` holds byte-exact regular-file copies; `workspace.tar` holds
the byte-exact raw tar. No host extraction is performed, so source modes/xattrs and
empty directories remain in the tar rather than being applied to the host.

Every written file **and** raw tar is reread incrementally and checked against the
broker's declared length/SHA-256. A read-only Python 3 stdlib tar pass checks parsed
member paths/types/duplicates, archive termination, file-parent collisions and the
exact file inventory/hash correspondence. Only regular files/directories are
accepted; symlinks, hardlinks, traversal, unexpected files, secret paths and special
files refuse cleanup. Python `tarfile` resolves repeated PAX attributes; this does
**not** claim blanket rejection of every ambiguous original PAX header. The trusted
broker's fixed Docker-cp source and validated full export remain required.
Member `open()` identity/perms/size guards are not content verification: the
operations consumer's full incremental hash/length checks are mandatory.

Raw bytes and metadata, including escaped JSON quotes, xattr names/values and valid
base64 xattr encodings, receive content screening. Gzip, bzip2 and xz file/xattr
content is decoded in memory as streams and screened, including nested wrappers.
ZIP, 7z, RAR and zstd signatures currently refuse with `unsupported-content`; they
are not asserted secret-free. Decoding has a cumulative 1 GiB work budget and four
wrapper levels; tar validation has a five-minute timeout and 100,000-member bound.
Exceeding a bound fails the operation, never publishes a partial export. Plain
20 MiB files are supported and tested. Quoted credential-field names, private-key
markers, token prefixes and `Bearer` followed by whitespace refuse conservatively,
even when benign; the scanner retains only a bounded overlap, not full content.
This is still **not** proof that arbitrary binary, encoded/encrypted or unknown
credential formats contain no secrets. Keep credentials separate and output
owner-private; review the retained scope rather than relying on filenames alone.

`archive.json` format 2 retains task/environment/epoch, coordinator evidence,
per-file counts/hashes and the raw tar count/hash. It is committed only after the
written bytes and raw inventory verify. Bytes/inventory are verified again after
fresh inspection and before archive/destruction; coordinator/maintenance/epoch
checks remain mandatory. A failed export, corruption, changed reservation, stale
epoch, abort, uncertain removal or write never returns fake success.
`cleanup-result.json` exists only after the requested broker operations succeed.
Optional `CleanupOptions.signal` cancels consumption/verification; optional
`checkpoint(phase)` is a byte-free failure-injection seam (`created`, `copied`,
`before-archive`, `before-destroy`). Neither grants permission to stop live work.
Retain failed private output with its `INCOMPLETE.json`; retry only to a new root.

The broker hook is delivered. Existing real-Docker export evidence is
`~/.local/share/spatial-agent-workspace/environment-export-verification/<run id>/result.json`
(PASS: stopped private-volume 20 MiB export, empty file/directory, hashes and
negative ownership/link/active-state cases). Operations tests additionally bind
the actual broker owner API to a labelled fixture engine for 20 MiB metadata
preservation. That integration test is **not** a new Docker or live cleanup proof;
no existing volume is overwritten/destroyed by this rehearsal. There is no cleanup
CLI or shell volume-prune/live-state deletion command.

## Failure recovery and test evidence

Run this rehearsal and lint check from the source checkout with development dependencies installed. The rehearsal script and test sources are not shipped in the private host package:

```sh
node scripts/operation-rehearse.mjs
npx eslint host/src/operations.ts host/tests/operations.test.ts scripts/operation-*.mjs
```

The rehearsal compiles the targeted graph and runs actual Node SQLite operations
under new private `spatial-operations-FIXTURE-*` temporary roots. It covers complete
WAL history/Inbox/source identities, credential/lock exclusion, permanent descriptor
leases, concurrent legacy/SQLite drift, actual process interruption, failed restore,
compatible copies, reviewed v1→v2 migration, failing migration rollback, actual
SQLite `SQLITE_FULL`, revocation/newer work and archive refusal/destructor failures.
The stream integration adds 20 MiB actual-broker/fixture-engine consumption, raw
metadata retention, mismatched count/hash/truncated streams, raw inventory
corruption, chunk-boundary/escaped-quote/private-key secrets, compressed/xattr
screening, actual `wx` collision failure, abort/stream closure, stale epochs and
written-file/raw-tar/inventory changes before destruction.
Speech regressions use actual private SQLite journals provisioned **only once in
new labelled fixtures**, approved fixture price bounds, a temporary test credential
and fake fetch functions—never the network. They cover policy-unapproved refusal,
independent instances closed before capture, completed transcription/TTS replay,
uncertain acknowledgement and a process killed after durable reservation. Exact
policy/call records, digests, transcript and liabilities survive detached restore;
replay never pays again. Additional cases exercise a committed WAL liability without
source checkpoint, missing/mismatched identity, public/link storage, speech-only
rollback/restore drift, changed policy during backup, actual backup process death,
failed restore, injected disk-full phases, pair member tampering and written-byte
corruption before commit. The documented owner CLI is exercised with that same
private ledger: backup, verification, detached restore, unchanged rollback comparison,
retained transcript/killed-call replay with zero provider sends, and backup/restore/
rollback refusals for missing, stale, wrong-root or active-writer maintenance. A
missing sidecar restore leaves the sidecar absent and all source liabilities intact.
No recovery test provisions a lost/replacement journal.
The filesystem ENOSPC case is **injected**; it does not claim host disk exhaustion.
Worker-loss/remote uncertainty is represented by retained labelled coordinator
records, not an actual worker/provider crash. No existing factory state, provider,
Docker root or device is used. Commands exit nonzero on failure.

On disk-full/interruption: preserve current records and incomplete output, create
space only under separately approved retention rules, re-inventory and retry to a
new private destination. On host/worker loss: keep unknown effects and reservations,
use the coordinator's current reviewed recovery procedure, and do not retry unknown
work automatically. On credential revocation: refuse subsequent operations, keep
in-flight uncertainty and inspect current authority rather than importing old trust.
On failed restore/migration: retain hold and verified baseline, inspect detached
failure evidence; never replace live state merely to obtain a passing rehearsal.

These tests do not complete live setup, service supervision, live cleanup/cutover,
installed-device or full-release acceptance. The existing Docker export proof is
separate evidence, not a claim that all AC-6.2 or INV-G4/G6 gates pass. See [INSTALL.md](INSTALL.md) for the
remaining owner/provider/device gates.
