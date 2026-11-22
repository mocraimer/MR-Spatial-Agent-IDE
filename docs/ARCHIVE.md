# Product archive and history export

`WorkspaceStore` preserves product records. Archive removes destinations from the
normal snapshot; it does not cancel work, issue authority, stop containers, remove
volumes, or delete coordinator records/artifacts. HTTP and client wiring live outside
this store contract.

## Public methods

```ts
type ArchiveKind = 'project' | 'space' | 'task' | 'link';
interface ArchiveRecord { kind: ArchiveKind; entityId: string; archivedAt: string }
interface ArchiveReference {
  archiveId: string; fingerprint: string;
  product: { kind: 'project' | 'space' | 'task'; id: string };
}
interface ArchiveBinding extends ArchiveReference { kind: ArchiveKind; entityId: string }
interface ArchiveIntent {
  archiveId: string; product: ArchiveReference['product']; receivers: Receiver[];
  taskIds: string[]; runIds: string[]; createdAt: string;
}

listArchiveIntents(): ArchiveIntent[];
retainArchiveIntent(input: Omit<ArchiveIntent, 'createdAt'>): ArchiveIntent;
getArchiveBinding(kind: ArchiveKind, entityId: string): ArchiveBinding | null;
commitCoordinatedArchive(reference: ArchiveReference, commit: () => ArchiveRecord,
  trustedInput?: Omit<ArchiveIntent, 'createdAt'>): ArchiveRecord;
observeCoordinatedArchive(reference: ArchiveReference): ArchiveReference & { state: 'archived' | 'uncommitted' };
archiveProject(projectId: string): ArchiveRecord;
archiveSpace(spaceId: string): ArchiveRecord;
archiveTask(taskId: string): ArchiveRecord;
unlinkSpaceLink(linkId: string): ArchiveRecord;
listArchives(): ArchiveRecord[];
isArchived(kind: ArchiveKind, entityId: string): boolean;
assertDestinationAvailable(spaceId: string, taskId?: string | null): void;
archivedSnapshot(): Snapshot;
exportHistory(): WorkspaceHistoryExport;
checkpoint(): { busy: number; logFrames: number; checkpointedFrames: number };
```

Project archive includes its spaces/tasks. Space archive includes its nested spaces
and tasks. Both also unlink incident space links. Task archive includes delegated
descendants, even in sibling spaces; it does not archive those sibling spaces or
conversations. Overview cannot be archived. Archive a project instead of its root
space. Repeated archive/unlink returns the original tombstone without advancing the
revision. A successful operation stores all tombstones and one change event in one
SQLite transaction.

Unlink only removes the connection from normal snapshots. It does not affect work
at either endpoint. Calling `createLink` again with the original endpoints and label
restores the same link identity. A changed label refuses rather than overwriting
retained link data. Durable events retain unlink/reconnect revisions and timestamps.
Project, space, and task archives cannot be restored through this API.

## Refusal and effect boundaries

Archive refuses when affected history contains:

- submissions other than `settled` or `blocked`;
- tasks other than `completed`, `checks-failed`, `failed`, `cancelled`, or `stopped`;
- `pending`, `streaming`, or `uncertain` messages;
- open or deferred Inbox decisions.

Unknown task states refuse. A cancellation request is not a stopped task. A blocked
submission alone does not settle its task/messages. Resolve decisions and reconcile
actual effects first; archive never silently does either.

These checks cover product evidence, not independent coordinator reservations or
live environment state. `host/src/lifecycle.ts` uses the public owner-only coordinator
`interactiveArchive`, `interactiveArchiveLookup`, and `interactiveArchiveReconcile`
commands. Main installs it with the already verified selected build, private
state, registered operator, and existing reviewed activation, before inference-profile
or account-reader setup. Missing inference profiles/authentication do not remove a
verified archive cutoff reader. No live activation,
grant, inference, or credential changes are part of archive.

The host derives a stable `spatial-archive-<sha256>` identity from the exact product
kind/ID. It supplies every retained receiver, including archived delegated descendants
in sibling spaces, and derives known coordinator task/run IDs from product links plus
fresh public submission lookups. Unknown or missing known links refuse; offline
blocked, never-executed history may have zero runs. No synthetic run or grant is
needed. The coordinator checks its expanded terminal family and reservations under
its existing dispatch/run locks, durably writes a **prepared** cutoff before the
synchronous host callback, then records archived only after actual SQL observation.

`EnvironmentBroker.withInactive` is a trusted host-only port. It rejects active,
queued, transitioning, or uncertain environments before acquiring controls for all
affected tasks. It holds their environment/container/volume identities, generation,
and epoch through awaited actual `engine.verifyWorkspace` and the synchronous
coordinator/SQLite commit. Missing verification support or a missing retained
environment refuses. A changed generation invalidates the proof. This history-only
path never calls `stop`, `reset`, `capture`, `remove`, or `removeVolume`; stopped volumes stay
where they are. A product terminal label is not engine proof.

