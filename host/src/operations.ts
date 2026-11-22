import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync, closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync,
  openSync, readFileSync, readSync, readdirSync, realpathSync, writeFileSync, writeSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Readable, Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { StringDecoder } from 'node:string_decoder';
import type { ArchiveStream, EnvironmentSnapshot, ExportArtifact } from './environment-broker.js';
import { acquireFileLease } from './file-lease.js';

export class OperationError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = 'OperationError'; }
}
function refuse(code: string, message: string): never { throw new OperationError(code, message); }
export interface StateSources {
  productDatabase: string; productLeasePath: string; coordinatorRoot: string; environmentRoot?: string; artifactRoot?: string;
  /** Explicit configured pair only. Never discover journals or credentials by scanning the host root. */
  speechJournal?: string;
  speechIdentity?: string;
}
export interface MaintenanceEvidence {
  mode: 'detached-fixture' | 'owner-approved-quiesced';
  owner: string;
  reviewedCutover: string;
  inspectedAt: string;
  expiresAt: string;
  writers: { name: string; version: string; pid: number | null; stopped: boolean; restartPrevented: boolean; evidence: string }[];
  workersAndRemoteEffectsInventoried: boolean;
  inventoryEvidence: string;
  /** The host lease does not fence independent speech service instances/processes. */
  speechWriters?: { journal: string; identity: string; allInstancesStopped: boolean; restartPrevented: boolean; evidence: string };
}
export interface BackupOptions {
  sources: StateSources;
  destination: string;
  maintenance: MaintenanceEvidence;
  /** Trusted host check before and after capture. A lock or a stage pause is not this check. */
  verifyQuiescence: () => void;
  productBuild: string;
  coordinatorBuild: string;
  /** Failure-injection/observability seam; receives no state or secrets. Throwing never commits an operation. */
  checkpoint?: (phase: string) => void;
}
export interface InventoryFile { path: string; sha256: string; bytes: number }
export interface BackupManifest {
  format: 1;
  kind: 'spatial-workspace-backup';
  operationId: string;
  completedAt: string;
  productVersion: number;
  speechJournalVersion?: 1;
  productBuild: string;
  coordinatorBuild: string;
  sourceFingerprint: string;
  files: InventoryFile[];
  excluded: string[];
  maintenance: MaintenanceEvidence;
}
interface Capture { files: Map<string, Buffer>; excluded: string[]; fingerprint: string; productVersion: number }
const secretName = /^(auth|tls|providers?|credentials?|secrets?|\.env(?:\..*)?|clients\.json|host-key\.pem|host-cert\.pem|.*\.(?:pem|key|p12|pfx|keystore))$/i;
const secretField = /\\*["'](?:api[_-]?key|access[_-]?token|refresh[_-]?token|tokenHash|password|client[_-]?secret|private[_-]?key|authorization)\\*["']\s*:/i;
const secretValue = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bsw_[a-f0-9]{64}\b|\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,})\b|\bBearer\s+[A-Za-z0-9._~-]{16,}/;
function screen(data: Buffer, label: string): void {
  const text = data.toString('utf8');
  if (secretField.test(text) || secretValue.test(text)) refuse('secret-in-state', `Secret-shaped content in ${label}; separate credentials and review retained evidence before export. No redacted substitute was made.`);
}
function digest(data: Buffer | string): string { return createHash('sha256').update(data).digest('hex'); }
function canonical(path: string, directory: boolean): string {
  const full = resolve(path);
  const stat = lstatSync(full);
  if (stat.isSymbolicLink() || realpathSync(full) !== full || (directory ? !stat.isDirectory() : !stat.isFile())) refuse('unsafe-path', 'State paths must be real files/directories without symlinks.');
  return full;
}
function inside(root: string, candidate: string): boolean { const rel = relative(root, candidate); return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('../')); }
function safeRelative(path: string): void {
  if (!path || isAbsolute(path) || path.includes('\\') || path.split('/').some(part => !part || part === '.' || part === '..') || path.includes('\0')) refuse('unsafe-path', 'Only canonical relative archive paths are accepted.');
}
function readRegular(path: string): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { if (!fstatSync(fd).isFile()) refuse('unsafe-path', 'Only regular files can be exported.'); return readFileSync(fd); }
  finally { closeSync(fd); }
}
function syncDirectory(path: string): void { const fd = openSync(path, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }
function durableWrite(path: string, data: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const fd = openSync(path, 'wx', 0o600);
  try { writeFileSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
  syncDirectory(dirname(path));
}
function newDestination(path: string, protectedRoots: string[]): string {
  const full = resolve(path); const parent = canonical(dirname(full), true);
  if (protectedRoots.some(root => inside(root, full) || inside(full, root))) refuse('live-overlap', 'Destination must not overlap source, backup, environment or current live state.');
  if (existsSync(full)) refuse('destination-exists', 'Operations only create a new destination; no existing state is replaced.');
  mkdirSync(full, { mode: 0o700 }); syncDirectory(parent);
  if ((lstatSync(full).mode & 0o077) !== 0) refuse('private-output-required', 'Output permissions are not private. Use an OS-private Linux filesystem; mode bits on DrvFS are not a verified access boundary.');
  durableWrite(join(full, 'INCOMPLETE.json'), JSON.stringify({ operationId: randomUUID(), activation: 'forbidden', detail: 'No completed manifest means this directory is not usable.' }));
  return full;
}
export function verifyMaintenance(evidence: MaintenanceEvidence): void {
  const time = Date.now();
  if (!evidence || !['detached-fixture', 'owner-approved-quiesced'].includes(evidence.mode) || !evidence.owner?.trim() || !evidence.reviewedCutover?.trim() || !evidence.inventoryEvidence?.trim() || !evidence.workersAndRemoteEffectsInventoried || !Array.isArray(evidence.writers) || !evidence.writers.length || !Number.isFinite(Date.parse(evidence.inspectedAt)) || Date.parse(evidence.inspectedAt) > time || Date.parse(evidence.inspectedAt) < time - 300_000 || !Number.isFinite(Date.parse(evidence.expiresAt)) || Date.parse(evidence.expiresAt) <= time || Date.parse(evidence.expiresAt) > Date.parse(evidence.inspectedAt) + 300_000) refuse('maintenance-required', 'Fresh reviewed owner maintenance and complete writer/worker inventory are required (maximum five minutes).');
  for (const writer of evidence.writers) {
    if (!writer.name?.trim() || !writer.version?.trim() || !writer.evidence?.trim() || !writer.stopped || !writer.restartPrevented) refuse('writer-not-held', 'Every CLI/MCP/UI/loop/host writer must be stopped with restart prevented and version/inspection evidence.');
    if (writer.pid !== null) {
      if (!Number.isSafeInteger(writer.pid) || writer.pid <= 0) refuse('writer-not-held', 'Invalid inventoried writer PID.');
      try { process.kill(writer.pid, 0); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') continue; refuse('writer-not-held', 'Writer absence cannot be verified.'); }
      refuse('writer-not-held', 'An inventoried writer PID still exists. PID absence alone does not prove descendant/remote-work quiescence.');
    }
  }
}
function tree(root: string, prefix: string, files: Map<string, Buffer>, excluded: string[]): void {
  const walk = (directory: string, rel: string) => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name); const archivePath = [prefix, rel, name].filter(Boolean).join('/');
      safeRelative(archivePath);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) refuse('unsafe-path', 'Symlinks and special files are not backup inputs.');
      if (secretName.test(name) || name === 'locks' || name === 'broker.lock') { excluded.push(archivePath); continue; }
      if (/\.tmp(?:\.|$)|\.partial(?:\.|$)/.test(name)) refuse('interrupted-write', 'Unreconciled temporary state file exists; preserve and inspect it before backup.');
      if (stat.isDirectory()) walk(path, [rel, name].filter(Boolean).join('/'));
      else { const bytes = readRegular(path); screen(bytes, archivePath); files.set(archivePath, bytes); }
    }
  };
  walk(canonical(root, true), '');
}
function inspectDatabase(db: DatabaseSync): number {
  const version = Number(db.prepare('PRAGMA user_version').get()?.['user_version']);
  if (version !== 1 && version !== 2 && version !== 3) refuse('unsupported-version', 'Only reviewed workspace schemas v1/v2/v3 can be captured/restored. Future versions require a reviewed migration.');
  const rows = db.prepare('PRAGMA integrity_check').all();
  if (rows.length !== 1 || rows[0]?.['integrity_check'] !== 'ok' || db.prepare('PRAGMA foreign_key_check').all().length) refuse('database-corrupt', 'Workspace integrity/foreign-key checks failed.');
  for (const name of ['metadata', 'projects', 'spaces', 'conversations', 'tasks', 'links', 'messages', 'submissions', 'inbox', 'inbox_versions', 'decisions', 'events', ...(version >= 2 ? ['archives'] : []), ...(version === 3 ? ['archive_intents'] : [])]) {
    const table = db.prepare('SELECT sql FROM sqlite_master WHERE type = ? AND name = ?').get('table', name);
    if (!table) refuse('database-corrupt', 'Required workspace history table is missing.');
  }
  return version;
}
function databaseImage(path: string): { version: number; data: Buffer } {
  // VACUUM INTO includes committed WAL state; copying the main file alone loses recent work.
  const db = new DatabaseSync(canonical(path, false), { readOnly: true });
  try {
    const version = inspectDatabase(db);
    const records: Record<string, unknown> = {};
    for (const row of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all()) {
      const name = String(row['name']);
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) refuse('database-corrupt', 'Unexpected table name.');
      records[name] = db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all();
    }
    const data = Buffer.from(JSON.stringify(records)); screen(data, 'product database');
    return { version, data };
  } finally { db.close(); }
}
function speechPair(sources: StateSources): { journal: string; identity: string } | null {
  if (sources.speechJournal === undefined && sources.speechIdentity === undefined) return null;
  if (!sources.speechJournal || !sources.speechIdentity || !isAbsolute(sources.speechJournal) || resolve(sources.speechJournal) !== sources.speechJournal || sources.speechIdentity !== `${sources.speechJournal}.identity`) refuse('speech-pair-required', 'Configured speech requires the exact absolute journal and its .identity sidecar; neither may be omitted.');
  const root = canonical(dirname(sources.productDatabase), true);
  if (!inside(root, sources.speechJournal) || sources.speechJournal === sources.productDatabase || sources.speechJournal === sources.productLeasePath) refuse('unsafe-path', 'Speech pair must remain inside its configured private host jail, separate from product state and locks.');
  return { journal: sources.speechJournal, identity: sources.speechIdentity };
}
function privateSpeechPath(path: string, directory = false): void {
  canonical(path, directory);
  const stat = lstatSync(path);
  if ((stat.mode & 0o077) || (!directory && stat.nlink !== 1) || (process.getuid && stat.uid !== process.getuid())) refuse('private-output-required', 'Speech storage must be owner-private, without shared file aliases.');
}
function inspectSpeechDatabase(db: DatabaseSync, identity: Buffer): void {
  if (!/^[a-f0-9-]{36}$/.test(identity.toString('utf8')) || db.prepare('SELECT identity FROM speech_identity WHERE id=1').get()?.['identity'] !== identity.toString('utf8')) refuse('speech-identity-mismatch', 'Speech journal and durable identity differ; preserve both and reconcile, never provision a replacement.');
  if (db.prepare('PRAGMA user_version').get()?.['user_version'] !== 1) refuse('unsupported-version', 'Only reviewed speech journal schema 1 is supported.');
  const integrity = db.prepare('PRAGMA integrity_check').all();
  if (integrity.length !== 1 || integrity[0]?.['integrity_check'] !== 'ok' || db.prepare('PRAGMA foreign_key_check').all().length) refuse('database-corrupt', 'Speech journal integrity checks failed.');
  for (const name of ['speech_identity', 'speech_policy', 'speech_calls']) if (!db.prepare('SELECT name FROM sqlite_master WHERE type=\'table\' AND name=?').get(name)) refuse('database-corrupt', 'Required speech financial history table is missing.');
}
function speechImage(journal: string, identityPath: string): { data: Buffer; identity: Buffer } {
  try {
    privateSpeechPath(dirname(journal), true); privateSpeechPath(journal); privateSpeechPath(identityPath);
    for (const suffix of ['-wal', '-shm', '-journal']) if (existsSync(`${journal}${suffix}`)) privateSpeechPath(`${journal}${suffix}`);
    const identity = readRegular(identityPath);
    const db = new DatabaseSync(journal, { readOnly: true });
    try {
      inspectSpeechDatabase(db, identity);
      const tables: unknown[] = [];
      for (const row of db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' ORDER BY name").all()) {
        const name = String(row['name']);
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) refuse('database-corrupt', 'Unexpected speech table name.');
        tables.push([name, row['sql'], db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]);
      }
      const data = Buffer.from(JSON.stringify({ version: 1, tables })); screen(data, 'speech financial history');
      return { data, identity };
    } finally { db.close(); }
  } catch (error) {
    if (error instanceof OperationError) throw error;
    refuse('speech-journal-unavailable', 'Configured speech pair is missing, corrupt or unreadable. Preserve it; no initialization or replacement is permitted.');
  }
}
function verifySpeechHold(sources: StateSources, maintenance?: MaintenanceEvidence, verifyQuiescence?: () => void): void {
  const pair = speechPair(sources); if (!pair) return;
  if (!maintenance || !verifyQuiescence) refuse('speech-maintenance-required', 'Configured speech inspection requires an explicit whole-writer hold, including every independent instance/process.');
  verifyMaintenance(maintenance);
  const speech = maintenance.speechWriters;
  if (!speech || speech.journal !== pair.journal || speech.identity !== pair.identity || !speech.allInstancesStopped || !speech.restartPrevented || !speech.evidence?.trim()) refuse('speech-maintenance-required', 'Inventory and stop all writers of this exact speech pair and prevent restart. A host lease or PID absence is not a speech hold.');
  verifyQuiescence();
}
function capture(sources: StateSources): Capture {
  const files = new Map<string, Buffer>(); const excluded: string[] = [];
  const image = databaseImage(sources.productDatabase);
  files.set('product-logical-image', image.data);
  const pair = speechPair(sources);
  if (pair) {
    privateSpeechPath(dirname(sources.productDatabase), true);
    const speech = speechImage(pair.journal, pair.identity);
    files.set('speech-logical-image', speech.data); files.set('speech.sqlite.identity', speech.identity);
  }
  tree(sources.coordinatorRoot, 'coordinator', files, excluded);
  if (sources.environmentRoot) tree(sources.environmentRoot, 'environments', files, excluded);
  if (sources.artifactRoot) tree(sources.artifactRoot, 'artifacts', files, excluded);
  const fingerprint = digest(JSON.stringify([...files].map(([path, data]) => [path, digest(data)])));
  return { files, excluded, fingerprint, productVersion: image.version };
}
function sourceRoots(sources: StateSources): string[] { return [dirname(sources.productDatabase), dirname(sources.productLeasePath), sources.coordinatorRoot, ...(sources.environmentRoot ? [sources.environmentRoot] : []), ...(sources.artifactRoot ? [sources.artifactRoot] : [])].map(path => resolve(path)); }
function inventory(files: Map<string, Buffer>): InventoryFile[] { return [...files].map(([path, data]) => ({ path, sha256: digest(data), bytes: data.length })); }
function acquireStateLeases(sources: StateSources, includeBroker = true): () => void {
  const releases: (() => void)[] = [];
  try {
    // Main and the broker must hold these same stable inode leases for their entire writer lifetime.
    // No new lock is claimed to fence legacy coordinator writers; their owner hold is mandatory.
    releases.push(acquireFileLease(canonical(sources.productLeasePath, false)));
    if (includeBroker && sources.environmentRoot) releases.push(acquireFileLease(canonical(join(sources.environmentRoot, 'broker.lock'), false)));
  } catch (error) {
    for (const release of releases.reverse()) release();
    if (error instanceof OperationError) throw error;
    refuse('state-lease-unavailable', 'Product/broker lifetime lease unavailable. Stop the actual owning writer under owner maintenance; never unlink a stable lock inode.');
  }
  return () => { for (const release of releases.reverse()) release(); };
}
export function backupWorkspace(options: BackupOptions): BackupManifest {
  const release = acquireStateLeases(options.sources);
  try { return backupHeld(options); } finally { release(); }
}
function backupHeld(options: BackupOptions): BackupManifest {
  verifyMaintenance(options.maintenance); options.verifyQuiescence();
  verifySpeechHold(options.sources, options.maintenance, options.verifyQuiescence);
  if (!options.productBuild?.trim() || !options.coordinatorBuild?.trim()) refuse('build-identity-required', 'Record actual build identities; an unknown loaded build must be stated as unknown with inspection evidence.');
  const before = capture(options.sources);
  const destination = newDestination(options.destination, sourceRoots(options.sources));
  options.checkpoint?.('created');
  const databasePath = join(destination, 'product.sqlite');
  const db = new DatabaseSync(canonical(options.sources.productDatabase, false), { readOnly: true });
  try { db.prepare('VACUUM INTO ?').run(databasePath); } finally { db.close(); }
  chmodSync(databasePath, 0o600);
  const snapshot = new DatabaseSync(databasePath, { readOnly: true });
  try { inspectDatabase(snapshot); } finally { snapshot.close(); }
  const copiedImage = databaseImage(databasePath);
  if (!copiedImage.data.equals(before.files.get('product-logical-image')!)) refuse('state-changed', 'Workspace changed during snapshot; incomplete backup retained, not committed.');
  const files = new Map(before.files); files.delete('product-logical-image'); files.set('product.sqlite', readRegular(databasePath));
  const pair = speechPair(options.sources);
  if (pair) {
    const path = join(destination, 'speech.sqlite');
    // SQLite reads committed state consistently, including WAL. Never copy or checkpoint a live main file.
    const speech = new DatabaseSync(pair.journal, { readOnly: true });
    try { speech.prepare('VACUUM INTO ?').run(path); } finally { speech.close(); }
    chmodSync(path, 0o600);
    durableWrite(join(destination, 'speech.sqlite.identity'), before.files.get('speech.sqlite.identity')!);
    const copied = speechImage(path, join(destination, 'speech.sqlite.identity'));
    if (!copied.data.equals(before.files.get('speech-logical-image')!)) refuse('state-changed', 'Speech financial history changed during snapshot; preserve incomplete output and liabilities.');
    files.delete('speech-logical-image'); files.set('speech.sqlite', readRegular(path));
    const fd = openSync(path, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
  }
  // SQLite created this file itself. Make its bytes durable before committing the manifest.
  const fd = openSync(databasePath, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
  for (const [path, data] of files) if (!['product.sqlite', 'speech.sqlite', ...(pair ? ['speech.sqlite.identity'] : [])].includes(path)) durableWrite(join(destination, path), data);
  options.checkpoint?.('copied');
  options.verifyQuiescence(); verifyMaintenance(options.maintenance);
  verifySpeechHold(options.sources, options.maintenance, options.verifyQuiescence);
  const after = capture(options.sources);
  if (after.fingerprint !== before.fingerprint || JSON.stringify(after.excluded) !== JSON.stringify(before.excluded)) refuse('state-changed', 'Source changed while capturing; legacy writers were not fenced. Incomplete output retained for inspection.');
  const manifest: BackupManifest = { format: 1, kind: 'spatial-workspace-backup', operationId: randomUUID(), completedAt: new Date().toISOString(), productVersion: before.productVersion, ...(pair ? { speechJournalVersion: 1 as const } : {}), productBuild: options.productBuild, coordinatorBuild: options.coordinatorBuild, sourceFingerprint: before.fingerprint, files: inventory(files), excluded: before.excluded, maintenance: options.maintenance };
  options.checkpoint?.('before-commit');
  for (const [path, data] of files) {
    const written = readRegular(canonical(join(destination, path), false));
    if (!written.equals(data)) refuse('backup-corrupt', 'Written backup bytes changed before commit; source history remains untouched.');
    screen(written, path);
  }
  if (pair) speechImage(join(destination, 'speech.sqlite'), join(destination, 'speech.sqlite.identity'));
  verifyMaintenance(options.maintenance); options.verifyQuiescence();
  verifySpeechHold(options.sources, options.maintenance, options.verifyQuiescence);
  if (capture(options.sources).fingerprint !== before.fingerprint) refuse('state-changed', 'Source changed before backup commit; no completed backup was published.');
  screen(Buffer.from(JSON.stringify(manifest)), 'backup maintenance/build metadata');
  durableWrite(join(destination, 'backup.json'), JSON.stringify(manifest, null, 2)); syncDirectory(destination);
  return manifest;
}
export function verifyBackup(path: string): BackupManifest {
  const root = canonical(path, true);
  const manifest = JSON.parse(readRegular(join(root, 'backup.json')).toString('utf8')) as BackupManifest;
  if (manifest.format !== 1 || manifest.kind !== 'spatial-workspace-backup' || ![1, 2, 3].includes(manifest.productVersion) || !Array.isArray(manifest.files) || !manifest.files.some(file => file.path === 'product.sqlite')) refuse('invalid-backup', 'A supported completed backup manifest is required.');
  const seen = new Set<string>();
  for (const file of manifest.files) {
    safeRelative(file.path);
    if (seen.has(file.path) || (!['product.sqlite', 'speech.sqlite', 'speech.sqlite.identity'].includes(file.path) && !/^(coordinator|environments|artifacts)\//.test(file.path))) refuse('invalid-backup', 'Duplicate or unsupported backup member.');
    seen.add(file.path);
    const member = canonical(join(root, file.path), false);
    const data = readRegular(member);
    if (data.length !== file.bytes || digest(data) !== file.sha256) refuse('backup-corrupt', 'Backup member hash/length mismatch. Preserve it and select a verified backup.');
    screen(data, file.path);
  }
  const hasSpeech = seen.has('speech.sqlite');
  if (hasSpeech !== seen.has('speech.sqlite.identity') || (hasSpeech ? manifest.speechJournalVersion !== 1 : manifest.speechJournalVersion !== undefined)) refuse('invalid-backup', 'A speech backup requires both members and reviewed schema metadata.');
  if (hasSpeech) speechImage(join(root, 'speech.sqlite'), join(root, 'speech.sqlite.identity'));
  const allowed = new Set([...seen, 'backup.json', 'INCOMPLETE.json']);
  const checkMembers = (directory: string, prefix: string) => {
    for (const name of readdirSync(directory)) {
      const memberPath = [prefix, name].filter(Boolean).join('/');
      const stat = lstatSync(join(directory, name));
      if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) refuse('unsafe-path', 'Backup contains an unverified link or special file.');
      if (stat.isDirectory()) checkMembers(join(directory, name), memberPath);
      else if (!allowed.has(memberPath)) refuse('unlisted-backup-member', 'Backup contains unlisted data; preserve it and reconcile against a fresh complete inventory.');
    }
  };
  checkMembers(root, '');
  const db = new DatabaseSync(join(root, 'product.sqlite'), { readOnly: true });
  try { if (inspectDatabase(db) !== manifest.productVersion) refuse('invalid-backup', 'Manifest schema version does not match its database.'); } finally { db.close(); }
  return manifest;
}
export interface RestoreOptions {
  backup: string; destination: string; current: StateSources; checkpoint?: (phase: string) => void;
  /** Required when current speech is configured; inspection must not race independent writers. */
  maintenance?: MaintenanceEvidence;
  verifyQuiescence?: () => void;
}
export interface DetachedRestore { destination: string; backupOperationId: string; activation: 'blocked'; currentFingerprint: string }
/** Inspection only. This API has deliberately no activation, service, grant or live replacement operation. */
export function restoreDetached(options: RestoreOptions): DetachedRestore {
  const release = acquireStateLeases(options.current);
  try { return restoreHeld(options); } finally { release(); }
}
function restoreHeld(options: RestoreOptions): DetachedRestore {
  verifySpeechHold(options.current, options.maintenance, options.verifyQuiescence);
  const manifest = verifyBackup(options.backup);
  if ((manifest.speechJournalVersion === 1) !== !!speechPair(options.current)) refuse('speech-inventory-mismatch', 'Backup and current speech inventory differ; reconcile the configured financial journal before recovery.');
  const current = capture(options.current);
  const destination = newDestination(options.destination, [...sourceRoots(options.current), resolve(options.backup)]);
  options.checkpoint?.('created');
  for (const file of manifest.files) {
    // Original authority and launch settings are evidence, NEVER a runnable restored coordinator root.
    const target = file.path.startsWith('coordinator/') ? `coordinator-history/${file.path.slice('coordinator/'.length)}` : file.path;
    const data = readRegular(join(options.backup, file.path));
    if (digest(data) !== file.sha256 || data.length !== file.bytes) refuse('backup-corrupt', 'Backup changed after verification; detached restore remains incomplete.');
    durableWrite(join(destination, target), data);
  }
  options.checkpoint?.('copied');
  const verifiedAgain = verifyBackup(options.backup);
  if (JSON.stringify(verifiedAgain) !== JSON.stringify(manifest)) refuse('backup-corrupt', 'Backup manifest changed during restore.');
  for (const file of manifest.files) {
    const target = file.path.startsWith('coordinator/') ? `coordinator-history/${file.path.slice('coordinator/'.length)}` : file.path;
    const data = readRegular(canonical(join(destination, target), false));
    if (data.length !== file.bytes || digest(data) !== file.sha256) refuse('backup-corrupt', 'Written detached restore bytes differ from their inventory; activation remains forbidden.');
  }
  if (manifest.speechJournalVersion === 1) speechImage(join(destination, 'speech.sqlite'), join(destination, 'speech.sqlite.identity'));
  verifySpeechHold(options.current, options.maintenance, options.verifyQuiescence);
  const after = capture(options.current);
  if (current.fingerprint !== after.fingerprint) refuse('current-state-changed', 'Newer current work changed during inspection; no current state was overwritten. Reconcile from a fresh inventory.');
  const result: DetachedRestore = { destination, backupOperationId: manifest.operationId, activation: 'blocked', currentFingerprint: current.fingerprint };
  durableWrite(join(destination, 'RESTORE-BLOCKED.json'), JSON.stringify({ ...result, reason: 'Detached evidence only. No credentials/lock namespace restored. Historical grants, reservations and remote identities are NOT permission to execute. Requires existing reviewed explicit owner cutover and fresh current-store reconciliation.' }, null, 2));
  return result;
}
export interface MigrationRehearsal { state: 'compatible' | 'rolled-back'; error: string | null; destination: string; fromVersion: number; toVersion: number }
/** Runs reviewed migration code inside one transaction on a NEW detached copy, never on live state. */
export function rehearseMigration(options: RestoreOptions & { toVersion: number; migrate: (db: DatabaseSync) => void }): MigrationRehearsal {
  const restored = restoreDetached(options);
  if (!Number.isSafeInteger(options.toVersion) || options.toVersion < 1) refuse('invalid-version', 'A concrete candidate schema version is required.');
  const path = join(restored.destination, 'product.sqlite'); const before = databaseImage(path);
  const db = new DatabaseSync(path); let error: string | null = null;
  try {
    db.exec('PRAGMA foreign_keys = ON; BEGIN IMMEDIATE;');
    options.migrate(db);
    if (!db.isTransaction) refuse('migration-contract', 'Migration must not commit/rollback its outer transaction.');
    const version = Number(db.prepare('PRAGMA user_version').get()?.['user_version']);
    if (version !== options.toVersion || db.prepare('PRAGMA integrity_check').get()?.['integrity_check'] !== 'ok' || db.prepare('PRAGMA foreign_key_check').all().length) refuse('migration-invalid', 'Candidate schema version/integrity checks failed.');
    db.exec('COMMIT');
  } catch (failure) {
    if (db.isTransaction) db.exec('ROLLBACK');
    error = failure instanceof OperationError ? failure.code : 'migration-failed';
  } finally { db.close(); }
  if (error && !databaseImage(path).data.equals(before.data)) refuse('rollback-failed', 'Detached rollback did not preserve original records. Retain the directory; do not activate.');
  const result: MigrationRehearsal = { state: error ? 'rolled-back' : 'compatible', error, destination: restored.destination, fromVersion: before.version, toVersion: options.toVersion };
  durableWrite(join(restored.destination, 'migration-rehearsal.json'), JSON.stringify(result, null, 2));
  return result;
}
export function checkRollbackUnchanged(backup: string, current: StateSources, maintenance: MaintenanceEvidence, verifyQuiescence: () => void): void {
  const release = acquireStateLeases(current);
  try {
    verifyMaintenance(maintenance); verifyQuiescence(); verifySpeechHold(current, maintenance, verifyQuiescence);
    const manifest = verifyBackup(backup);
    if ((manifest.speechJournalVersion === 1) !== !!speechPair(current)) refuse('speech-inventory-mismatch', 'Rollback inventory must include the exact configured speech pair.');
    if (capture(current).fingerprint !== manifest.sourceFingerprint) refuse('newer-work', 'Whole-store rollback is unsafe: newer attempts, reservations, evidence or owner controls exist. Preserve them and reconcile; this API never overwrites state.');
    verifyQuiescence(); verifyMaintenance(maintenance); verifySpeechHold(current, maintenance, verifyQuiescence);
    if (capture(current).fingerprint !== manifest.sourceFingerprint) refuse('newer-work', 'Current history changed during rollback inspection; no state was overwritten.');
  } finally { release(); }
}
export interface CleanupEvidence {
  taskId: string; coordinatorTaskId: string; terminal: boolean;
  activeRunIds: string[]; uncertainRunIds: string[]; reservationIds: string[];
  evidenceRefs: string[]; inspectedAt: string;
}
/** Exact owner-only broker contract; a Buffer-only export cannot preserve raw metadata. */
export type EnvironmentArchive = ExportArtifact;
export interface CleanupPort {
  snapshot(taskId: string): EnvironmentSnapshot;
  exportArchive(taskId: string, epoch: number): Promise<EnvironmentArchive>;
  archive(taskId: string, epoch: number): Promise<EnvironmentSnapshot>;
  destroy(taskId: string, epoch: number): Promise<void>;
}
export interface CleanupOptions {
  taskId: string; expectedEpoch: number; destination: string; environment: CleanupPort;
  current: StateSources;
  /** Trusted coordinator-backed inspection, not task/model declarations. Re-read before destruction. */
  inspect: () => Promise<CleanupEvidence>;
  maintenance: MaintenanceEvidence;
  verifyQuiescence: () => void;
  destroy: boolean;
  /** Cancellation never authorizes cleanup; incomplete private output is retained. */
  signal?: AbortSignal;
  /** Failure injection only; receives no exported bytes or secrets. */
  checkpoint?: (phase: string) => void;
}
// Prefix detection is intentionally conservative: quoted credential names refuse even
// without a colon. Removing escapes/NULs catches serialized JSON and UTF-16 text.
// Every signature has a bounded identifying prefix, so 512 characters cover splits
// without buffering a whole file or losing long tokens/whitespace across chunks.
const streamedSecretField = /["'](?:api[_-]?key|access[_-]?token|refresh[_-]?token|tokenHash|password|client[_-]?secret|private[_-]?key|authorization)["']/i;
const streamedSecretValue = /PRIVATE KEY-----|sw_[a-f0-9]{64}|sk-(?:proj-)?[A-Za-z0-9_-]{20}|gh[pousr]_[A-Za-z0-9]{20}|Bearer\s/;
function streamMeter(expected: InventoryFile): { meter: Transform; finish: () => void } {
  const hash = createHash('sha256'); const decoder = new StringDecoder('utf8'); let bytes = 0; let tail = '';
  const inspect = (text: string) => {
    const joined = tail + text.replace(/[\\\0]/g, '');
    if (streamedSecretField.test(joined) || streamedSecretValue.test(joined)) refuse('secret-in-state', 'Secret-shaped artifact or archive content; no destructive cleanup allowed.');
    tail = joined.slice(-512);
  };
  const meter = new Transform({ transform(chunk: Buffer, _encoding, callback) {
    try {
      if (!Buffer.isBuffer(chunk)) refuse('unsafe-export', 'Export must stream binary bytes.');
      bytes += chunk.length;
      if (!Number.isSafeInteger(bytes) || bytes > expected.bytes) refuse('archive-corrupt', 'Export exceeds declared length; no partial archive accepted.');
      hash.update(chunk); inspect(decoder.write(chunk)); callback(null, chunk);
    } catch (error) { callback(error as Error); }
  } });
  return { meter, finish: () => {
    inspect(decoder.end());
    if (bytes !== expected.bytes || hash.digest('hex') !== expected.sha256) refuse('archive-corrupt', 'Export hash/length mismatch; environment retained.');
  } };
}
function validateStream(stream: ArchiveStream): void {
  if (!stream || !Number.isSafeInteger(stream.bytes) || stream.bytes < 0 || !/^[a-f0-9]{64}$/.test(stream.sha256) || typeof stream.open !== 'function') refuse('unsafe-export', 'A complete byte count, SHA-256 and binary stream opener are required.');
}
function cancelled(signal?: AbortSignal): void { signal?.throwIfAborted(); }
async function writeArtifact(path: string, stream: ArchiveStream, expected: InventoryFile, signal?: AbortSignal): Promise<void> {
  cancelled(signal); mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const fd = openSync(path, 'wx', 0o600);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077)) refuse('private-output-required', 'Archive must be a private regular file.');
    const { meter, finish } = streamMeter(expected);
    // Keep fd ownership outside pipeline: fs streams may close even autoClose:false
    // descriptors when destroyed on failure, masking the original refusal with EBADF.
    const output = new Writable({ write(chunk: Buffer, _encoding, callback) {
      try {
        let offset = 0;
        while (offset < chunk.length) {
          const written = writeSync(fd, chunk, offset, chunk.length - offset);
          if (written <= 0) refuse('archive-write-failed', 'Artifact write made no progress.');
          offset += written;
        }
        callback();
      } catch (error) { callback(error as Error); }
    } });
    await pipeline(stream.open(), meter, output, { signal });
    finish(); fsyncSync(fd);
  } finally { closeSync(fd); syncDirectory(dirname(path)); }
}
async function verifyArtifact(path: string, expected: InventoryFile, signal?: AbortSignal): Promise<void> {
  cancelled(signal); canonical(path, false);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) || stat.size !== expected.bytes) refuse('archive-corrupt', 'Written archive is not the declared private regular file.');
    const { meter, finish } = streamMeter(expected);
    const source = Readable.from((function* () {
      while (true) {
        const chunk = Buffer.allocUnsafe(65536); const count = readSync(fd, chunk);
        if (count === 0) return;
        yield chunk.subarray(0, count);
      }
    })());
    await pipeline(source, meter, new Writable({ write(_chunk, _encoding, callback) { callback(); } }), { signal }); finish();
  } finally { closeSync(fd); }
}
// Independent read-only tar inventory and decoded-content screening. Never extracts
// onto the host. Unsupported compressed/encrypted containers refuse, not truncate.
// Only decoding has a 1 GiB work budget/depth limit; ordinary file sizes are uncapped.
const SCREEN_ARCHIVE = String.raw`
import base64, bz2, gzip, hashlib, io, json, lzma, os, re, stat, sys, tarfile
class Refusal(Exception):
 def __init__(self, code): self.code = code
def refuse(code): raise Refusal(code)
field = re.compile(r'''["'](?:api[_-]?key|access[_-]?token|refresh[_-]?token|tokenHash|password|client[_-]?secret|private[_-]?key|authorization)["']''', re.I)
value = re.compile(r'PRIVATE KEY-----|sw_[a-f0-9]{64}|sk-(?:proj-)?[A-Za-z0-9_-]{20}|gh[pousr]_[A-Za-z0-9]{20}|Bearer\s')
secret_name = re.compile(r'^(auth|tls|providers?|credentials?|secrets?|\.env(?:\..*)?|clients\.json|host-key\.pem|host-cert\.pem|.*\.(?:pem|key|p12|pfx|keystore))$', re.I)
def check(text):
 text = text.replace('\\', '').replace('\x00', '')
 if field.search(text) or value.search(text): refuse('secret-in-state')
def safe(name, root=False):
 if root and name == '': return
 if not name or name.startswith('/') or '\\' in name or '\x00' in name or any(p in ['', '.', '..'] for p in name.split('/')): refuse('unsafe-export')
 if any(secret_name.fullmatch(p) for p in name.split('/')): refuse('unsafe-export')
def scan(source, decoded=False, depth=0):
 global budget
 if depth > 4: refuse('unsupported-content')
 source = io.BufferedReader(source)
 prefix = source.peek(8)[:8]
 decoder = None
 if prefix.startswith(b'\x1f\x8b'): decoder = gzip.GzipFile(fileobj=source)
 elif prefix.startswith(b'BZh'): decoder = bz2.BZ2File(source)
 elif prefix.startswith(b'\xfd7zXZ\x00'): decoder = lzma.LZMAFile(source)
 elif prefix.startswith((b'PK\x03\x04', b'PK\x05\x06', b'PK\x07\x08', b'7z\xbc\xaf\x27\x1c', b'Rar!', b'\x28\xb5\x2f\xfd')): refuse('unsupported-content')
 if decoder is not None:
  with decoder: scan(decoder, True, depth+1)
  return
 tail = ''
 while True:
  chunk = source.read(65536)
  if not chunk: break
  if decoded:
   budget -= len(chunk)
   if budget < 0: refuse('unsupported-content')
  text = tail + chunk.decode('utf-8', 'ignore').replace('\\', '').replace('\x00', '')
  check(text); tail = text[-512:]
try:
 budget = 1073741824
 expected = {f['path']: (f['bytes'], f['sha256']) for f in json.load(sys.stdin)}
 fd = os.open(sys.argv[1], os.O_RDONLY | os.O_NOFOLLOW)
 st = os.fstat(fd)
 if not stat.S_ISREG(st.st_mode) or st.st_mode & 0o077 or st.st_nlink != 1: refuse('archive-corrupt')
 with os.fdopen(fd, 'rb') as source:
  seen = {}; found = {}
  with tarfile.open(fileobj=source, mode='r:') as archive:
   for member in archive:
    name = member.name
    if name.startswith('/'): refuse('unsafe-export')
    if name.startswith('./'): name = name[2:]
    if member.isdir() and name.endswith('/'): name = name[:-1]
    if name == '.': name = ''
    safe(name, member.isdir())
    if name in seen or (not member.isdir() and not member.isreg()) or member.sparse is not None: refuse('unsafe-export')
    if len(seen) >= 100000: refuse('unsafe-export')
    seen[name] = 'dir' if member.isdir() else 'file'
    if member.size < 0 or member.offset_data + member.size > st.st_size or (member.isdir() and member.size): refuse('archive-corrupt')
    check(json.dumps(dict(name=member.name, uname=member.uname, gname=member.gname, pax=member.pax_headers)))
    for key, val in member.pax_headers.items():
     if 'sparse' in key.lower() or key in ['linkpath', 'SCHILY.filetype']: refuse('unsafe-export')
     if key not in ['path', 'size', 'uid', 'gid', 'uname', 'gname', 'mtime', 'atime', 'ctime'] and not key.startswith('SCHILY.xattr.'): refuse('unsafe-export')
     if key.startswith('SCHILY.xattr.'):
      if re.search(r'(api[_-]?key|token|password|secret|private[_-]?key|authorization)', key, re.I): refuse('secret-in-state')
      scan(io.BytesIO(val.encode('utf8')))
      # Some xattr writers encode binary values as base64; inspect valid encodings too.
      try: decoded = base64.b64decode(val, validate=True)
      except ValueError: decoded = b''
      if decoded: scan(io.BytesIO(decoded))
    if member.isreg():
     if name not in expected: refuse('unsafe-export')
     h = hashlib.sha256(); count = 0
     with archive.extractfile(member) as content:
      while True:
       data = content.read(1048576)
       if not data: break
       h.update(data); count += len(data)
     if (count, h.hexdigest()) != expected[name]: refuse('archive-corrupt')
     found[name] = True
     with archive.extractfile(member) as content: scan(content)
   end = archive.offset
  if set(found) != set(expected): refuse('unsafe-export')
  for name in seen:
   parts = name.split('/')
   if any(seen.get('/'.join(parts[:i])) == 'file' for i in range(1, len(parts))): refuse('unsafe-export')
  source.seek(end)
  trailer = source.read(1024)
  if len(trailer) != 1024 or any(trailer) or st.st_size % 512: refuse('archive-corrupt')
  while True:
   tail = source.read(1048576)
   if not tail: break
   if any(tail): refuse('archive-corrupt')
  after = os.fstat(source.fileno())
  if (st.st_size, st.st_mtime_ns, st.st_ctime_ns) != (after.st_size, after.st_mtime_ns, after.st_ctime_ns): refuse('archive-corrupt')
except Refusal as error:
 print(error.code); sys.exit(1)
except Exception:
 print('archive-corrupt'); sys.exit(1)
`;
async function verifyTar(path: string, files: InventoryFile[], signal?: AbortSignal): Promise<void> {
  cancelled(signal);
  await new Promise<void>((accept, reject) => {
    const child = spawn('python3', ['-I', '-c', SCREEN_ARCHIVE, path], { stdio: ['pipe', 'pipe', 'ignore'], env: { PATH: process.env.PATH ?? '/usr/bin:/bin' } });
    let output = ''; let timedOut = false;
    const abort = () => child.kill('SIGKILL');
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 300_000);
    child.stdout.on('data', (chunk: Buffer) => { output = (output + chunk.toString()).slice(-128); });
    child.stdin.on('error', () => { /* close reports a failed verifier */ });
    const clear = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    child.on('error', error => { clear(); reject(error); });
    child.on('close', code => {
      clear();
      if (signal?.aborted) { reject(signal.reason); return; }
      if (code === 0 && !timedOut) { accept(); return; }
      const reason = output.trim();
      reject(new OperationError(['secret-in-state', 'unsafe-export', 'unsupported-content'].includes(reason) ? reason : 'archive-corrupt', 'Raw tar validation/content screening failed; retain environment and private output.'));
    });
    child.stdin.end(JSON.stringify(files));
    if (signal?.aborted) abort();
  });
}
function cleanupSafe(evidence: CleanupEvidence, taskId: string): void {
  if (evidence.taskId !== taskId || !evidence.coordinatorTaskId || !evidence.terminal || evidence.activeRunIds.length || evidence.uncertainRunIds.length || evidence.reservationIds.length || !evidence.evidenceRefs.length || !Number.isFinite(Date.parse(evidence.inspectedAt)) || Math.abs(Date.now() - Date.parse(evidence.inspectedAt)) > 60_000) refuse('cleanup-blocked', 'Cleanup requires fresh terminal coordinator evidence, no active/uncertain work and no held reservations. Preserve artifacts and reconcile first.');
}
export async function archiveEnvironment(options: CleanupOptions): Promise<{ archive: string; destroyed: boolean }> {
  // A maintenance-only broker retains its own lease and performs verified inactive export/cleanup.
  // The main writer must be absent; holding its product lease also excludes a concurrent restart.
  const release = acquireStateLeases(options.current, false);
  try { return await archiveHeld(options); } finally { release(); }
}
async function archiveHeld(options: CleanupOptions): Promise<{ archive: string; destroyed: boolean }> {
  cancelled(options.signal); verifyMaintenance(options.maintenance); options.verifyQuiescence();
  const evidence = await options.inspect(); cleanupSafe(evidence, options.taskId); cancelled(options.signal);
  const snapshot = options.environment.snapshot(options.taskId);
  if (snapshot.taskId !== options.taskId || snapshot.lease.taskId !== options.taskId || !['stopped', 'archived'].includes(snapshot.state) || snapshot.lease.epoch !== options.expectedEpoch) refuse('cleanup-blocked', 'Environment must be verifiably stopped/archived at the current epoch; this operation never stops live work.');
  const archive = await options.environment.exportArchive(options.taskId, options.expectedEpoch);
  if (archive.taskId !== options.taskId || archive.environmentId !== snapshot.environmentId || archive.epoch !== options.expectedEpoch) refuse('stale-export', 'Export identity or epoch differs from the stopped task.');
  if (!Array.isArray(archive.files) || archive.files.length > 100_000) refuse('unsafe-export', 'A complete bounded inventory is required; no partial archive accepted.');
  validateStream(archive.rawArchive);
  const seen = new Set<string>(); const files: InventoryFile[] = [];
  for (const file of archive.files) {
    safeRelative(file.path); validateStream(file);
    if (file.path.split('/').some(part => secretName.test(part)) || seen.has(file.path)) refuse('unsafe-export', 'Secret or duplicate artifact path; no destructive cleanup allowed.');
    seen.add(file.path); files.push({ path: file.path, bytes: file.bytes, sha256: file.sha256 });
  }
  for (const path of seen) {
    const parts = path.split('/');
    if (parts.some((_part, index) => index > 0 && seen.has(parts.slice(0, index).join('/')))) refuse('unsafe-export', 'A file cannot also be an artifact directory.');
  }
  const rawArchive: InventoryFile = { path: 'workspace.tar', bytes: archive.rawArchive.bytes, sha256: archive.rawArchive.sha256 };
  const destination = newDestination(options.destination, sourceRoots(options.current));
  options.checkpoint?.('created'); cancelled(options.signal);
  for (const [index, file] of archive.files.entries()) await writeArtifact(join(destination, 'workspace', file.path), file, files[index]!, options.signal);
  await writeArtifact(join(destination, rawArchive.path), archive.rawArchive, rawArchive, options.signal);
  options.checkpoint?.('copied');
  const manifest = { format: 2, kind: 'task-environment-archive', taskId: options.taskId, environmentId: archive.environmentId, epoch: archive.epoch, evidence, files, rawArchive };
  const manifestJson = JSON.stringify(manifest, null, 2);
  screen(Buffer.from(manifestJson), 'archive identity/evidence metadata');
  const verifyWritten = async (committed: boolean) => {
    cancelled(options.signal);
    const current = options.environment.snapshot(options.taskId);
    if (current.taskId !== options.taskId || current.environmentId !== archive.environmentId || current.lease.epoch !== archive.epoch || !['stopped', 'archived'].includes(current.state)) refuse('stale-export', 'Environment identity/epoch changed during export.');
    for (const file of files) await verifyArtifact(join(destination, 'workspace', file.path), file, options.signal);
    await verifyArtifact(join(destination, rawArchive.path), rawArchive, options.signal);
    await verifyTar(join(destination, rawArchive.path), files, options.signal);
    const allowed = new Set(['INCOMPLETE.json', rawArchive.path, ...(committed ? ['archive.json'] : []), ...files.map(file => `workspace/${file.path}`)]);
    const directories = new Set<string>();
    for (const path of allowed) { const parts = path.split('/'); for (let i = 1; i < parts.length; i++) directories.add(parts.slice(0, i).join('/')); }
    const walk = (directory: string, prefix: string) => {
      for (const name of readdirSync(directory)) {
        const path = [prefix, name].filter(Boolean).join('/'); const stat = lstatSync(join(directory, name));
        if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) refuse('unsafe-export', 'Written archive contains a link or special file.');
        if (stat.isDirectory()) { if (!directories.has(path) || (stat.mode & 0o077)) refuse('unsafe-export', 'Unexpected or non-private archive directory.'); walk(join(directory, name), path); }
        else if (!allowed.has(path)) refuse('unsafe-export', 'Unexpected archive member.');
      }
    };
    if (lstatSync(destination).mode & 0o077) refuse('private-output-required', 'Archive destination is no longer private.');
    walk(canonical(destination, true), '');
    if (committed && readRegular(join(destination, 'archive.json')).toString('utf8') !== manifestJson) refuse('archive-corrupt', 'Archive inventory changed after commit.');
    cancelled(options.signal);
  };
  await verifyWritten(false);
  durableWrite(join(destination, 'archive.json'), manifestJson);
  const fresh = await options.inspect(); cleanupSafe(fresh, options.taskId);
  if (fresh.coordinatorTaskId !== evidence.coordinatorTaskId) refuse('cleanup-blocked', 'Coordinator task identity changed.');
  verifyMaintenance(options.maintenance); options.verifyQuiescence();
  options.checkpoint?.('before-archive'); await verifyWritten(true);
  cleanupSafe(fresh, options.taskId); verifyMaintenance(options.maintenance); options.verifyQuiescence(); cancelled(options.signal);
  await options.environment.archive(options.taskId, options.expectedEpoch);
  if (options.destroy) {
    const finalEvidence = await options.inspect(); cleanupSafe(finalEvidence, options.taskId);
    if (finalEvidence.coordinatorTaskId !== evidence.coordinatorTaskId) refuse('cleanup-blocked', 'Coordinator task identity changed.');
    verifyMaintenance(options.maintenance); options.verifyQuiescence();
    options.checkpoint?.('before-destroy'); await verifyWritten(true);
    cleanupSafe(finalEvidence, options.taskId); verifyMaintenance(options.maintenance); options.verifyQuiescence(); cancelled(options.signal);
    await options.environment.destroy(options.taskId, options.expectedEpoch);
  }
  durableWrite(join(destination, 'cleanup-result.json'), JSON.stringify({ destroyed: options.destroy, completedAt: new Date().toISOString() }));
  return { archive: destination, destroyed: options.destroy };
}
