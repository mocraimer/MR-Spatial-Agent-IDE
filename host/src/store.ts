import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import {
  PROTOCOL_VERSION, type Conversation, type DelegationOrigin, type InboxRequest, type Message, type Point,
  type Project, type Receiver, type Snapshot, type Space, type SpaceLink,
  type TaskWindow, type WindowLayout,
} from './protocol.js';

export type SubmissionState = 'queued' | 'submitting' | 'submitted' | 'uncertain' | 'settled' | 'blocked';
export interface Submission {
  id: string;
  idempotencyKey: string;
  kind: 'turn' | 'task';
  receiver: Receiver;
  text: string;
  messageId: string;
  state: SubmissionState;
  runtime: string;
  model: string;
  effort: string;
  coordinatorTaskId: string | null;
  runId: string | null;
  detail: string;
  createdAt: string;
  updatedAt: string;
}
export interface CreateTaskInput {
  idempotencyKey: string;
  spaceId: string;
  title: string;
  prompt: string;
  runtime: string;
  model: string;
  effort: string;
  parentTaskId?: string | null;
  /** Trusted bridge authorship only; absent for authenticated owner creation, even with a parent task. */
  origin?: DelegationOrigin;
}
export interface MessagePage { messages: Message[]; nextBefore: string | null }
export type InboxAction = 'answer' | 'approve' | 'review' | 'defer' | 'dismiss';
export interface InboxDecision {
  id: string;
  requestId: string;
  version: number;
  action: InboxAction;
  ownerReceipt?: import('./runtime-coordinator.js').AuthorityConfirmationReceipt;
  text: string;
  createdAt: string;
}
export interface StoreEvent { revision: number; kind: string; entityId: string; createdAt: string }
export type ArchiveKind = 'project' | 'space' | 'task' | 'link';
export interface ArchiveRecord { kind: ArchiveKind; entityId: string; archivedAt: string }
export interface ArchiveReference {
  archiveId: string;
  fingerprint: string;
  product: { kind: Exclude<ArchiveKind, 'link'>; id: string };
}
export interface ArchiveBinding extends ArchiveReference { kind: ArchiveKind; entityId: string }
/** Trusted lifecycle input retained BEFORE coordinator prepare; never a browser/owner Boolean. */
export interface ArchiveIntent {
  archiveId: string;
  product: ArchiveReference['product'];
  receivers: Receiver[];
  taskIds: string[];
  runIds: string[];
  createdAt: string;
}
export const MAX_SOURCE_BYTES = 1024 * 1024;
export interface SourceMetadata {
  id: string;
  spaceId: string;
  name: string;
  provenance: string;
  sha256: string;
  byteLength: number;
  createdAt: string;
}
/** Owner-uploaded text is untrusted context data, never an owner action or filesystem path. */
export interface RegisteredSource extends SourceMetadata { text: string }
export interface RegisterSourceInput { spaceId: string; name: string; text: string; provenance: string }
/** Full owner-only product history; referenced coordinator evidence and task files are not copied. */
export interface WorkspaceHistoryExport {
  schemaVersion: 3;
  protocolVersion: number;
  revision: number;
  capturedAt: string;
  projects: Project[];
  spaces: Space[];
  tasks: TaskWindow[];
  links: SpaceLink[];
  conversations: Conversation[];
  messages: Message[];
  submissions: Submission[];
  inbox: InboxRequest[];
  inboxVersions: InboxRequest[];
  decisions: InboxDecision[];
  archives: ArchiveRecord[];
  archiveBindings: ArchiveBinding[];
  archiveIntents: ArchiveIntent[];
  events: StoreEvent[];
  sources: RegisteredSource[];
  voiceIntents: VoiceIntent[];
}
export interface VoiceIntent { idempotencyKey: string; receiver: Receiver; wavSha256: string; createdAt: string }
export interface CheckpointResult { busy: number; logFrames: number; checkpointedFrames: number }
export class StoreError extends Error {
  constructor(public readonly code: 'not_found' | 'invalid' | 'conflict' | 'stale', message: string) {
    super(message);
    this.name = 'StoreError';
  }
}

type Records = {
  projects: Project; spaces: Space; conversations: Conversation; tasks: TaskWindow;
  links: SpaceLink; messages: Message; submissions: Submission; inbox: InboxRequest;
  decisions: InboxDecision; sources: RegisteredSource;
};
type Table = keyof Records;
type Mutation<T> = { value: T; entityId: string; changed?: boolean };
const archiveIntentKey = (value: Omit<ArchiveIntent, 'createdAt'>): string => JSON.stringify([value.archiveId, value.product.kind, value.product.id,
  value.receivers.map(receiver => JSON.stringify([receiver.spaceId, receiver.conversationId, receiver.taskId])).sort(),
  [...value.taskIds].sort(), [...value.runIds].sort()]);
const now = (): string => new Date().toISOString();
const id = (): string => randomUUID();
function fail(code: StoreError['code'], message: string): never { throw new StoreError(code, message); }
function nonempty(value: string, field: string): void {
  if (typeof value !== 'string' || !value.trim()) fail('invalid', `${field} must not be empty`);
}
function strings(values: Record<string, string>): void {
  for (const [field, value] of Object.entries(values)) {
    if (typeof value !== 'string') fail('invalid', `${field} must be a string`);
  }
}
function point(value: Point): void {
  if (!value || ![value.x, value.y, value.z].every(Number.isFinite)) fail('invalid', 'Position, rotation and scale must be finite');
}
function layout(value: WindowLayout): void {
  if (!value) fail('invalid', 'Layout is required');
  point(value.position); point(value.rotation); point(value.scale);
  if ([value.scale.x, value.scale.y, value.scale.z].some(v => v <= 0)) fail('invalid', 'Layout scale must be positive');
}
function pageLimit(value: number | undefined, defaultValue: number): number {
  const limit = value ?? defaultValue;
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) fail('invalid', 'Page limit must be an integer from 1 to 500');
  return limit;
}

/** Product history and outbox only. Admission, permissions and execution remain coordinator-owned. */
export class WorkspaceStore {
  private readonly db: DatabaseSync;
  private readonly listeners = new Set<(revision: number) => void>();
  private coordinatedArchive: ArchiveReference | null = null;