Inside the held inactivity callback, **before coordinator prepare**, the trusted
lifecycle retains an `archive_intents` row in a separate FULL-synchronous SQLite
transaction. It binds the stable archive ID, exact product root, full retained receiver
family, and task/run input. Retries must match all those fields. The row survives
callback failure, process death, restart, history export, and coordinated backup.
There is no client/owner Boolean, cancellation API, or failure cleanup that deletes it;
even an unacknowledged prepare is uncertain and stays closed until exact reconciliation.
The intent closes its receiver family, space descendants, and non-Overview ancestor
edits/new children. Overview is not an archivable family root; an unrelated new root
remains usable. Terminal reconciliation can update evidence, not replace provenance.

`commitCoordinatedArchive(reference, commit, trustedInput)` wraps root/descendant tombstones,
`archive_bindings`, one revision, and one event in **one** SQLite `BEGIN IMMEDIATE`.
The callback must synchronously archive the exact root; promises, conflicting roots,
and binding/write failures roll the entire transaction back. A retained intent can
be exempted only by its exact trusted receipt input, not a matching ID alone; other
overlapping pending intents still refuse. The lifecycle verifies the actual coordinator
receipt against that input before entering SQL. Each new destination
binding retains `{archiveId, fingerprint, product:{kind,id}}`; existing child
bindings and timestamps remain unchanged. `getArchiveBinding(kind,id)` reads that
durable binding. `observeCoordinatedArchive(reference)` freshly reads SQL and reports
`archived` only for the matching root binding/tombstone, otherwise `uncommitted`.

A killed or failed callback leaves the durable prepared coordinator cutoff closed.
The same owner archive request first reads SQL: a committed binding reconciles lost
acknowledgement without another tombstone; an uncommitted receipt can retry only the
same stable input after fresh held inactivity proof. It never restores admission or
generates a new archive ID. Voice capture/transcription, new turns, sources, frame,
input, and owner control use one shared receiver/family availability rule before effects.
When verification is unavailable (missing build, activation, config, reader, or changed
operator), the rule closes affected retained task/submission families, including
zero-run never-executed history. It does not infer safety from absent execution links
or globally deny unrelated empty roots. A pending intent always closes its family,
even if a reader reports no receipt. An actual matching coordinator receipt plus SQL
binding reconciles lost ACK without another tombstone. The retained intent remains
exported; after the matching atomic SQL commit, its temporary ancestor fence ends.
A task-only archive therefore leaves its parent space active, while the exact task
cutoff/tombstone remains irreversible.

New receiver validation, turns, task creation/delegation, settings, links, space
creation/moves/edits, and task layouts refuse archived destinations. Exact idempotent
submission/task replays can still return retained settled identities; execution must
not redispatch these. Effectful service routes must call
`assertDestinationAvailable`, including after awaited work, rather than checking
only `getTask`/`getSpace` existence. Reconciliation may still update retained evidence;
getters remain readable deliberately.

`StoreError` keeps the existing codes:

| Code | Meaning / recovery |
| --- | --- |
| `not_found` | Missing stable ID; reload current destinations/history. |
| `invalid` | Overview/root archive or malformed/cross-space destination; archive the project or correct the request. |
| `conflict` | Archived destination, unfinished/uncertain work, unresolved decision, conflicting reconnect, or busy checkpoint; inspect current evidence and retry only after the stated condition changes. |

Failures roll back tombstones/bindings atomically. Once retained before prepare,
the intent and its own revision/event remain even if prepare or its SQL callback fails. Storage failures
propagate; the service must return a useful failure instead of claiming success.

## History, removed destinations and export

Normal `snapshot()` excludes archived projects/spaces/tasks, their conversations,
and unlinked links. Answered Inbox requests keep their original destination IDs;
clients must show that the destination was removed, offer archived history or a
current destination chosen by the owner, and never silently jump elsewhere.

Existing getters, `listMessages`, Inbox versions, and decisions retain stable IDs and
full history. `archivedSnapshot()` includes **all** retained destinations, not just
archived ones; it keeps the standard 50-message snapshot bound. Use `listArchives()`
to distinguish removed records.

`exportHistory()` reads one consistent SQLite transaction and returns schema version
3, protocol version, revision, timestamp, all projects/spaces/tasks/links,
conversation records, **all** messages, submissions, Inbox requests/versions,
decisions, archive tombstones, coordinator archive bindings, and retained archive intents,
registered sources and change events. Source text and
provenance are complete, including sources in archived spaces. Messages are in the separate full
`messages` array, not copied into conversation records. Export has no pagination
limit. It preserves evidence references, coordinator/run/environment IDs, and layouts.
Referenced coordinator files and task-volume contents must be backed up separately;
this JSON is neither a coordinator backup nor a restore/activation command.

Export is sensitive owner history, not diagnostics or model context. Restrict it to
authenticated owner operations and private files. Do not send the all-project export
to task tools, models, or public logs. Provider credentials are not store fields;
user-authored conversation content is preserved, not silently redacted.

## Schema and checkpoint

Schema 1 migrates transactionally to schema 2 by adding `archives` and `sources`;
existing records, keys, and revision remain unchanged. This unreleased schema-2 branch
also adds `sources` and `archive_bindings` when opening an earlier schema-2 database
without those tables; it never resets history or increments the revision for the
additive migration.
Schema 1/2 now migrates transactionally to schema 3 by adding `archive_intents`;
existing history/revision stays unchanged. The operations capture/verification allowlist
accepts schema 3 and requires this table; complete backup and detached restore preserve
pending attempts. Future versions refuse before journal/schema changes. Interrupted migration rolls back and can be retried. Stop incompatible
schema-1 writers before cutover; they cannot safely write archived receivers.

`checkpoint()` requests SQLite `wal_checkpoint(FULL)`. Busy checkpoints throw
`conflict`. A successful checkpoint does not lock out future writes or provide a
consistent product/coordinator backup on its own. Operations must quiesce all writers
and follow coordinated backup/activation controls before copying state. Never copy
only a live main database file or overwrite live state to test restore.

## Owner-uploaded project sources

Sources are selected text files or pasted notes, not filesystem connectors. Only the
authenticated owner upload surface may call registration; no model-facing upload or
implicit profile/secret discovery exists. The store reads no files and interprets no
paths, provenance, or source text as commands. All source fields, including names and
provenance, remain untrusted context data; they cannot grant authority, select a
receiver, or invoke owner navigation.

```ts
export const MAX_SOURCE_BYTES = 1048576;
interface RegisterSourceInput {
  spaceId: string; name: string; text: string; provenance: string;
}
interface SourceMetadata {
  id: string; spaceId: string; name: string; provenance: string;
  sha256: string; byteLength: number; createdAt: string;
}
interface RegisteredSource extends SourceMetadata { text: string }

registerSource(input: RegisterSourceInput): SourceMetadata;
listSources(spaceId: string): SourceMetadata[];
readSourceForSpace(spaceId: string, sourceId: string): RegisteredSource;
```

Registration requires a nonempty name and provenance string and preserves their
literal values. Text may be empty but cannot exceed 1 MiB in **UTF-8 bytes**. The
`sha256` field hashes those UTF-8 text bytes, not the original file's encoding or raw
upload wrapper. No business examples or sources are seeded. Each upload gets a new
stable ID; existing source records are never overwritten. Successful registration
and its `source.registered` event commit atomically.

Listing returns metadata only, ordered from the selected space to its ancestors,
then by registration order within each space. Reading returns one complete bounded
text with its metadata/hash/provenance. Both use a consistent SQLite read transaction.
They include only the selected space and its same-project ancestors and stop before
Overview or a different project. They never include siblings, descendants, linked
projects, or whole-project conversations. Sources registered directly in Overview
stay local to Overview. Moving a space changes its inherited sources without copying
or deleting any records.

An archived space refuses registration, listing, and source reads with `conflict`.
Missing spaces give `not_found`. A missing or out-of-scope source ID also gives
`not_found`, without returning cross-project metadata. Invalid fields or oversized
text give `invalid` and leave the revision/data unchanged. Archived source history
remains available only through authenticated owner export, not task retrieval.

The source methods bind a **space**, not a task/conversation. Runtime tools must keep
the admitted receiver fixed, validate that receiver and current conversation authority
before and after each context/source read, and refuse an archived task even if its
space remains active. Source text must stay inside an untrusted-data result rather
than become owner/system instructions. HTTP upload must bound the request body and
use explicit owner-selected text; registration adds no coordinator permissions or
execution effects.

## Offline verification

Run these checks from the source checkout with development dependencies installed. Test sources and the Docker lifecycle rehearsal script are not shipped in the private host package:

```sh
npm run typecheck
npm run build
node --test build/host/tests/store.test.js
npx eslint host/src/store.ts host/tests/store.test.ts
```

Tests use actual private temporary SQLite stores, separate connections/processes,
SQLITE_FULL injection, restart, interrupted migration, and write rollback. Lifecycle
HTTP tests cover zero-run prepare, failed SQL and SIGKILL, restart without a reader,
pre-STT voice refusal, source/control refusal, ancestor/new-child closure, unrelated
empty local flows, and original tombstone reconciliation. The lifecycle test engine
is a memory fixture, not Docker acceptance evidence. Main composition tests use a
labelled activation/lookup stub, not coordinator proof.

`node scripts/lifecycle-verify.mjs` separately uses the **actual Docker engine**, actual
public coordinator commands in isolated test state, and real SQLite. It holds
`withInactive` through prepare and SQL commit. Scheduling gates delay only ACKs;
stopped PID 0, exact labels/identities, and sole-volume-consumer checks are real. It
refuses a pending queue after actual stop, changed retained identity/generation, and
an extra test-owned stopped consumer. It checks all-task fences through verification
and callback failure, restart without a reader, retained source/history/workspace
bytes and same-ID reconciliation. Its result includes exact test-owned container and
volume IDs and verifies their absence after cleanup; it never prunes or selects
resources by a prefix. The older export rehearsal alone is not held-lifecycle proof.
Neither path makes live grants, provider/account changes, cutover, or headset claims.