  constructor(databasePath: string) {
    this.db = new DatabaseSync(databasePath);
    try {
      this.db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
      const version = this.db.prepare('PRAGMA user_version').get()?.['user_version'];
      if (version !== 0 && version !== 1 && version !== 2 && version !== 3) throw new Error(`Unsupported workspace database version: ${String(version)}`);
      this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
      this.db.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE IF NOT EXISTS metadata (id INTEGER PRIMARY KEY CHECK(id = 1), revision INTEGER NOT NULL);
        INSERT OR IGNORE INTO metadata VALUES (1, 0);
        CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, data TEXT NOT NULL,
          root_space_id TEXT NOT NULL UNIQUE REFERENCES spaces(id) DEFERRABLE INITIALLY DEFERRED);
        CREATE TABLE IF NOT EXISTS spaces (id TEXT PRIMARY KEY, data TEXT NOT NULL,
          project_id TEXT REFERENCES projects(id) DEFERRABLE INITIALLY DEFERRED,
          parent_id TEXT REFERENCES spaces(id),
          conversation_id TEXT NOT NULL UNIQUE REFERENCES conversations(id) DEFERRABLE INITIALLY DEFERRED);
        CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, data TEXT NOT NULL,
          space_id TEXT NOT NULL REFERENCES spaces(id) DEFERRABLE INITIALLY DEFERRED,
          task_id TEXT UNIQUE REFERENCES tasks(id) DEFERRABLE INITIALLY DEFERRED);
        CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, data TEXT NOT NULL,
          space_id TEXT NOT NULL REFERENCES spaces(id),
          conversation_id TEXT NOT NULL UNIQUE REFERENCES conversations(id) DEFERRABLE INITIALLY DEFERRED,
          parent_task_id TEXT REFERENCES tasks(id));
        CREATE TABLE IF NOT EXISTS links (id TEXT PRIMARY KEY, data TEXT NOT NULL,
          from_id TEXT NOT NULL REFERENCES spaces(id), to_id TEXT NOT NULL REFERENCES spaces(id),
          UNIQUE(from_id, to_id));
        CREATE TABLE IF NOT EXISTS submissions (id TEXT PRIMARY KEY, data TEXT NOT NULL,
          idempotency_key TEXT NOT NULL UNIQUE, fingerprint TEXT NOT NULL,
          conversation_id TEXT NOT NULL REFERENCES conversations(id),
          message_id TEXT NOT NULL UNIQUE REFERENCES messages(id) DEFERRABLE INITIALLY DEFERRED);
        CREATE TABLE IF NOT EXISTS messages (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
          data TEXT NOT NULL, conversation_id TEXT NOT NULL REFERENCES conversations(id),
          request_id TEXT REFERENCES submissions(id) DEFERRABLE INITIALLY DEFERRED);
        CREATE INDEX IF NOT EXISTS message_history ON messages(conversation_id, seq);
        CREATE TABLE IF NOT EXISTS inbox (id TEXT PRIMARY KEY, data TEXT NOT NULL,
          space_id TEXT NOT NULL REFERENCES spaces(id), task_id TEXT REFERENCES tasks(id));
        CREATE TABLE IF NOT EXISTS inbox_versions (request_id TEXT NOT NULL REFERENCES inbox(id),
          version INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(request_id, version));
        INSERT OR IGNORE INTO inbox_versions SELECT id, json_extract(data, '$.version'), data FROM inbox;
        CREATE TABLE IF NOT EXISTS decisions (id TEXT PRIMARY KEY, data TEXT NOT NULL,
          request_id TEXT NOT NULL REFERENCES inbox(id));
        CREATE TABLE IF NOT EXISTS events (revision INTEGER PRIMARY KEY, kind TEXT NOT NULL,
          entity_id TEXT NOT NULL, created_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS archives (kind TEXT NOT NULL CHECK(kind IN ('project', 'space', 'task', 'link')),
          entity_id TEXT NOT NULL, archived_at TEXT NOT NULL, PRIMARY KEY(kind, entity_id));
        CREATE TABLE IF NOT EXISTS archive_bindings (kind TEXT NOT NULL, entity_id TEXT NOT NULL,
          archive_id TEXT NOT NULL, fingerprint TEXT NOT NULL, product_kind TEXT NOT NULL, product_id TEXT NOT NULL,
          PRIMARY KEY(kind, entity_id), FOREIGN KEY(kind, entity_id) REFERENCES archives(kind, entity_id));
        CREATE TABLE IF NOT EXISTS archive_intents (archive_id TEXT PRIMARY KEY, data TEXT NOT NULL,
          product_kind TEXT NOT NULL, product_id TEXT NOT NULL, UNIQUE(product_kind, product_id));
        CREATE TABLE IF NOT EXISTS sources (id TEXT PRIMARY KEY, data TEXT NOT NULL,
          space_id TEXT NOT NULL REFERENCES spaces(id));
        CREATE INDEX IF NOT EXISTS source_context ON sources(space_id);
        CREATE TABLE IF NOT EXISTS voice_intents (idempotency_key TEXT PRIMARY KEY, data TEXT NOT NULL,
          conversation_id TEXT NOT NULL REFERENCES conversations(id));
        PRAGMA user_version = 3;
        COMMIT;
      `);
      this.write('initialized', () => {
        if (this.find('spaces', 'overview')) return { value: undefined, entityId: 'overview', changed: false };
        const space: Space = { id: 'overview', projectId: null, parentId: null, name: 'Overview', purpose: '',
          conversationId: 'conversation-overview', position: { x: 0, y: 0, z: 0 } };
        this.insert('spaces', space, { project_id: null, parent_id: null, conversation_id: space.conversationId });
        this.insertConversation(space.conversationId, space.id, null, { runtime: '', model: '', effort: '' });
        return { value: undefined, entityId: space.id };
      });
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      this.db.close();
      throw error;
    }
  }

  close(): void { this.listeners.clear(); this.db.close(); }
  get revision(): number { return Number(this.db.prepare('SELECT revision FROM metadata WHERE id = 1').get()?.['revision']); }
  subscribe(listener: (revision: number) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  eventsAfter(revision: number, limit = 100): StoreEvent[] {
    if (!Number.isSafeInteger(revision) || revision < 0) fail('invalid', 'Revision must be a nonnegative integer');
    const rows = this.db.prepare('SELECT revision, kind, entity_id, created_at FROM events WHERE revision > ? ORDER BY revision LIMIT ?')
      .all(revision, pageLimit(limit, 100));
    return rows.map(row => ({ revision: Number(row['revision']), kind: String(row['kind']),
      entityId: String(row['entity_id']), createdAt: String(row['created_at']) }));
  }

  snapshot(): Snapshot { return this.readSnapshot(false); }
  /** Explicit inspection only: includes archived destinations, with the usual recent-message bound. */
  archivedSnapshot(): Snapshot { return this.readSnapshot(true); }

  private readSnapshot(includeArchived: boolean): Snapshot {
    return this.readConsistent(() => {
      const archives = this.listArchives();
      const visible = (kind: ArchiveKind, entityId: string): boolean => includeArchived ||
        !archives.some(record => record.kind === kind && record.entityId === entityId);
      const projects = this.all('projects').filter(project => visible('project', project.id));
      const spaces = this.all('spaces').filter(space => visible('space', space.id));
      const tasks = this.all('tasks').filter(task => visible('task', task.id));
      const spaceIds = new Set(spaces.map(space => space.id));
      const taskIds = new Set(tasks.map(task => task.id));
      return {
        protocolVersion: PROTOCOL_VERSION, revision: this.revision, capturedAt: now(), projects, spaces, tasks,
        links: this.all('links').filter(link => visible('link', link.id) && spaceIds.has(link.fromId) && spaceIds.has(link.toId)),
        conversations: this.all('conversations').filter(conversation => spaceIds.has(conversation.spaceId) &&
          (conversation.taskId === null || taskIds.has(conversation.taskId))).map(conversation => ({ ...conversation,
          messages: this.listMessages(conversation.id, { limit: 50 }).messages })),
        // Keep answered requests and their exact removed destinations for Inbox history/recovery.
        inbox: this.all('inbox'), views: [], readiness: [],
      };
    });
  }

  listArchives(): ArchiveRecord[] {
    return this.db.prepare('SELECT kind, entity_id, archived_at FROM archives ORDER BY rowid').all()
      .map(row => ({ kind: String(row['kind']) as ArchiveKind, entityId: String(row['entity_id']), archivedAt: String(row['archived_at']) }));
  }
  isArchived(kind: ArchiveKind, entityId: string): boolean {
    this.requireArchiveEntity(kind, entityId);
    return !!this.db.prepare('SELECT 1 FROM archives WHERE kind = ? AND entity_id = ?').get(kind, entityId);
  }
  /** Getters retain history; effectful routes must use this guard, not existence alone. */
  assertDestinationAvailable(spaceId: string, taskId: string | null = null): void {
    this.assertNotArchived('space', spaceId);
    if (taskId !== null) {
      this.assertNotArchived('task', taskId);
      if (this.getTask(taskId).spaceId !== spaceId) fail('invalid', 'Task belongs to another space');
    }
    for (const intent of this.listArchiveIntents()) {
      // Keep the intent as history. Only a matching committed SQL binding ends its pending-family fence.
      const binding = this.getArchiveBinding(intent.product.kind, intent.product.id);
      if (binding?.archiveId === intent.archiveId && this.observeCoordinatedArchive(binding).state === 'archived') continue;
      if (this.receiversAffectDestination(intent.receivers, spaceId, taskId)) {
        fail('conflict', 'Destination has a retained archive attempt/cutoff; reconcile exact coordinator receipt and SQL before new effects.');
      }
    }
  }

  /** Family overlap, not execution-link inference. Overview is not an archivable family root. */
  receiversAffectDestination(receivers: readonly Receiver[], spaceId: string, taskId: string | null): boolean {
    const spaceAncestors = (id: string): Set<string> => {
      const ancestors = new Set<string>();
      for (let current = this.getSpace(id); current.id !== 'overview'; current = this.getSpace(current.parentId!)) {
        if (ancestors.has(current.id)) fail('conflict', 'Space ancestry has a cycle');
        ancestors.add(current.id);
        if (current.parentId === null) break;
      }
      return ancestors;
    };
    const taskAncestors = (id: string): Set<string> => {
      const ancestors = new Set<string>();
      for (let current = this.getTask(id);;) {
        if (ancestors.has(current.id)) fail('conflict', 'Task ancestry has a cycle');
        ancestors.add(current.id);
        if (!current.parentTaskId) break;
        current = this.getTask(current.parentTaskId);
      }
      return ancestors;
    };
    const ancestors = spaceAncestors(spaceId);
    return receivers.some(receiver => {
      // A space cutoff closes its entire subtree, including future task receivers.
      if (receiver.taskId === null && ancestors.has(receiver.spaceId)) return true;
      // Ancestor space edits/new children cannot change a retained family. Other roots stay open.
      if (taskId === null && spaceId !== 'overview' && spaceAncestors(receiver.spaceId).has(spaceId)) return true;
      if (taskId !== null && receiver.taskId !== null) {
        return taskAncestors(taskId).has(receiver.taskId) || taskAncestors(receiver.taskId).has(taskId);
      }
      return false;
    });
  }

  listArchiveIntents(): ArchiveIntent[] {
    return this.db.prepare('SELECT data FROM archive_intents ORDER BY rowid').all().map(row => JSON.parse(String(row['data'])) as ArchiveIntent);
  }
  retainArchiveIntent(input: Omit<ArchiveIntent, 'createdAt'>): ArchiveIntent {
    return this.write('archive.intent', () => {
      this.requireArchiveEntity(input.product.kind, input.product.id);
      const existing = this.listArchiveIntents().find(intent => intent.archiveId === input.archiveId ||
        (intent.product.kind === input.product.kind && intent.product.id === input.product.id));
      if (existing) {
        if (archiveIntentKey(existing) !== archiveIntentKey(input)) fail('conflict', 'Archive attempt must retain its exact trusted input');
        return { value: existing, entityId: input.product.id, changed: false };
      }
      for (const receiver of input.receivers) this.validateReceiver(receiver);
      const intent = { ...structuredClone(input), createdAt: now() };
      this.db.prepare('INSERT INTO archive_intents VALUES (?, ?, ?, ?)').run(input.archiveId, JSON.stringify(intent), input.product.kind, input.product.id);
      return { value: intent, entityId: input.product.id };
    });
  }

  getArchiveBinding(kind: ArchiveKind, entityId: string): ArchiveBinding | null {
    return this.listArchiveBindings().find(binding => binding.kind === kind && binding.entityId === entityId) ?? null;
  }
  private listArchiveBindings(): ArchiveBinding[] {
    return this.db.prepare('SELECT * FROM archive_bindings ORDER BY rowid').all().map(row => ({
      kind: String(row['kind']) as ArchiveKind, entityId: String(row['entity_id']),
      archiveId: String(row['archive_id']), fingerprint: String(row['fingerprint']),
      product: { kind: String(row['product_kind']) as ArchiveReference['product']['kind'], id: String(row['product_id']) },
    }));
  }
  /** Fresh SQL observation, never a cached receipt or client-provided commit boolean. */
  observeCoordinatedArchive(reference: ArchiveReference): ArchiveReference & { state: 'archived' | 'uncommitted' } {
    return this.readConsistent(() => {
      const binding = this.getArchiveBinding(reference.product.kind, reference.product.id);
      if (binding && (binding.archiveId !== reference.archiveId || binding.fingerprint !== reference.fingerprint ||
        binding.product.kind !== reference.product.kind || binding.product.id !== reference.product.id)) {
        fail('conflict', 'Archive SQL binding differs from the coordinator receipt');
      }
      return { ...reference, state: binding && this.isArchived(binding.kind, binding.entityId) ? 'archived' : 'uncommitted' };
    });
  }
  /** The root tombstone, descendants, durable binding, revision and event share one BEGIN IMMEDIATE. */
  commitCoordinatedArchive(reference: ArchiveReference, commit: () => ArchiveRecord, trustedInput?: Omit<ArchiveIntent, 'createdAt'>): ArchiveRecord {
    nonempty(reference.archiveId, 'Archive ID');
    if (!/^[a-f0-9]{64}$/.test(reference.fingerprint)) fail('invalid', 'Archive fingerprint must be a SHA-256 digest');
    if (commit.constructor.name === 'AsyncFunction') fail('invalid', 'Archive SQL callback must be synchronous');
    if (this.coordinatedArchive) fail('conflict', 'Archive SQL commit is already in progress');
    return this.write('archive.coordinated', () => {
      const intent = this.listArchiveIntents().find(item => item.product.kind === reference.product.kind && item.product.id === reference.product.id);
      if (intent) {
        if (!trustedInput || trustedInput.archiveId !== reference.archiveId || trustedInput.product.kind !== reference.product.kind || trustedInput.product.id !== reference.product.id) {
          fail('conflict', 'Archive SQL requires the exact trusted receipt input for its retained intent');
        }
        if (archiveIntentKey(intent) !== archiveIntentKey(trustedInput)) fail('conflict', 'Archive receipt input differs from retained intent');
      }
      if (this.observeCoordinatedArchive(reference).state === 'archived') {
        return { value: this.listArchives().find(record => record.kind === reference.product.kind && record.entityId === reference.product.id)!,
          entityId: reference.product.id, changed: false };
      }
      if (this.isArchived(reference.product.kind, reference.product.id)) fail('conflict', 'Existing root tombstone has no matching coordinator binding');
      const before = new Set(this.listArchives().map(record => `${record.kind}:${record.entityId}`));
      this.coordinatedArchive = structuredClone(reference);
      let record: ArchiveRecord;
      try { record = commit(); } finally { this.coordinatedArchive = null; }
      if (record && typeof record === 'object' && 'then' in record) {
        void Promise.resolve(record).catch(() => undefined);
        fail('invalid', 'Archive SQL callback returned a promise');
      }
      if (!record || record.kind !== reference.product.kind || record.entityId !== reference.product.id || !this.isArchived(record.kind, record.entityId)) {
        fail('conflict', 'Archive SQL callback did not commit the exact product root');
      }
      for (const tombstone of this.listArchives()) if (!before.has(`${tombstone.kind}:${tombstone.entityId}`)) {
        this.db.prepare('INSERT INTO archive_bindings VALUES (?, ?, ?, ?, ?, ?)').run(tombstone.kind, tombstone.entityId,
          reference.archiveId, reference.fingerprint, reference.product.kind, reference.product.id);
      }
      return { value: record, entityId: record.entityId };
    });
  }

  archiveProject(projectId: string): ArchiveRecord {
    return this.archive('project', projectId);
  }
  archiveSpace(spaceId: string): ArchiveRecord {
    return this.archive('space', spaceId);
  }
  archiveTask(taskId: string): ArchiveRecord {
    return this.archive('task', taskId);
  }
  /** Unlink is a retained tombstone, not deletion of the link or either space. */
  unlinkSpaceLink(linkId: string): ArchiveRecord {
    return this.archive('link', linkId);
  }

  /** One SQLite read transaction, no snapshot pagination/truncation and no model/provider calls. */
  exportHistory(): WorkspaceHistoryExport {
    return this.readConsistent(() => ({
      schemaVersion: 3, protocolVersion: PROTOCOL_VERSION, revision: this.revision, capturedAt: now(),
      projects: this.all('projects'), spaces: this.all('spaces'), tasks: this.all('tasks'), links: this.all('links'),
      conversations: this.all('conversations'), messages: this.all('messages'), submissions: this.all('submissions'),
      inbox: this.all('inbox'), decisions: this.all('decisions'), archives: this.listArchives(), archiveBindings: this.listArchiveBindings(), archiveIntents: this.listArchiveIntents(),
      inboxVersions: this.db.prepare('SELECT data FROM inbox_versions ORDER BY rowid').all()
        .map(row => JSON.parse(String(row['data'])) as InboxRequest),
      events: this.readEvents(), sources: this.all('sources'),
      voiceIntents: this.db.prepare('SELECT data FROM voice_intents ORDER BY rowid').all().map(row => JSON.parse(String(row['data'])) as VoiceIntent),
    }));
  }
  /** Flush WAL only; callers must quiesce all writers before copying/activating a backup. */
  checkpoint(): CheckpointResult {
    const row = this.db.prepare('PRAGMA wal_checkpoint(FULL)').get();
    const result = { busy: Number(row?.['busy']), logFrames: Number(row?.['log']), checkpointedFrames: Number(row?.['checkpointed']) };
    if (result.busy !== 0) fail('conflict', 'Workspace checkpoint is busy; quiesce all readers/writers and retry before copying the database');
    return result;
  }

  /** Authenticated owner registration only; no file/profile discovery or model-facing upload. */
  registerSource(input: RegisterSourceInput): SourceMetadata {
    nonempty(input.name, 'Source name'); nonempty(input.provenance, 'Source provenance');
    strings({ text: input.text });
    const byteLength = Buffer.byteLength(input.text, 'utf8');
    if (byteLength > MAX_SOURCE_BYTES) fail('invalid', 'Source text exceeds 1 MiB of UTF-8 data; select a smaller text file or note');
    return this.write('source.registered', () => {
      this.assertDestinationAvailable(input.spaceId);
      const source: RegisteredSource = { id: id(), spaceId: input.spaceId, name: input.name, text: input.text,
        provenance: input.provenance, sha256: createHash('sha256').update(input.text, 'utf8').digest('hex'),
        byteLength, createdAt: now() };
      this.insert('sources', source, { space_id: source.spaceId });
      const { text: _text, ...metadata } = source;
      return { value: metadata, entityId: source.id };
    });
  }
  /** Metadata only, nearest space first. No sibling/project-wide transcripts are included. */
  listSources(spaceId: string): SourceMetadata[] {
    return this.readConsistent(() => [...this.sourceSpaceIds(spaceId)].flatMap(ancestorId =>
      this.db.prepare("SELECT json_remove(data, '$.text') AS data FROM sources WHERE space_id = ? ORDER BY rowid").all(ancestorId)
        .map(row => JSON.parse(String(row['data'])) as SourceMetadata)));
  }
  readSourceForSpace(spaceId: string, sourceId: string): RegisteredSource {
    return this.readConsistent(() => {
      const allowedSpaces = this.sourceSpaceIds(spaceId);
      // Check scope in SQL before loading content; invisible IDs look like missing IDs.
      for (const ancestorId of allowedSpaces) {
        const row = this.db.prepare('SELECT data FROM sources WHERE id = ? AND space_id = ?').get(sourceId, ancestorId);
        if (row) return JSON.parse(String(row['data'])) as RegisteredSource;
      }
      return fail('not_found', 'Source is not available in this space or its same-project ancestors; list current sources and select a visible ID');
    });
  }
  private sourceSpaceIds(spaceId: string): Set<string> {
    const space = this.getSpace(spaceId);
    const allowed = new Set<string>();
    let current = space;
    while (true) {
      this.assertDestinationAvailable(current.id);
      if (allowed.has(current.id)) fail('invalid', 'Source ancestry has a cycle; repair the space hierarchy');
      allowed.add(current.id);
      if (current.parentId === null || current.parentId === 'overview') break;
      const parent = this.getSpace(current.parentId);
      if (parent.projectId !== space.projectId) break;
      current = parent;
    }
    return allowed;
  }

  getProject(projectId: string): Project { return this.require('projects', projectId); }
  getSpace(spaceId: string): Space { return this.require('spaces', spaceId); }
  getTask(taskId: string): TaskWindow { return this.require('tasks', taskId); }
  getConversation(conversationId: string): Conversation {
    const conversation = this.require('conversations', conversationId);
    return { ...conversation, messages: this.listMessages(conversationId, { limit: 50 }).messages };
  }

  createProject(input: { name: string; purpose: string }): Project {
    nonempty(input.name, 'Project name'); strings({ purpose: input.purpose });
    return this.write('project.created', () => {
      const project: Project = { id: id(), name: input.name, purpose: input.purpose, rootSpaceId: id() };
      const space: Space = { id: project.rootSpaceId, projectId: project.id, parentId: 'overview',
        name: input.name, purpose: input.purpose, conversationId: id(), position: { x: 0, y: 0, z: 0 } };
      this.insert('projects', project, { root_space_id: space.id });
      this.insert('spaces', space, { project_id: project.id, parent_id: space.parentId, conversation_id: space.conversationId });
      this.insertConversation(space.conversationId, space.id, null, { runtime: '', model: '', effort: '' });
      return { value: project, entityId: project.id };
    });
  }
  updateProject(projectId: string, patch: Partial<Pick<Project, 'name' | 'purpose'>>): Project {
    return this.write('project.updated', () => {
      this.assertNotArchived('project', projectId);
      const project = this.require('projects', projectId);
      this.assertDestinationAvailable(project.rootSpaceId);
      if (patch.name !== undefined) nonempty(patch.name, 'Project name');
      if (patch.purpose !== undefined) strings({ purpose: patch.purpose });
      const updated = { ...project, name: patch.name ?? project.name, purpose: patch.purpose ?? project.purpose };
      this.replace('projects', updated);
      const root = this.getSpace(project.rootSpaceId);
      this.replace('spaces', { ...root, name: updated.name, purpose: updated.purpose });
      return { value: updated, entityId: projectId };
    });
  }
  createSpace(input: { projectId: string | null; parentId: string | null; name: string; purpose: string; position?: Point }): Space {
    nonempty(input.name, 'Space name'); strings({ purpose: input.purpose });
    point(input.position ?? { x: 0, y: 0, z: 0 });
    return this.write('space.created', () => {
      this.validateParent(input.projectId, input.parentId);
      const space: Space = { id: id(), projectId: input.projectId, parentId: input.parentId, name: input.name,
        purpose: input.purpose, position: input.position ?? { x: 0, y: 0, z: 0 }, conversationId: id() };
      this.insert('spaces', space, { project_id: space.projectId, parent_id: space.parentId, conversation_id: space.conversationId });
      this.insertConversation(space.conversationId, space.id, null, { runtime: '', model: '', effort: '' });
      return { value: space, entityId: space.id };
    });
  }
  updateSpace(spaceId: string, patch: Partial<Pick<Space, 'name' | 'purpose' | 'position' | 'parentId'>>): Space {
    return this.write('space.updated', () => {
      this.assertDestinationAvailable(spaceId);
      const space = this.getSpace(spaceId);
      if (patch.name !== undefined) nonempty(patch.name, 'Space name');
      if (patch.purpose !== undefined) strings({ purpose: patch.purpose });
      if (patch.position !== undefined) point(patch.position);
      const parentId = patch.parentId === undefined ? space.parentId : patch.parentId;
      if (spaceId === 'overview' && parentId !== null) fail('invalid', 'Overview cannot be moved');
      if (space.projectId !== null && this.getProject(space.projectId).rootSpaceId === space.id && parentId !== 'overview') {
        fail('invalid', 'A project root must remain under Overview');
      }
      if (spaceId !== 'overview') this.validateParent(space.projectId, parentId, spaceId);
      const updated: Space = { ...space, name: patch.name ?? space.name, purpose: patch.purpose ?? space.purpose,
        position: patch.position ?? space.position, parentId };
      this.replace('spaces', updated, { parent_id: parentId });
      return { value: updated, entityId: spaceId };
    });
  }
  createLink(input: { fromId: string; toId: string; label: string }): SpaceLink {
    strings({ label: input.label });
    return this.write('link.created', () => {
      this.assertDestinationAvailable(input.fromId); this.assertDestinationAvailable(input.toId);
      if (input.fromId === input.toId) fail('invalid', 'A space cannot link to itself');
      const existing = this.db.prepare('SELECT id FROM links WHERE from_id = ? AND to_id = ?').get(input.fromId, input.toId);
      if (existing) {
        const link = this.require('links', String(existing['id']));
        if (!this.isArchived('link', link.id)) fail('conflict', 'This link already exists');
        if (link.label !== input.label) fail('conflict', 'Reconnect the retained link with its original label');
        this.db.prepare("DELETE FROM archives WHERE kind = 'link' AND entity_id = ?").run(link.id);
        return { value: link, entityId: link.id };
      }
      const link = { id: id(), fromId: input.fromId, toId: input.toId, label: input.label };
      this.insert('links', link, { from_id: input.fromId, to_id: input.toId });
      return { value: link, entityId: link.id };
    });
  }

  updateConversationSettings(conversationId: string, settings: Pick<Conversation, 'runtime' | 'model' | 'effort'>): Conversation {
    strings(settings);
    return this.write('conversation.settings', () => {
      const conversation = this.require('conversations', conversationId);
      this.assertDestinationAvailable(conversation.spaceId, conversation.taskId);
      const updated = { ...conversation, runtime: settings.runtime, model: settings.model, effort: settings.effort };
      this.replace('conversations', updated);
      return { value: this.getConversation(conversationId), entityId: conversationId };
    });
  }
  getVoiceIntent(idempotencyKey: string): VoiceIntent | undefined {
    const row = this.db.prepare('SELECT data FROM voice_intents WHERE idempotency_key = ?').get(idempotencyKey);
    return row ? JSON.parse(String(row['data'])) as VoiceIntent : undefined;
  }

  /** Persist the onset recipient and audio digest before a billable transcription. No audio is stored. */
  captureVoiceIntent(idempotencyKey: string, receiver: Receiver, wavSha256: string): VoiceIntent {
    nonempty(idempotencyKey, 'Voice request key');
    if (!/^[a-f0-9]{64}$/.test(wavSha256)) fail('invalid', 'Voice requires a SHA-256 audio digest');
    return this.write('voice.captured', () => {
      const target = this.validateReceiver(receiver);
      const row = this.db.prepare('SELECT data FROM voice_intents WHERE idempotency_key = ?').get(idempotencyKey);
      if (row) {
        const previous = JSON.parse(String(row['data'])) as VoiceIntent;
        if (previous.wavSha256 !== wavSha256 || JSON.stringify(previous.receiver) !== JSON.stringify(target)) fail('conflict', 'Voice request key already captures a different recipient or recording');
        return { value: previous, entityId: target.conversationId, changed: false };
      }
      const submission = this.getSubmissionByKey(idempotencyKey);
      if (submission) fail('conflict', 'This key already belongs to a text/task submission, not a captured voice recording');
      const value: VoiceIntent = { idempotencyKey, receiver: { ...target }, wavSha256, createdAt: now() };
      this.db.prepare('INSERT INTO voice_intents (idempotency_key, data, conversation_id) VALUES (?, ?, ?)').run(idempotencyKey, JSON.stringify(value), target.conversationId);
      return { value, entityId: target.conversationId };
    });
  }

  validateReceiver(receiver: Receiver): Receiver {
    this.assertDestinationAvailable(receiver.spaceId, receiver.taskId);
    const space = this.getSpace(receiver.spaceId);
    const conversation = this.require('conversations', receiver.conversationId);
    if (conversation.spaceId !== space.id || conversation.taskId !== receiver.taskId) fail('invalid', 'Receiver does not own this conversation');
    if (receiver.taskId === null) {
      if (space.conversationId !== conversation.id) fail('invalid', 'Receiver is not the space conversation');
    } else {
      const task = this.getTask(receiver.taskId);
      if (task.spaceId !== space.id || task.conversationId !== conversation.id) fail('invalid', 'Receiver task belongs to another space/conversation');
    }
    return { spaceId: receiver.spaceId, conversationId: receiver.conversationId, taskId: receiver.taskId };
  }

  submitTurn(idempotencyKey: string, receiver: Receiver, text: string): Submission {
    nonempty(idempotencyKey, 'Idempotency key'); nonempty(text, 'Turn text');
    const fingerprint = JSON.stringify(['turn', receiver.spaceId, receiver.conversationId, receiver.taskId, text]);
    return this.write('submission.created', () => {
      const replay = this.replay(idempotencyKey, fingerprint);
      if (replay) return { value: replay, entityId: replay.id, changed: false };
      const validated = this.validateReceiver(receiver);
      const settings = this.require('conversations', validated.conversationId);
      const submission = this.insertSubmission(idempotencyKey, fingerprint, 'turn', validated, text, settings);
      return { value: submission, entityId: submission.id };
    });
  }
  createTask(input: CreateTaskInput): TaskWindow {
    nonempty(input.idempotencyKey, 'Idempotency key'); nonempty(input.title, 'Task title'); nonempty(input.prompt, 'Task prompt');
    strings({ runtime: input.runtime, model: input.model, effort: input.effort });
    const parentTaskId = input.parentTaskId ?? null;
    const origin: DelegationOrigin | undefined = input.origin && { kind: input.origin.kind, parentConversationId: input.origin.parentConversationId,
      parentTaskId: input.origin.parentTaskId, coordinatorParentRunId: input.origin.coordinatorParentRunId };
    if (origin) {
      if (origin.kind !== 'agent-delegation' || origin.parentTaskId !== parentTaskId) fail('invalid', 'Delegation origin must match the task parent');
      nonempty(origin.coordinatorParentRunId, 'Coordinator parent run ID');
    }
    const fingerprint = JSON.stringify(['task', input.spaceId, input.title, input.prompt, input.runtime, input.model, input.effort, parentTaskId,
      ...(origin ? [origin] : [])]);
    return this.write('task.created', () => {
      const replay = this.replay(input.idempotencyKey, fingerprint);
      if (replay) {
        if (!replay.receiver.taskId) fail('conflict', 'Submission is not a task');
        return { value: this.getTask(replay.receiver.taskId), entityId: replay.receiver.taskId, changed: false };
      }
      this.assertDestinationAvailable(input.spaceId);
      if (origin) this.validateReceiver({ spaceId: input.spaceId, conversationId: origin.parentConversationId, taskId: origin.parentTaskId });
      if (parentTaskId !== null) this.assertDestinationAvailable(this.getTask(parentTaskId).spaceId, parentTaskId);
      if (parentTaskId !== null && this.getSpace(this.getTask(parentTaskId).spaceId).projectId !== this.getSpace(input.spaceId).projectId) {
        fail('invalid', 'A delegated task must stay in its parent project');
      }
      const task: TaskWindow = { id: id(), spaceId: input.spaceId, conversationId: id(), title: input.title,
        state: 'queued', coordinatorTaskId: null, runId: null, environmentId: null, parentTaskId,
        layout: null, detail: 'Not yet submitted to the coordinator', updatedAt: now() };
      this.insert('tasks', task, { space_id: task.spaceId, conversation_id: task.conversationId, parent_task_id: parentTaskId });
      this.insertConversation(task.conversationId, task.spaceId, task.id, input);
      this.insertSubmission(input.idempotencyKey, fingerprint, 'task',
        { spaceId: task.spaceId, conversationId: task.conversationId, taskId: task.id }, input.prompt, input, origin);
      return { value: task, entityId: task.id };
    });
  }
  /** Initial authorship remains available after it leaves the bounded conversation history page. */
  getTaskOrigin(taskId: string): DelegationOrigin | undefined {
    const task = this.getTask(taskId);
    const row = this.db.prepare("SELECT data FROM submissions WHERE conversation_id = ? AND json_extract(data, '$.kind') = 'task'").get(task.conversationId);
    return row ? this.getMessage((JSON.parse(String(row['data'])) as Submission).messageId).origin : undefined;
  }
  getSubmission(submissionId: string): Submission { return this.require('submissions', submissionId); }
  getSubmissionByKey(key: string): Submission | null {
    const row = this.db.prepare('SELECT data FROM submissions WHERE idempotency_key = ?').get(key);
    return row ? JSON.parse(String(row['data'])) as Submission : null;
  }
  pendingSubmissions(): Submission[] {
    return this.all('submissions').filter(item => item.state !== 'settled' && item.state !== 'blocked');
  }
  updateSubmission(submissionId: string, patch: Partial<Pick<Submission, 'state' | 'coordinatorTaskId' | 'runId' | 'detail'>>): Submission {
    return this.write('submission.updated', () => {
      const submission = this.getSubmission(submissionId);
      if (patch.state !== undefined && !['queued', 'submitting', 'submitted', 'uncertain', 'settled', 'blocked'].includes(patch.state)) {
        fail('invalid', 'Unknown submission state');
      }
      if (patch.detail !== undefined) strings({ detail: patch.detail });
      this.checkReference(submission.coordinatorTaskId, patch.coordinatorTaskId, 'Coordinator task');
      this.checkReference(submission.runId, patch.runId, 'Coordinator run');
      if (patch.coordinatorTaskId !== undefined && patch.coordinatorTaskId !== null) {
        for (const other of this.all('submissions')) {
          if (other.coordinatorTaskId === patch.coordinatorTaskId && other.receiver.conversationId !== submission.receiver.conversationId) {
            fail('conflict', 'Coordinator task is linked to another conversation');
          }
        }
        for (const task of this.all('tasks')) {
          if (task.coordinatorTaskId === patch.coordinatorTaskId && task.id !== submission.receiver.taskId) {
            fail('conflict', 'Coordinator task is linked to another task window');
          }
        }
      }
      if (submission.receiver.taskId !== null) {
        const task = this.getTask(submission.receiver.taskId);
        if (task.coordinatorTaskId !== null && patch.coordinatorTaskId !== undefined && task.coordinatorTaskId !== patch.coordinatorTaskId) {
          fail('conflict', 'Submission coordinator task does not match its task window');
        }
      }
      if (patch.runId !== undefined && patch.runId !== null) {
        if (this.all('submissions').some(other => other.id !== submissionId && other.runId === patch.runId)) {
          fail('conflict', 'Coordinator run is already linked to another submission');
        }
        if (this.all('tasks').some(task => task.id !== submission.receiver.taskId && task.runId === patch.runId)) {
          fail('conflict', 'Coordinator run belongs to another task window');
        }
      }
      const updated: Submission = { ...submission, state: patch.state ?? submission.state,
        coordinatorTaskId: patch.coordinatorTaskId === undefined ? submission.coordinatorTaskId : patch.coordinatorTaskId,
        runId: patch.runId === undefined ? submission.runId : patch.runId, detail: patch.detail ?? submission.detail, updatedAt: now() };
      this.replace('submissions', updated);
      return { value: updated, entityId: submissionId };
    });
  }

  getMessage(messageId: string): Message { return this.require('messages', messageId); }
  appendMessage(input: { id?: string; conversationId: string; requestId?: string | null; role: Message['role']; text: string; state?: Message['state']; createdAt?: string }): Message {
    strings({ text: input.text });
    const messageId = input.id ?? id();
    nonempty(messageId, 'Message ID');
    return this.write('message.created', () => {
      this.require('conversations', input.conversationId);
      if (!['owner', 'agent', 'system'].includes(input.role)) fail('invalid', 'Unknown message role');
      const state = input.state ?? 'complete';
      this.validateMessageState(state);
      const requestId = input.requestId ?? null;
      if (requestId !== null && this.getSubmission(requestId).receiver.conversationId !== input.conversationId) {
        fail('invalid', 'Message request belongs to another conversation');
      }
      const message: Message = { id: messageId, conversationId: input.conversationId, requestId,
        role: input.role, text: input.text, state, createdAt: input.createdAt ?? now() };
      if (!Number.isFinite(Date.parse(message.createdAt))) fail('invalid', 'Message timestamp is invalid');
      const existing = this.find('messages', messageId);
      if (existing) {
        if (existing.conversationId !== message.conversationId || existing.requestId !== message.requestId ||
          existing.role !== message.role || existing.text !== message.text || existing.state !== message.state ||
          (input.createdAt !== undefined && existing.createdAt !== input.createdAt)) fail('conflict', 'Message ID reused with different content');
        return { value: existing, entityId: messageId, changed: false };
      }
      this.insert('messages', message, { conversation_id: message.conversationId, request_id: message.requestId });
      return { value: message, entityId: messageId };
    });
  }
  updateMessage(messageId: string, patch: Partial<Pick<Message, 'text' | 'state'>>): Message {
    return this.write('message.updated', () => {
      const message = this.getMessage(messageId);
      if (patch.text !== undefined) strings({ text: patch.text });
      if (patch.state !== undefined) this.validateMessageState(patch.state);
      const updated: Message = { ...message, text: patch.text ?? message.text, state: patch.state ?? message.state };
      this.replace('messages', updated);
      return { value: updated, entityId: messageId };
    });
  }
  listMessages(conversationId: string, options: { before?: string; limit?: number } = {}): MessagePage {
    this.require('conversations', conversationId);
    let before: number | null = null;
    if (options.before !== undefined) {
      const anchor = this.getMessage(options.before);
      if (anchor.conversationId !== conversationId) fail('invalid', 'History cursor belongs to another conversation');
      before = Number(this.db.prepare('SELECT seq FROM messages WHERE id = ?').get(anchor.id)?.['seq']);
    }
    const limit = pageLimit(options.limit, 100);
    const rows = this.db.prepare('SELECT data FROM messages WHERE conversation_id = ? AND (? IS NULL OR seq < ?) ORDER BY seq DESC LIMIT ?')
      .all(conversationId, before, before, limit + 1);
    const hasMore = rows.length > limit;
    const messages = rows.slice(0, limit).map(row => JSON.parse(String(row['data'])) as Message).reverse();
    return { messages, nextBefore: hasMore ? messages[0]?.id ?? null : null };
  }

  updateTask(taskId: string, patch: Partial<Pick<TaskWindow, 'title' | 'state' | 'coordinatorTaskId' | 'runId' | 'environmentId' | 'detail'>>): TaskWindow {
    return this.write('task.updated', () => {
      const task = this.getTask(taskId);
      if (patch.title !== undefined) {
        this.assertDestinationAvailable(task.spaceId, task.id);
        nonempty(patch.title, 'Task title');
      }
      if (patch.state !== undefined) nonempty(patch.state, 'Task state');
      if (patch.detail !== undefined) strings({ detail: patch.detail });
      this.checkReference(task.coordinatorTaskId, patch.coordinatorTaskId, 'Coordinator task');
      for (const field of ['runId', 'environmentId'] as const) {
        if (patch[field] !== undefined && patch[field] !== null) nonempty(patch[field], field);
      }
      if (patch.coordinatorTaskId !== undefined && patch.coordinatorTaskId !== null) {
        for (const other of this.all('tasks')) {
          if (other.id !== taskId && other.coordinatorTaskId === patch.coordinatorTaskId) fail('conflict', 'Coordinator task is already linked to another window');
        }
        for (const submission of this.all('submissions')) {
          if (submission.receiver.taskId === taskId && submission.coordinatorTaskId !== null && submission.coordinatorTaskId !== patch.coordinatorTaskId) {
            fail('conflict', 'Task coordinator identity does not match retained submissions');
          }
          if (submission.receiver.taskId !== taskId && submission.coordinatorTaskId === patch.coordinatorTaskId) {
            fail('conflict', 'Coordinator task belongs to another conversation');
          }
        }
      }
      if (patch.runId !== undefined && patch.runId !== null) {
        if (this.all('tasks').some(other => other.id !== taskId && other.runId === patch.runId) ||
          this.all('submissions').some(submission => submission.receiver.taskId !== taskId && submission.runId === patch.runId)) {
          fail('conflict', 'Coordinator run belongs to another task/conversation');
        }
      }
      if (patch.environmentId !== undefined && patch.environmentId !== null &&
        this.all('tasks').some(other => other.id !== taskId && other.environmentId === patch.environmentId)) {
        fail('conflict', 'Environment is already linked to another task window');
      }
      const updated: TaskWindow = { ...task, title: patch.title ?? task.title, state: patch.state ?? task.state,
        detail: patch.detail ?? task.detail, updatedAt: now(),
        coordinatorTaskId: patch.coordinatorTaskId === undefined ? task.coordinatorTaskId : patch.coordinatorTaskId,
        runId: patch.runId === undefined ? task.runId : patch.runId,
        environmentId: patch.environmentId === undefined ? task.environmentId : patch.environmentId };
      this.replace('tasks', updated);
      return { value: updated, entityId: taskId };
    });
  }
  updateTaskLayout(taskId: string, value: WindowLayout | null): TaskWindow {
    if (value !== null) layout(value);
    return this.write('task.layout', () => {
      const current = this.getTask(taskId);
      this.assertDestinationAvailable(current.spaceId, current.id);
      const task = { ...current, layout: value, updatedAt: now() };
      this.replace('tasks', task);
      return { value: task, entityId: taskId };
    });
  }

  getInboxRequest(requestId: string): InboxRequest { return this.require('inbox', requestId); }
  listInboxRequests(): InboxRequest[] { return this.all('inbox'); }
  createInboxRequest(input: Omit<InboxRequest, 'id' | 'version' | 'state' | 'createdAt'> & { id?: string }): InboxRequest {
    nonempty(input.title, 'Inbox title'); strings({ detail: input.detail });
    this.validateEvidence(input.evidence);
    return this.write('inbox.created', () => {
      this.validateDestination(input.spaceId, input.taskId);
      this.validateInboxKind(input.kind);
      const request: InboxRequest = { id: input.id ?? id(), version: 1, spaceId: input.spaceId, taskId: input.taskId,
        kind: input.kind, title: input.title, detail: input.detail, evidence: input.evidence, state: 'open', createdAt: now() };
      nonempty(request.id, 'Inbox ID');
      if (this.find('inbox', request.id)) fail('conflict', 'Inbox ID already exists');
      this.insert('inbox', request, { space_id: request.spaceId, task_id: request.taskId });
      this.retainInboxVersion(request);
      return { value: request, entityId: request.id };
    });
  }
  updateInboxRequest(requestId: string, expectedVersion: number, patch: Partial<Pick<InboxRequest, 'title' | 'detail' | 'evidence'>>): InboxRequest {
    return this.write('inbox.updated', () => {
      const request = this.currentRequest(requestId, expectedVersion);
      if (patch.title !== undefined) nonempty(patch.title, 'Inbox title');
      if (patch.detail !== undefined) strings({ detail: patch.detail });
      if (patch.evidence !== undefined) this.validateEvidence(patch.evidence);
      const updated: InboxRequest = { ...request, title: patch.title ?? request.title, detail: patch.detail ?? request.detail,
        evidence: patch.evidence ?? request.evidence, version: request.version + 1 };
      this.replace('inbox', updated);
      this.retainInboxVersion(updated);
      return { value: updated, entityId: requestId };
    });
  }
  /** Records the owner's decision, never approves a grant or dispatches work. Service checks authority first. */
  respondInbox(requestId: string, expectedVersion: number, action: InboxAction, text: string, beforeRecord?: () => import('./runtime-coordinator.js').AuthorityConfirmationReceipt): { request: InboxRequest; decision: InboxDecision } {
    strings({ text });
    return this.write('inbox.decision', () => {
      const request = this.currentRequest(requestId, expectedVersion);
      if (request.state !== 'open' && request.state !== 'deferred') fail('conflict', 'Inbox request is already answered');
      const allowed: Record<InboxRequest['kind'], InboxAction[]> = {
        question: ['answer', 'defer', 'dismiss'], blocker: ['answer', 'defer', 'dismiss'], approval: ['approve', 'defer', 'dismiss'], review: ['review', 'defer', 'dismiss'],
      };
      if (!allowed[request.kind].includes(action)) fail('invalid', 'Action does not match Inbox request kind');
      if (action === 'answer' || action === 'dismiss') nonempty(text, action === 'answer' ? 'Answer' : 'Dismissal reason');
      const ownerReceipt = beforeRecord?.();
      const decision: InboxDecision = { id: id(), requestId, version: expectedVersion, action, text, ...(ownerReceipt ? { ownerReceipt } : {}), createdAt: now() };
      const updated: InboxRequest = { ...request, state: action === 'defer' ? 'deferred' : action === 'dismiss' ? 'dismissed' : 'answered', version: request.version + 1,
        disposition: { action, text, decidedAt: decision.createdAt, ...(ownerReceipt ? { receiptId: ownerReceipt.decisionId, authority: { ...ownerReceipt.expectedAuthority } } : {}) } };
      this.insert('decisions', decision, { request_id: requestId });
      this.replace('inbox', updated);
      this.retainInboxVersion(updated);
      return { value: { request: updated, decision }, entityId: requestId };
    });
  }
  listInboxDecisions(requestId: string): InboxDecision[] {
    this.getInboxRequest(requestId);
    return this.all('decisions', 'request_id = ?', [requestId]);
  }

  listInboxVersions(requestId: string): InboxRequest[] {
    this.getInboxRequest(requestId);
    return this.db.prepare('SELECT data FROM inbox_versions WHERE request_id = ? ORDER BY version').all(requestId)
      .map(row => JSON.parse(String(row['data'])) as InboxRequest);
  }
  private retainInboxVersion(request: InboxRequest): void {
    this.db.prepare('INSERT INTO inbox_versions (request_id, version, data) VALUES (?, ?, ?)')
      .run(request.id, request.version, JSON.stringify(request));
  }

  private archive(kind: ArchiveKind, entityId: string): ArchiveRecord {
    if (this.coordinatedArchive && (kind !== this.coordinatedArchive.product.kind || entityId !== this.coordinatedArchive.product.id)) {
      fail('conflict', 'Coordinated SQL callback must archive only its exact product root');
    }
    const work = (): Mutation<ArchiveRecord> => {
      this.requireArchiveEntity(kind, entityId);
      if (kind === 'space') {
        if (entityId === 'overview') fail('invalid', 'Overview cannot be archived');
        const space = this.getSpace(entityId);
        if (space.projectId !== null && this.getProject(space.projectId).rootSpaceId === entityId) {
          fail('invalid', 'Archive the project instead of its root space');
        }
      }
      const matchingIntent = this.listArchiveIntents().find(intent => intent.product.kind === kind && intent.product.id === entityId);
      if (matchingIntent && (!this.coordinatedArchive || this.coordinatedArchive.archiveId !== matchingIntent.archiveId)) {
        fail('conflict', 'Retained archive attempt requires its exact trusted coordinator SQL commit');
      }
      const existing = this.listArchives().find(record => record.kind === kind && record.entityId === entityId);
      if (existing) return { value: existing, entityId, changed: false };
      const spaces = this.all('spaces');
      const tasks = this.all('tasks');
      const spaceIds = new Set<string>();
      const taskIds = new Set<string>();
      if (kind === 'project') for (const space of spaces) if (space.projectId === entityId) spaceIds.add(space.id);
      if (kind === 'space') {
        spaceIds.add(entityId);
        // Iterative traversal supports arbitrary nesting without a recursive stack limit.
        let added = true;
        while (added) {
          added = false;
          for (const space of spaces) if (space.parentId !== null && spaceIds.has(space.parentId) && !spaceIds.has(space.id)) {
            spaceIds.add(space.id); added = true;
          }
        }
      }
      if (kind === 'task') taskIds.add(entityId);
      for (const task of tasks) if (spaceIds.has(task.spaceId)) taskIds.add(task.id);
      // Delegated descendants may live in sibling spaces but still belong to this work's history.
      let added = true;
      while (added) {
        added = false;
        for (const task of tasks) if (task.parentTaskId !== null && taskIds.has(task.parentTaskId) && !taskIds.has(task.id)) {
          taskIds.add(task.id); added = true;
        }
      }
      for (const intent of this.listArchiveIntents()) {
        const binding = this.getArchiveBinding(intent.product.kind, intent.product.id);
        if (binding?.archiveId === intent.archiveId && this.observeCoordinatedArchive(binding).state === 'archived') continue;
        if (intent.archiveId === this.coordinatedArchive?.archiveId && intent.product.kind === kind && intent.product.id === entityId) continue;
        if ([...spaceIds].some(spaceId => this.receiversAffectDestination(intent.receivers, spaceId, null)) ||
          [...taskIds].some(taskId => this.receiversAffectDestination(intent.receivers, this.getTask(taskId).spaceId, taskId))) {
          fail('conflict', 'Another retained archive attempt overlaps this product family');
        }
      }
      const conversationIds = new Set(this.all('conversations').filter(conversation => spaceIds.has(conversation.spaceId) ||
        (conversation.taskId !== null && taskIds.has(conversation.taskId))).map(conversation => conversation.id));
      for (const submission of this.all('submissions')) {
        if (conversationIds.has(submission.receiver.conversationId) && submission.state !== 'settled' && submission.state !== 'blocked') {
          fail('conflict', `Cannot archive: submission ${submission.id} is ${submission.state}. Reconcile or explicitly stop work first; archive never cancels it`);
        }
      }
      for (const task of tasks) {
        if (taskIds.has(task.id) && !['completed', 'checks-failed', 'failed', 'cancelled', 'stopped'].includes(task.state)) {
          fail('conflict', `Cannot archive: task ${task.id} is ${task.state}. Reconcile coordinator/environment evidence before archiving`);
        }
      }
      for (const message of this.all('messages')) {
        if (conversationIds.has(message.conversationId) && ['pending', 'streaming', 'uncertain'].includes(message.state)) {
          fail('conflict', `Cannot archive: message ${message.id} is ${message.state}. Reconcile the retained turn first`);
        }
      }
      for (const request of this.all('inbox')) {
        if ((spaceIds.has(request.spaceId) || (request.taskId !== null && taskIds.has(request.taskId))) && (request.state === 'open' || request.state === 'deferred')) {
          fail('conflict', `Cannot archive: Inbox request ${request.id} is ${request.state}. Resolve its current decision first`);
        }
      }
      const archivedAt = now();
      const retain = (targetKind: ArchiveKind, targetId: string): void => {
        this.db.prepare('INSERT OR IGNORE INTO archives (kind, entity_id, archived_at) VALUES (?, ?, ?)')
          .run(targetKind, targetId, archivedAt);
      };
      retain(kind, entityId);
      for (const spaceId of spaceIds) retain('space', spaceId);
      for (const taskId of taskIds) retain('task', taskId);
      for (const link of this.all('links')) if (spaceIds.has(link.fromId) || spaceIds.has(link.toId)) retain('link', link.id);
      return { value: { kind, entityId, archivedAt }, entityId };
    };
    return this.coordinatedArchive ? work().value : this.write(`${kind}.archived`, work);
  }
  private requireArchiveEntity(kind: ArchiveKind, entityId: string): void {
    switch (kind) {
      case 'project': this.getProject(entityId); break;
      case 'space': this.getSpace(entityId); break;
      case 'task': this.getTask(entityId); break;
      case 'link': this.require('links', entityId); break;
      default: fail('invalid', 'Unknown archive kind');
    }
  }
  private assertNotArchived(kind: ArchiveKind, entityId: string): void {
    if (this.isArchived(kind, entityId)) fail('conflict', `This ${kind} destination is archived: ${entityId}. Inspect archived history/export or select a current destination; no new work is allowed`);
  }
  private readEvents(): StoreEvent[] {
    return this.db.prepare('SELECT revision, kind, entity_id, created_at FROM events ORDER BY revision').all()
      .map(row => ({ revision: Number(row['revision']), kind: String(row['kind']), entityId: String(row['entity_id']), createdAt: String(row['created_at']) }));
  }
  private readConsistent<T>(read: () => T): T {
    // A coordinated archive observes its binding inside the existing write transaction.
    if (this.db.isTransaction) return read();
    this.db.exec('BEGIN');
    try {
      const result = read();
      this.db.exec('COMMIT');
      return result;
    } catch (error) { if (this.db.isTransaction) this.db.exec('ROLLBACK'); throw error; }
  }

  private currentRequest(requestId: string, version: number): InboxRequest {
    const request = this.getInboxRequest(requestId);
    if (!Number.isSafeInteger(version) || version !== request.version) fail('stale', 'Inbox request changed; reload its current evidence before deciding');
    return request;
  }
  private validateInboxKind(kind: InboxRequest['kind']): void {
    if (!['question', 'approval', 'blocker', 'review'].includes(kind)) fail('invalid', 'Unknown Inbox kind');
  }
  private validateEvidence(evidence: string[]): void {
    if (!Array.isArray(evidence) || evidence.some(item => typeof item !== 'string')) fail('invalid', 'Evidence must be an array of strings');
  }
  private validateDestination(spaceId: string, taskId: string | null): void {
    this.assertDestinationAvailable(spaceId, taskId);
  }
  private validateMessageState(state: Message['state']): void {
    if (!['pending', 'streaming', 'complete', 'failed', 'uncertain'].includes(state)) fail('invalid', 'Unknown message state');
  }
  private checkReference(existing: string | null, incoming: string | null | undefined, label: string): void {
    if (incoming !== undefined && incoming !== null) nonempty(incoming, label);
    if (existing !== null && incoming !== undefined && existing !== incoming) fail('conflict', `${label} identity cannot be replaced or cleared`);
  }
  private validateParent(projectId: string | null, parentId: string | null, movingId?: string): void {
    if (projectId !== null) this.assertNotArchived('project', projectId);
    if (parentId === null) fail('invalid', 'Only Overview can have no parent');
    this.assertDestinationAvailable(parentId);
    let parent = this.getSpace(parentId);
    const root = movingId !== undefined && projectId !== null && this.getProject(projectId).rootSpaceId === movingId;
    if (parent.projectId !== projectId && !(root && parent.id === 'overview')) fail('invalid', 'A space parent must belong to the same project');
    const visited = new Set<string>();
    while (true) {
      if (parent.id === movingId || visited.has(parent.id)) fail('invalid', 'Space move would create a cycle');
      visited.add(parent.id);
      if (parent.parentId === null) break;
      parent = this.getSpace(parent.parentId);
    }
  }
  private insertConversation(conversationId: string, spaceId: string, taskId: string | null,
    settings: Pick<Conversation, 'runtime' | 'model' | 'effort'>): void {
    const conversation: Conversation = { id: conversationId, spaceId, taskId, runtime: settings.runtime, model: settings.model,
      effort: settings.effort, messages: [] };
    this.insert('conversations', conversation, { space_id: spaceId, task_id: taskId });
  }
  private insertSubmission(key: string, fingerprint: string, kind: Submission['kind'], receiver: Receiver, text: string,
    settings: Pick<Conversation, 'runtime' | 'model' | 'effort'>, origin?: DelegationOrigin): Submission {
    const timestamp = now();
    const submission: Submission = { id: id(), idempotencyKey: key, kind, receiver, text, messageId: id(), state: 'queued',
      runtime: settings.runtime, model: settings.model, effort: settings.effort,
      coordinatorTaskId: null, runId: null, detail: '', createdAt: timestamp, updatedAt: timestamp };
    this.insert('submissions', submission, { idempotency_key: key, fingerprint, conversation_id: receiver.conversationId, message_id: submission.messageId });
    const message: Message = { id: submission.messageId, conversationId: receiver.conversationId, requestId: submission.id,
      role: origin ? 'agent' : 'owner', ...(origin ? { origin } : {}), text, createdAt: timestamp, state: 'pending' };
    this.insert('messages', message, { conversation_id: receiver.conversationId, request_id: submission.id });
    return submission;
  }
  private replay(key: string, fingerprint: string): Submission | null {
    const row = this.db.prepare('SELECT data, fingerprint FROM submissions WHERE idempotency_key = ?').get(key);
    if (!row) return null;
    if (row['fingerprint'] !== fingerprint) fail('conflict', 'Idempotency key was already used for a different request');
    return JSON.parse(String(row['data'])) as Submission;
  }
  private find<T extends Table>(table: T, recordId: string): Records[T] | null {
    const row = this.db.prepare(`SELECT data FROM ${table} WHERE id = ?`).get(recordId);
    return row ? JSON.parse(String(row['data'])) as Records[T] : null;
  }
  private require<T extends Table>(table: T, recordId: string): Records[T] {
    return this.find(table, recordId) ?? fail('not_found', `${table} record not found: ${recordId}`);
  }
  private all<T extends Table>(table: T, where = '1 = 1', params: SQLInputValue[] = []): Records[T][] {
    return this.db.prepare(`SELECT data FROM ${table} WHERE ${where} ORDER BY rowid`).all(...params)
      .map(row => JSON.parse(String(row['data'])) as Records[T]);
  }
  private insert<T extends Table>(table: T, value: Records[T], refs: Record<string, SQLInputValue>): void {
    const columns = ['id', 'data', ...Object.keys(refs)];
    this.db.prepare(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`)
      .run(value.id, JSON.stringify(value), ...Object.values(refs));
  }
  private replace<T extends Table>(table: T, value: Records[T], refs: Record<string, SQLInputValue> = {}): void {
    this.db.prepare(`UPDATE ${table} SET data = ?${Object.keys(refs).map(key => `, ${key} = ?`).join('')} WHERE id = ?`)
      .run(JSON.stringify(value), ...Object.values(refs), value.id);
  }
  private write<T>(kind: string, work: () => Mutation<T>): T {
    this.db.exec('BEGIN IMMEDIATE');
    let revision: number | null = null;
    let result: Mutation<T>;
    try {
      result = work();
      if (result.changed !== false) {
        this.db.exec('UPDATE metadata SET revision = revision + 1 WHERE id = 1');
        revision = this.revision;
        this.db.prepare('INSERT INTO events (revision, kind, entity_id, created_at) VALUES (?, ?, ?, ?)')
          .run(revision, kind, result.entityId, now());
      }
      this.db.exec('COMMIT');
    } catch (error) { if (this.db.isTransaction) this.db.exec('ROLLBACK'); throw error; }
    const value = structuredClone(result.value);
    if (revision !== null) {
      for (const listener of this.listeners) {
        // A disconnected long-poll listener cannot make a committed request look failed.
        try { listener(revision); } catch { /* Persistent events remain available for reconnect. */ }
      }
    }
    return value;
  }
}
