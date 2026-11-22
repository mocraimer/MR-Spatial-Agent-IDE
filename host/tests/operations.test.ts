import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Readable } from 'node:stream';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { PairingAuthority } from '../src/auth.js';
import { acquireFileLease } from '../src/file-lease.js';
import { WorkspaceStore } from '../src/store.js';
import {
  archiveEnvironment, backupWorkspace, checkRollbackUnchanged, OperationError,
  rehearseMigration, restoreDetached, verifyBackup, verifyMaintenance,
  type BackupOptions, type CleanupEvidence, type CleanupOptions, type CleanupPort,
  type MaintenanceEvidence, type StateSources,
} from '../src/operations.js';
import { EnvironmentBroker, type EnvironmentEngine, type EnvironmentSnapshot, type ExportArtifact } from '../src/environment-broker.js';
import { OpenAiSpeechService, SpeechError, type OpenAiSpeechOptions } from '../src/speech.js';

// Every source, output, credential and coordinator record below is labelled fixture data
// created in a NEW OS-private directory. No factory/provider/Docker/device is accessed.
function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'spatial-operations-FIXTURE-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const productRoot = join(root, 'product-state-FIXTURE'); mkdirSync(productRoot, { mode: 0o700 });
  const productDatabase = join(productRoot, 'workspace.sqlite');
  const store = new WorkspaceStore(productDatabase); t.after(() => store.close());
  const project = store.createProject({ name: 'FIXTURE operations project', purpose: 'State recovery assertions, not business data' });
  const source = store.registerSource({ spaceId: project.rootSpaceId, name: 'FIXTURE uploaded source', text: 'FIXTURE exact retained source\nwith provenance', provenance: 'FIXTURE owner text upload, not a host file connector' });
  const task = store.createTask({ idempotencyKey: 'FIXTURE-key', spaceId: project.rootSpaceId, title: 'FIXTURE uncertain worker', prompt: 'FIXTURE task', runtime: 'pi-local', model: 'FIXTURE', effort: 'high' });
  const submission = store.getSubmissionByKey('FIXTURE-key')!;
  store.updateSubmission(submission.id, { state: 'uncertain', coordinatorTaskId: 'FIXTURE-coordinator-task', runId: 'FIXTURE-run' });
  store.updateTask(task.id, { state: 'remote-uncertain', coordinatorTaskId: 'FIXTURE-coordinator-task', runId: 'FIXTURE-run', environmentId: 'FIXTURE-environment' });
  for (let i = 0; i < 75; i++) store.appendMessage({ conversationId: task.conversationId, role: 'agent', text: `FIXTURE retained message ${i}` });
  const request = store.createInboxRequest({ taskId: task.id, spaceId: task.spaceId, kind: 'review', title: 'FIXTURE inspect output', detail: 'FIXTURE not a real decision', evidence: ['evidence/FIXTURE-run/stdout.jsonl'] });
  store.updateInboxRequest(request.id, 1, { detail: 'FIXTURE second version' });
  store.respondInbox(request.id, 2, 'defer', 'FIXTURE retained decision');
  const coordinatorRoot = join(root, 'coordinator-FIXTURE'); mkdirSync(coordinatorRoot);
  const environmentRoot = join(root, 'environments-FIXTURE'); mkdirSync(environmentRoot);
  const artifactRoot = join(root, 'artifacts-FIXTURE'); mkdirSync(artifactRoot);
  const put = (path: string, value: unknown) => { const parts = path.split('/'); parts.pop(); mkdirSync(join(coordinatorRoot, ...parts), { recursive: true }); writeFileSync(join(coordinatorRoot, path), JSON.stringify(value)); };
  put('config.json', { operator: 'FIXTURE-owner' });
  put('grants/FIXTURE-grant.json', { id: 'FIXTURE-grant', version: 4, status: 'active', history: [{ change: 'narrowed', version: 4 }] });
  put('approvals/FIXTURE-approval.json', { id: 'FIXTURE-approval', version: 2 });
  put('runs/FIXTURE-run.json', { id: 'FIXTURE-run', taskId: 'FIXTURE-coordinator-task', state: 'remote-uncertain', attempt: 2, evidenceDir: '/FIXTURE-old-absolute-path' });
  put('interactive-submissions/FIXTURE.json', { idempotencyKey: 'FIXTURE-key', runId: 'FIXTURE-run' });
  put('jobs/FIXTURE-job.json', { id: 'FIXTURE-job', runs: ['FIXTURE-run'] });
  put('reservations/FIXTURE-reservation.json', { id: 'FIXTURE-reservation', runId: 'FIXTURE-run', state: 'held', estimate: { weekly: 2 } });
  put('paid-calls/FIXTURE-paid.json', { id: 'FIXTURE-paid', runId: 'FIXTURE-run', boundUsd: 0.01, state: 'reserved' });
  put('evidence/FIXTURE-run/stdout.jsonl', { type: 'FIXTURE-retained-event', identity: 'FIXTURE-run' });
  put('loop/armed.json', { repo: '/FIXTURE-do-not-launch', interval: 900 });
  put('locks/dispatch.lock', { irrelevantStableLockNamespace: true });
  put('auth/clients.json', { tokenHash: 'FIXTURE-private' });
  put('tls/host-key.pem', 'FIXTURE-private-TLS');
  put('providers/credentials.json', { api_key: 'FIXTURE-private-provider' });
  writeFileSync(join(environmentRoot, 'root-id'), 'FIXTURE-root-identity');
  writeFileSync(join(environmentRoot, 'environments.json'), JSON.stringify([{ taskId: task.id, epoch: 5, generation: 8, state: 'uncertain', rootId: 'FIXTURE-root-identity' }]));
  writeFileSync(join(artifactRoot, 'FIXTURE-result.txt'), 'FIXTURE full result');
  const productLeasePath = join(productRoot, 'host.lock'); writeFileSync(productLeasePath, 'FIXTURE diagnostic PID only');
  writeFileSync(join(environmentRoot, 'broker.lock'), 'FIXTURE diagnostic PID only');
  const sources: StateSources = { productDatabase, productLeasePath, coordinatorRoot, environmentRoot, artifactRoot };
  const maintenance: MaintenanceEvidence = { mode: 'detached-fixture', owner: 'FIXTURE-owner', reviewedCutover: 'FIXTURE-no-live-cutover', inspectedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), writers: [{ name: 'FIXTURE isolated synchronous writer', version: 'FIXTURE-schema-2', pid: null, stopped: true, restartPrevented: true, evidence: 'FIXTURE no external writers or services' }], workersAndRemoteEffectsInventoried: true, inventoryEvidence: 'FIXTURE uncertain worker records retained; no actual worker exists' };
  const options: BackupOptions = { sources, destination: join(root, 'backup'), maintenance, verifyQuiescence: () => verifyMaintenance(maintenance), productBuild: 'FIXTURE-product-build', coordinatorBuild: 'FIXTURE-coordinator-build' };
  return { root, store, source, task, submission, request, sources, options, maintenance, put };
}
function code(expected: string) { return (error: unknown) => error instanceof OperationError && error.code === expected; }

test('real WAL snapshot retains all history, versions, identities, uncertain attempts, reservations and artifacts; excludes credentials/locks', t => {
  const f = fixture(t); assert.equal(existsSync(`${f.sources.productDatabase}-wal`), true);
  const manifest = backupWorkspace(f.options);
  assert.equal(verifyBackup(f.options.destination).operationId, manifest.operationId);
  assert.ok(manifest.excluded.includes('coordinator/auth'));
  assert.ok(manifest.excluded.includes('coordinator/tls'));
  assert.ok(manifest.excluded.includes('coordinator/providers'));
  assert.ok(manifest.excluded.includes('coordinator/locks'));
  const restored = new WorkspaceStore(join(f.options.destination, 'product.sqlite'));
  try {
    assert.equal(restored.listMessages(f.task.conversationId).messages.length, 76);
    assert.deepEqual(restored.getSubmission(f.submission.id), f.store.getSubmission(f.submission.id));
    assert.deepEqual(restored.getTask(f.task.id), f.store.getTask(f.task.id));
    assert.deepEqual(restored.listInboxVersions(f.request.id), f.store.listInboxVersions(f.request.id));
    assert.deepEqual(restored.listInboxDecisions(f.request.id), f.store.listInboxDecisions(f.request.id));
    assert.deepEqual(restored.eventsAfter(0), f.store.eventsAfter(0));
    assert.equal(restored.revision, f.store.revision);
    assert.deepEqual(restored.exportHistory().sources, f.store.exportHistory().sources);
    assert.deepEqual(restored.readSourceForSpace(f.task.spaceId, f.source.id), f.store.readSourceForSpace(f.task.spaceId, f.source.id));
  } finally { restored.close(); }
  for (const path of ['runs/FIXTURE-run.json', 'reservations/FIXTURE-reservation.json', 'paid-calls/FIXTURE-paid.json', 'interactive-submissions/FIXTURE.json', 'evidence/FIXTURE-run/stdout.jsonl']) assert.deepEqual(readFileSync(join(f.options.destination, 'coordinator', path)), readFileSync(join(f.sources.coordinatorRoot, path)));
  assert.equal(readFileSync(join(f.options.destination, 'environments/root-id'), 'utf8'), 'FIXTURE-root-identity');
  assert.equal(readFileSync(join(f.options.destination, 'artifacts/FIXTURE-result.txt'), 'utf8'), 'FIXTURE full result');
});

test('actual owner source registration preserves exact text/provenance/identities through backup and detached restore', t => {
  const f = fixture(t);
  const text = 'FIXTURE retained uploaded source paragraph\n'.repeat(200);
  const provenance = 'FIXTURE owner-supplied text, reviewed source revision 7; no arbitrary host-file connector';
  const source = f.store.registerSource({ spaceId: f.task.spaceId, name: 'FIXTURE long source', text, provenance });
  backupWorkspace(f.options);
  const restored = restoreDetached({ backup: f.options.destination, current: f.sources, destination: join(f.root, 'source-restore') });
  const copied = new WorkspaceStore(join(restored.destination, 'product.sqlite'));
  try {
    assert.deepEqual(copied.readSourceForSpace(f.task.spaceId, source.id), f.store.readSourceForSpace(f.task.spaceId, source.id));
    assert.equal(copied.readSourceForSpace(f.task.spaceId, source.id).text, text);
    assert.equal(copied.readSourceForSpace(f.task.spaceId, source.id).provenance, provenance);
    assert.deepEqual(copied.exportHistory().sources, f.store.exportHistory().sources);
  } finally { copied.close(); }
});

test('schema-2 additive voice_intents are fully captured and restored without retaining raw audio', t => {
  const f = fixture(t);
  const intent = f.store.captureVoiceIntent('FIXTURE-voice-request', { spaceId: f.task.spaceId, conversationId: f.task.conversationId, taskId: f.task.id }, 'a'.repeat(64));
  backupWorkspace(f.options);
  const result = restoreDetached({ backup: f.options.destination, current: f.sources, destination: join(f.root, 'voice-restore') });
  const restored = new WorkspaceStore(join(result.destination, 'product.sqlite'));
  try { assert.deepEqual(restored.getVoiceIntent(intent.idempotencyKey), intent); assert.deepEqual(restored.exportHistory().voiceIntents, f.store.exportHistory().voiceIntents); }
  finally { restored.close(); }
  assert.throws(() => backupWorkspace({ ...f.options, destination: join(f.root, 'voice-drift'), checkpoint: phase => { if (phase === 'created') f.store.captureVoiceIntent('FIXTURE-new-voice-request', intent.receiver, 'b'.repeat(64)); } }), code('state-changed'));
});

test('schema-3 archive attempt survives complete backup/export and detached restore without reopening receivers or erasing source/history', t => {
  const f = fixture(t), receiver = { spaceId: f.task.spaceId, conversationId: f.task.conversationId, taskId: f.task.id };
  const intent = f.store.retainArchiveIntent({ archiveId: 'FIXTURE-retained-attempt', product: { kind: 'task', id: f.task.id }, receivers: [receiver], taskIds: ['FIXTURE-coordinator-task'], runIds: ['FIXTURE-run'] });
  const before = f.store.exportHistory();
  const manifest = backupWorkspace(f.options); assert.equal(manifest.productVersion, 3);
  const result = restoreDetached({ backup: f.options.destination, current: f.sources, destination: join(f.root, 'archive-restore') });
  const copied = new WorkspaceStore(join(result.destination, 'product.sqlite'));
  try {
    assert.deepEqual(copied.listArchiveIntents(), [intent]); assert.deepEqual(copied.exportHistory().archiveIntents, before.archiveIntents);
    assert.deepEqual(copied.exportHistory().sources, before.sources); assert.deepEqual(copied.exportHistory().messages, before.messages);
    assert.throws(() => copied.assertDestinationAvailable(receiver.spaceId, receiver.taskId), /archive attempt/);
    assert.throws(() => copied.updateProject(f.store.getSpace(receiver.spaceId).projectId!, { name: 'Must not mutate ancestry' }), /archive attempt/);
  } finally { copied.close(); }
});

test('refuses missing/stale maintenance, still-running writers, stage pauses and an unverified owner hold', t => {
  const f = fixture(t);
  assert.throws(() => backupWorkspace({ ...f.options, maintenance: { ...f.maintenance, expiresAt: new Date(0).toISOString() } }), code('maintenance-required'));
  assert.throws(() => verifyMaintenance({ ...f.maintenance, writers: [{ ...f.maintenance.writers[0]!, pid: process.pid }] }), code('writer-not-held'));
  assert.throws(() => verifyMaintenance({ ...f.maintenance, writers: [{ ...f.maintenance.writers[0]!, restartPrevented: false }] }), code('writer-not-held'));
  assert.throws(() => backupWorkspace({ ...f.options, verifyQuiescence: () => { throw new Error('FIXTURE hold could not be verified'); } }), /hold could not be verified/);
  assert.equal(existsSync(f.options.destination), false);
});

test('descriptor-held product/broker leases block competing ownership and their stable files survive release', t => {
  const f = fixture(t);
  const release = acquireFileLease(f.sources.productLeasePath);
  assert.throws(() => backupWorkspace(f.options), code('state-lease-unavailable')); release();
  assert.equal(existsSync(f.sources.productLeasePath), true);
  const brokerPath = join(f.sources.environmentRoot!, 'broker.lock'); const releaseBroker = acquireFileLease(brokerPath);
  assert.throws(() => backupWorkspace(f.options), code('state-lease-unavailable')); releaseBroker();
  assert.ok(existsSync(brokerPath));
  backupWorkspace(f.options);
  assert.ok(existsSync(f.sources.productLeasePath)); assert.ok(existsSync(brokerPath));
});

test('legacy writer drift is detected; a new operations lock never claims to fence it', t => {
  const f = fixture(t);
  assert.throws(() => backupWorkspace({ ...f.options, checkpoint: phase => { if (phase === 'copied') f.put('runs/FIXTURE-new-attempt.json', { id: 'FIXTURE-new-attempt' }); } }), code('state-changed'));
  assert.equal(existsSync(join(f.options.destination, 'backup.json')), false);
  assert.equal(existsSync(join(f.options.destination, 'INCOMPLETE.json')), true);
  assert.equal(existsSync(join(f.sources.coordinatorRoot, 'runs/FIXTURE-new-attempt.json')), true);
});

test('SQLite writer drift before snapshot is caught and cannot publish a mismatched cross-store backup', t => {
  const f = fixture(t);
  assert.throws(() => backupWorkspace({ ...f.options, checkpoint: phase => { if (phase === 'created') f.store.appendMessage({ conversationId: f.task.conversationId, role: 'agent', text: 'FIXTURE newly committed work' }); } }), code('state-changed'));
  assert.equal(existsSync(join(f.options.destination, 'backup.json')), false);
});

test('secret-shaped evidence fails closed rather than stripping useful history; symlinks and partial writes refuse', t => {
  const f = fixture(t);
  f.put('evidence/FIXTURE-secret.json', { api_key: 'FIXTURE-private' });
  assert.throws(() => backupWorkspace(f.options), code('secret-in-state'));
  rmSync(join(f.sources.coordinatorRoot, 'evidence/FIXTURE-secret.json'));
  f.put('runs/FIXTURE.json.tmp', { partial: true });
  assert.throws(() => backupWorkspace(f.options), code('interrupted-write'));
  rmSync(join(f.sources.coordinatorRoot, 'runs/FIXTURE.json.tmp'));
  symlinkSync(f.sources.productDatabase, join(f.sources.coordinatorRoot, 'alias'));
  assert.throws(() => backupWorkspace(f.options), code('unsafe-path'));
  assert.equal(existsSync(f.options.destination), false);
});

test('binary product state with credential-shaped transcript refuses export without mutating it', t => {
  const f = fixture(t);
  f.store.appendMessage({ conversationId: f.task.conversationId, role: 'agent', text: 'FIXTURE unsafe {"access_token":"not-a-real-token"}' });
  assert.throws(() => backupWorkspace(f.options), code('secret-in-state'));
  assert.equal(f.store.listMessages(f.task.conversationId).messages.length, 77);
});

test('interrupted process leaves a clearly incomplete output, never a fake completed backup', t => {
  const f = fixture(t);
  const module = fileURLToPath(new URL('../src/operations.js', import.meta.url));
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `import { backupWorkspace } from ${JSON.stringify(module)}; const options = ${JSON.stringify({ ...f.options, verifyQuiescence: undefined })}; backupWorkspace({...options, verifyQuiescence:()=>{}, checkpoint:phase=>{if(phase==='copied') process.exit(47);}});`], { encoding: 'utf8' });
  assert.equal(result.status, 47, result.stderr);
  assert.ok(existsSync(join(f.options.destination, 'product.sqlite')));
  assert.ok(existsSync(join(f.options.destination, 'INCOMPLETE.json')));
  assert.equal(existsSync(join(f.options.destination, 'backup.json')), false);
  assert.throws(() => verifyBackup(f.options.destination));
  assert.throws(() => backupWorkspace(f.options), code('destination-exists'));
});

test('injected filesystem disk-full/failed-write cannot publish backup or erase live history', t => {
  const f = fixture(t); const revision = f.store.revision;
  assert.throws(() => backupWorkspace({ ...f.options, checkpoint: phase => { if (phase === 'before-commit') throw Object.assign(new Error('FIXTURE filesystem ENOSPC'), { code: 'ENOSPC' }); } }), /ENOSPC/);
  assert.equal(existsSync(join(f.options.destination, 'backup.json')), false);
  assert.equal(f.store.revision, revision);
  assert.ok(existsSync(join(f.sources.coordinatorRoot, 'reservations/FIXTURE-reservation.json')));
});

test('detached restoration keeps original authority as non-runnable history, preserves newer work and never imports old client trust', t => {
  const f = fixture(t);
  const authRoot = join(f.root, 'auth-FIXTURE'); const auth = new PairingAuthority(authRoot);
  const pairing = auth.pair(auth.setupCode().code, 'FIXTURE-device'); auth.revoke(pairing.clientId);
  backupWorkspace(f.options);
  f.put('grants/FIXTURE-grant.json', { id: 'FIXTURE-grant', version: 5, status: 'revoked' });
  f.put('runs/FIXTURE-newer.json', { id: 'FIXTURE-newer', attempt: 3 });
  f.put('reservations/FIXTURE-newer.json', { runId: 'FIXTURE-newer', state: 'held' });
  f.store.appendMessage({ conversationId: f.task.conversationId, role: 'agent', text: 'FIXTURE newer work' });
  const revision = f.store.revision; const destination = join(f.root, 'restore');
  assert.equal(restoreDetached({ backup: f.options.destination, destination, current: f.sources }).activation, 'blocked');
  assert.ok(existsSync(join(destination, 'RESTORE-BLOCKED.json')));
  assert.equal(existsSync(join(destination, 'coordinator')), false);
  assert.ok(existsSync(join(destination, 'coordinator-history/grants/FIXTURE-grant.json')));
  assert.equal(existsSync(join(destination, 'auth')), false);
  assert.equal(f.store.revision, revision);
  assert.ok(existsSync(join(f.sources.coordinatorRoot, 'runs/FIXTURE-newer.json')));
  assert.equal(JSON.parse(readFileSync(join(f.sources.coordinatorRoot, 'grants/FIXTURE-grant.json'), 'utf8')).status, 'revoked');
  assert.equal(new PairingAuthority(authRoot).authenticate(`Bearer ${pairing.token}`), null);
  assert.throws(() => checkRollbackUnchanged(f.options.destination, f.sources, f.maintenance, () => {}), code('newer-work'));
});

test('rollback comparison accepts unchanged source only and does not itself activate or overwrite', t => {
  const f = fixture(t); backupWorkspace(f.options);
  checkRollbackUnchanged(f.options.destination, f.sources, f.maintenance, () => {});
  assert.throws(() => restoreDetached({ backup: f.options.destination, destination: f.sources.coordinatorRoot, current: f.sources }), code('live-overlap'));
  assert.throws(() => restoreDetached({ backup: f.options.destination, destination: join(f.sources.coordinatorRoot, 'restore'), current: f.sources }), code('live-overlap'));
  assert.throws(() => restoreDetached({ backup: f.options.destination, destination: f.options.destination, current: f.sources }), code('live-overlap'));
});

test('corrupt backup, missing member, malformed member path and unsupported schema fail without restore success', t => {
  const f = fixture(t); backupWorkspace(f.options);
  const data = join(f.options.destination, 'coordinator/runs/FIXTURE-run.json'); const original = readFileSync(data);
  writeFileSync(data, 'FIXTURE damaged');
  assert.throws(() => restoreDetached({ backup: f.options.destination, destination: join(f.root, 'bad-restore'), current: f.sources }), code('backup-corrupt'));
  assert.equal(existsSync(join(f.root, 'bad-restore')), false);
  rmSync(data); assert.throws(() => verifyBackup(f.options.destination)); writeFileSync(data, original);
  const manifestPath = join(f.options.destination, 'backup.json'); const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.files[0].path = '../FIXTURE-escape'; writeFileSync(manifestPath, JSON.stringify(manifest));
  assert.throws(() => verifyBackup(f.options.destination), code('unsafe-path'));
  const db = new DatabaseSync(f.sources.productDatabase); db.exec('PRAGMA user_version = 99'); db.close();
  assert.throws(() => backupWorkspace({ ...f.options, destination: join(f.root, 'unsupported') }), code('unsupported-version'));
});

test('verification refuses added unlisted history or credentials instead of claiming a complete inventory', t => {
  const f = fixture(t); backupWorkspace(f.options);
  const extra = join(f.options.destination, 'FIXTURE-unlisted.json'); writeFileSync(extra, '{"api_key":"FIXTURE-no-real-secret"}');
  assert.throws(() => verifyBackup(f.options.destination), code('unlisted-backup-member'));
  assert.throws(() => restoreDetached({ backup: f.options.destination, current: f.sources, destination: join(f.root, 'unlisted-restore') }), code('unlisted-backup-member'));
  assert.equal(existsSync(join(f.root, 'unlisted-restore')), false);
});

test('failed restore write and concurrent newer worker evidence remain incomplete; current state stays intact', t => {
  const f = fixture(t); backupWorkspace(f.options); const revision = f.store.revision;
  const destination = join(f.root, 'failed-restore');
  assert.throws(() => restoreDetached({ backup: f.options.destination, destination, current: f.sources, checkpoint: phase => { if (phase === 'copied') throw new Error('FIXTURE interrupted restore write'); } }), /interrupted restore/);
  assert.equal(existsSync(join(destination, 'RESTORE-BLOCKED.json')), false);
  assert.equal(f.store.revision, revision);
  assert.throws(() => restoreDetached({ backup: f.options.destination, destination: join(f.root, 'stale-restore'), current: f.sources, checkpoint: phase => { if (phase === 'copied') f.put('runs/FIXTURE-worker-loss.json', { state: 'remote-uncertain' }); } }), code('current-state-changed'));
  assert.ok(existsSync(join(f.sources.coordinatorRoot, 'runs/FIXTURE-worker-loss.json')));
});

test('compatible update and successful labelled candidate migration run detached; rollback restores failed migration history', t => {
  const f = fixture(t); backupWorkspace(f.options); const revision = f.store.revision;
  const common = { backup: f.options.destination, current: f.sources };
  assert.equal(rehearseMigration({ ...common, destination: join(f.root, 'compatible'), toVersion: 3, migrate: () => {} }).state, 'compatible');
  const migrated = rehearseMigration({ ...common, destination: join(f.root, 'candidate'), toVersion: 4, migrate: db => db.exec('CREATE TABLE fixture_candidate (id TEXT); PRAGMA user_version = 4;') });
  assert.equal(migrated.state, 'compatible');
  const failure = rehearseMigration({ ...common, destination: join(f.root, 'rollback'), toVersion: 4, migrate: db => { db.exec('DELETE FROM events; CREATE TABLE fixture_candidate (id TEXT); PRAGMA user_version = 4;'); throw new Error('FIXTURE migration failure'); } });
  assert.equal(failure.state, 'rolled-back'); assert.equal(failure.error, 'migration-failed');
  const rolledBack = new WorkspaceStore(join(failure.destination, 'product.sqlite'));
  try { assert.equal(rolledBack.revision, revision); assert.deepEqual(rolledBack.eventsAfter(0), f.store.eventsAfter(0)); assert.deepEqual(rolledBack.listInboxVersions(f.request.id), f.store.listInboxVersions(f.request.id)); } finally { rolledBack.close(); }
  assert.equal(f.store.revision, revision);
});

test('reviewed v1 to v2 archive-table migration preserves existing product and coordinator history', t => {
  const f = fixture(t);
  const legacy = new DatabaseSync(f.sources.productDatabase);
  legacy.exec('DROP TABLE archives; PRAGMA user_version = 1;'); legacy.close();
  assert.equal(backupWorkspace(f.options).productVersion, 1);
  const result = rehearseMigration({ backup: f.options.destination, current: f.sources, destination: join(f.root, 'v1-to-v2'), toVersion: 2, migrate: db => {
    // Exact v1→v2 DDL used by the current WorkspaceStore constructor, on detached fixture state.
    db.exec("CREATE TABLE archives (kind TEXT NOT NULL CHECK(kind IN ('project', 'space', 'task', 'link')), entity_id TEXT NOT NULL, archived_at TEXT NOT NULL, PRIMARY KEY(kind, entity_id)); PRAGMA user_version = 2;");
  } });
  assert.equal(result.state, 'compatible'); assert.equal(result.fromVersion, 1);
  const migrated = new WorkspaceStore(join(result.destination, 'product.sqlite'));
  try { assert.deepEqual(migrated.getSubmission(f.submission.id), f.store.getSubmission(f.submission.id)); assert.deepEqual(migrated.listInboxVersions(f.request.id), f.store.listInboxVersions(f.request.id)); } finally { migrated.close(); }
  const current = new DatabaseSync(f.sources.productDatabase, { readOnly: true });
  try { assert.equal(current.prepare('PRAGMA user_version').get()?.['user_version'], 1); } finally { current.close(); }
});

test('real SQLite SQLITE_FULL in detached migration rolls back durable identities and never changes the live fixture', t => {
  const f = fixture(t); backupWorkspace(f.options); let full = false;
  const result = rehearseMigration({ backup: f.options.destination, current: f.sources, destination: join(f.root, 'sqlite-full'), toVersion: 3, migrate: db => {
    const pages = Number(db.prepare('PRAGMA page_count').get()?.['page_count']);
    try {
      db.exec(`PRAGMA max_page_count = ${pages}; CREATE TABLE fixture_fill (content BLOB);`);
      db.prepare('INSERT INTO fixture_fill VALUES (?)').run(Buffer.alloc(2_000_000));
    } catch (error) { full = /database or disk is full/i.test(String(error)); throw error; }
  } });
  assert.equal(full, true, 'The actual SQLite engine must report SQLITE_FULL');
  assert.equal(result.state, 'rolled-back');
  const db = new DatabaseSync(join(result.destination, 'product.sqlite'), { readOnly: true });
  try { assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'fixture_fill'").get(), undefined); assert.equal(db.prepare('PRAGMA user_version').get()?.['user_version'], 3); } finally { db.close(); }
  assert.equal(f.store.getSubmission(f.submission.id).runId, 'FIXTURE-run');
});

test('owner CLI executes real private fixture backup/verify/detached restore and exits nonzero on newer-work refusal', t => {
  const f = fixture(t);
  const script = fileURLToPath(new URL('../../../scripts/operation-state.mjs', import.meta.url));
  const config = join(f.root, 'owner-config-FIXTURE.json');
  const command = (name: string, input: string) => spawnSync(process.execPath, [script, name, input], { encoding: 'utf8' });
  writeFileSync(config, JSON.stringify({ ...f.options, maintenance: { ...f.maintenance, mode: 'owner-approved-quiesced' } }));
  const backedUp = command('backup', config); assert.equal(backedUp.status, 0, backedUp.stderr);
  assert.equal(JSON.parse(backedUp.stdout).state, 'backed-up');
  const verified = command('verify', f.options.destination); assert.equal(verified.status, 0, verified.stderr);
  assert.equal(JSON.parse(verified.stdout).state, 'verified');
  writeFileSync(config, JSON.stringify({ backup: f.options.destination, destination: join(f.root, 'cli-restore'), current: f.sources }));
  const restored = command('restore-detached', config); assert.equal(restored.status, 0, restored.stderr);
  assert.equal(JSON.parse(restored.stdout).activation, 'blocked');
  f.put('reservations/FIXTURE-new-claim.json', { id: 'FIXTURE-new-claim', state: 'held' });
  writeFileSync(config, JSON.stringify({ backup: f.options.destination, current: f.sources, maintenance: { ...f.maintenance, mode: 'owner-approved-quiesced' } }));
  const refused = command('rollback-check', config); assert.equal(refused.status, 1);
  assert.equal(JSON.parse(refused.stderr.split('\n').find(line => line.startsWith('{'))!).code, 'newer-work');
  assert.equal(command('activate', config).status, 1);
});

const speechTestKey = 'operations-FIXTURE-speech-credential-NOT-A-REAL-KEY';
function speechWav(): Buffer {
  const wav = Buffer.alloc(364); wav.write('RIFF'); wav.writeUInt32LE(356, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(320, 40); return wav;
}
function speechRows(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try { return {
    identity: db.prepare('SELECT * FROM speech_identity').all(), policy: db.prepare('SELECT * FROM speech_policy').all(),
    calls: db.prepare('SELECT * FROM speech_calls ORDER BY rowid').all(),
  }; } finally { db.close(); }
}
async function speechFixture(t: TestContext) {
  const f = fixture(t);
  const journalPath = join(f.root, 'product-state-FIXTURE/speech.sqlite');
  const identityPath = `${journalPath}.identity`;
  const previous = process.env['OPENAI_API_KEY']; process.env['OPENAI_API_KEY'] = speechTestKey;
  const instances = new Set<OpenAiSpeechService>(); let fetches = 0;
  const options: OpenAiSpeechOptions = {
    journalPath, approvedPerCallUsd: 0.1, approvedDailyUsd: 1,
    pricing: { whisperUsdPerMinute: 0.006, ttsUsdPerMillionCharacters: 15, verifiedAt: new Date().toISOString() },
    fetch: async (url, init) => {
      fetches++;
      if (url.endsWith('/transcriptions')) return Response.json({ text: 'FIXTURE useful retained speech transcript' });
      if (Buffer.from(init.body as Uint8Array).includes(Buffer.from('FIXTURE uncertain reply'))) throw new Error('FIXTURE lost provider acknowledgement');
      return new Response(new Uint8Array([0, 0, 1, 0]), { headers: { 'Content-Type': 'audio/pcm' } });
    },
  };
  const open = (changes: Partial<OpenAiSpeechOptions> = {}) => {
    const service = new OpenAiSpeechService({ ...options, ...changes }); instances.add(service); return service;
  };
  const stop = async () => { for (const service of instances) await service.close(); instances.clear(); };
  // Register before async setup; cleanup restores the prior environment but never reads/uses its credential.
  t.after(async () => { await stop(); if (previous === undefined) delete process.env['OPENAI_API_KEY']; else process.env['OPENAI_API_KEY'] = previous; });
  const unapproved = open({ initializeJournal: true, pricing: { whisperUsdPerMinute: 0, ttsUsdPerMillionCharacters: 0, verifiedAt: new Date().toISOString() } });
  await assert.rejects(unapproved.transcribe(speechWav(), { idempotencyKey: 'FIXTURE unapproved policy' }), error => error instanceof SpeechError && error.code === 'speech-budget-unapproved');
  assert.equal(fetches, 0); await stop();
  const first = open(), second = open();
  assert.equal(await first.transcribe(speechWav(), { idempotencyKey: 'FIXTURE transcript' }), 'FIXTURE useful retained speech transcript');
  assert.equal(await second.transcribe(speechWav(), { idempotencyKey: 'FIXTURE transcript' }), 'FIXTURE useful retained speech transcript');
  await second.synthesize('FIXTURE complete reply', { idempotencyKey: 'FIXTURE audio' });
  await assert.rejects(first.synthesize('FIXTURE uncertain reply', { idempotencyKey: 'FIXTURE uncertain' }), error => error instanceof SpeechError && error.code === 'speech-call-uncertain');
  await stop();
  const module = fileURLToPath(new URL('../src/speech.js', import.meta.url));
  const killed = spawnSync(process.execPath, ['--input-type=module', '-e', `import { OpenAiSpeechService } from ${JSON.stringify(module)}; const s = new OpenAiSpeechService({...${JSON.stringify({ ...options, fetch: undefined })}, fetch:async()=>{process.exit(61)}}); await s.synthesize('FIXTURE killed reply',{idempotencyKey:'FIXTURE killed'});`], { encoding: 'utf8', env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', OPENAI_API_KEY: speechTestKey } });
  assert.equal(killed.status, 61, killed.stderr);
  f.sources.speechJournal = journalPath; f.sources.speechIdentity = identityPath;
  f.maintenance.speechWriters = { journal: journalPath, identity: identityPath, allInstancesStopped: true, restartPrevented: true, evidence: 'FIXTURE all owned instances closed; child process exited; no restart launchers' };
  f.options.verifyQuiescence = () => { verifyMaintenance(f.maintenance); assert.equal(instances.size, 0, 'FIXTURE all independent speech instances must close first'); };
  return { ...f, journalPath, identityPath, speechOptions: options, open, stop, fetches: () => fetches };
}

test('documented owner CLI preserves speech policy/replay/liabilities and refuses absent writer proof without resetting or activating', async t => {
  const f = await speechFixture(t); const before = speechRows(f.journalPath); const fetches = f.fetches();
  const script = fileURLToPath(new URL('../../../scripts/operation-state.mjs', import.meta.url));
  const configPath = join(f.root, 'speech-owner-config-FIXTURE.json');
  const maintenance = { ...f.maintenance, mode: 'owner-approved-quiesced' as const };
  const command = (name: string, config: unknown) => {
    writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
    return spawnSync(process.execPath, [script, name, configPath], { encoding: 'utf8', env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin' } });
  };
  const backedUp = command('backup', { ...f.options, maintenance });
  assert.equal(backedUp.status, 0, backedUp.stderr); assert.equal(JSON.parse(backedUp.stdout).state, 'backed-up');
  const verified = spawnSync(process.execPath, [script, 'verify', f.options.destination], { encoding: 'utf8', env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin' } });
  assert.equal(verified.status, 0, verified.stderr); assert.equal(JSON.parse(verified.stdout).state, 'verified');
  const restoreConfig = { backup: f.options.destination, current: f.sources, maintenance, destination: join(f.root, 'speech-cli-restore') };
  const restored = command('restore-detached', restoreConfig);
  assert.equal(restored.status, 0, restored.stderr); assert.equal(JSON.parse(restored.stdout).activation, 'blocked');
  assert.deepEqual(speechRows(join(restoreConfig.destination, 'speech.sqlite')), before);
  assert.equal(readFileSync(join(restoreConfig.destination, 'speech.sqlite.identity'), 'utf8'), readFileSync(f.identityPath, 'utf8'));
  let replayFetches = 0;
  const replay = new OpenAiSpeechService({ ...f.speechOptions, journalPath: join(restoreConfig.destination, 'speech.sqlite'), initializeJournal: false, fetch: async () => { replayFetches++; throw new Error('FIXTURE replay must not spend'); } });
  try {
    assert.equal(await replay.transcribe(speechWav(), { idempotencyKey: 'FIXTURE transcript' }), 'FIXTURE useful retained speech transcript');
    await assert.rejects(replay.synthesize('FIXTURE killed reply', { idempotencyKey: 'FIXTURE killed' }), error => error instanceof SpeechError && error.code === 'speech-call-uncertain');
    assert.equal(replayFetches, 0); assert.deepEqual(speechRows(join(restoreConfig.destination, 'speech.sqlite')), before);
  } finally { await replay.close(); }
  const unchanged = command('rollback-check', { backup: f.options.destination, current: f.sources, maintenance });
  assert.equal(unchanged.status, 0, unchanged.stderr); assert.equal(JSON.parse(unchanged.stdout).state, 'unchanged');
  const { speechWriters: omittedHold, ...noSpeechHold } = maintenance; assert.ok(omittedHold);
  const refusedHolds = [
    { evidence: undefined, expected: 'maintenance-required' },
    { evidence: { ...maintenance, mode: 'detached-fixture' }, expected: 'maintenance-required' },
    { evidence: { ...maintenance, expiresAt: new Date(0).toISOString() }, expected: 'maintenance-required' },
    { evidence: noSpeechHold, expected: 'speech-maintenance-required' },
    { evidence: { ...maintenance, speechWriters: { ...omittedHold, allInstancesStopped: false } }, expected: 'speech-maintenance-required' },
    { evidence: { ...maintenance, speechWriters: { ...omittedHold, restartPrevented: false } }, expected: 'speech-maintenance-required' },
    { evidence: { ...maintenance, speechWriters: { ...omittedHold, journal: join(f.root, 'wrong.sqlite') } }, expected: 'speech-maintenance-required' },
    { evidence: { ...maintenance, writers: [{ ...maintenance.writers[0]!, pid: process.pid }] }, expected: 'writer-not-held' },
  ];
  for (const [index, hold] of refusedHolds.entries()) {
    for (const operation of ['backup', 'restore-detached', 'rollback-check']) {
      const destination = join(f.root, `speech-cli-refused-${index}-${operation}`);
      const refused = command(operation, { ...restoreConfig, ...f.options, destination, maintenance: hold.evidence });
      assert.equal(refused.status, 1, refused.stderr);
      assert.equal(JSON.parse(refused.stderr.split('\n').find(line => line.startsWith('{'))!).code, hold.expected);
      assert.equal(existsSync(destination), false); assert.deepEqual(speechRows(f.journalPath), before);
    }
  }
  const identity = readFileSync(f.identityPath); rmSync(f.identityPath);
  const lostDestination = join(f.root, 'speech-cli-lost-identity');
  const lost = command('restore-detached', { ...restoreConfig, destination: lostDestination });
  assert.equal(lost.status, 1); assert.equal(JSON.parse(lost.stderr.split('\n').find(line => line.startsWith('{'))!).code, 'speech-journal-unavailable');
  assert.equal(existsSync(f.identityPath), false); assert.equal(existsSync(lostDestination), false);
  assert.deepEqual(speechRows(f.journalPath), before); writeFileSync(f.identityPath, identity, { mode: 0o600 });
  assert.equal(f.fetches(), fetches, 'CLI operations never invoke the fixture transport or a provider');
  assert.equal(JSON.stringify({ backedUp, restored, lost }).includes(speechTestKey), false);
});

test('real speech ledger preserves immutable policy, transcripts, replay digests and uncertain/killed liabilities in private standalone detached restore', async t => {
  const f = await speechFixture(t); const before = speechRows(f.journalPath);
  assert.deepEqual(before.calls.map(row => row['state']), ['complete', 'complete', 'uncertain', 'reserved']);
  const manifest = backupWorkspace(f.options); assert.equal(manifest.speechJournalVersion, 1);
  for (const path of ['speech.sqlite', 'speech.sqlite.identity']) {
    const member = manifest.files.find(file => file.path === path)!;
    assert.equal(member.sha256, hash(readFileSync(join(f.options.destination, path))));
    assert.equal(member.bytes, lstatSync(join(f.options.destination, path)).size);
    assert.equal(lstatSync(join(f.options.destination, path)).mode & 0o777, 0o600);
  }
  assert.deepEqual(speechRows(join(f.options.destination, 'speech.sqlite')), before);
  checkRollbackUnchanged(f.options.destination, f.sources, f.maintenance, f.options.verifyQuiescence);
  const restored = restoreDetached({ backup: f.options.destination, destination: join(f.root, 'speech-restore'), current: f.sources, maintenance: f.maintenance, verifyQuiescence: f.options.verifyQuiescence });
  assert.equal(restored.activation, 'blocked');
  assert.deepEqual(speechRows(join(restored.destination, 'speech.sqlite')), before);
  assert.equal(readFileSync(join(restored.destination, 'speech.sqlite.identity'), 'utf8'), readFileSync(f.identityPath, 'utf8'));
  let providerCalls = 0;
  const replay = new OpenAiSpeechService({ ...f.speechOptions, journalPath: join(restored.destination, 'speech.sqlite'), initializeJournal: false, fetch: async () => { providerCalls++; throw new Error('FIXTURE replay must not call provider'); } });
  try {
    assert.equal(await replay.transcribe(speechWav(), { idempotencyKey: 'FIXTURE transcript' }), 'FIXTURE useful retained speech transcript');
    for (const [text, key, expected] of [['FIXTURE complete reply', 'FIXTURE audio', 'speech-audio-not-retained'], ['FIXTURE uncertain reply', 'FIXTURE uncertain', 'speech-call-uncertain'], ['FIXTURE killed reply', 'FIXTURE killed', 'speech-call-uncertain']] as const) await assert.rejects(replay.synthesize(text, { idempotencyKey: key }), error => error instanceof SpeechError && error.code === expected);
    await assert.rejects(replay.synthesize('FIXTURE changed payload', { idempotencyKey: 'FIXTURE killed' }), error => error instanceof SpeechError && error.code === 'speech-key-conflict');
    assert.equal(providerCalls, 0); assert.deepEqual(speechRows(join(restored.destination, 'speech.sqlite')), before);
  } finally { await replay.close(); }
  for (const path of ['speech.sqlite', 'speech.sqlite.identity', 'RESTORE-BLOCKED.json']) assert.equal(lstatSync(join(restored.destination, path)).mode & 0o777, 0o600);
  const data = readFileSync(join(restored.destination, 'speech.sqlite'));
  assert.equal(data.includes(Buffer.from(speechTestKey)), false); assert.equal(data.includes(speechWav()), false);
  assert.deepEqual(readdirSync(restored.destination).filter(name => name.startsWith('speech')), ['speech.sqlite', 'speech.sqlite.identity']);
  assert.deepEqual(speechRows(f.journalPath), before);
});

test('configured speech refuses incomplete inventory, loss, mismatched identity, corruption, symlinks and public storage without provisioning', async t => {
  const f = await speechFixture(t); const journal = readFileSync(f.journalPath), identity = readFileSync(f.identityPath);
  const { speechIdentity: omittedIdentity, ...incompletePair } = f.sources; assert.equal(omittedIdentity, f.identityPath);
  assert.throws(() => backupWorkspace({ ...f.options, sources: incompletePair }), code('speech-pair-required'));
  for (const path of [f.journalPath, f.identityPath]) {
    const bytes = readFileSync(path); rmSync(path);
    assert.throws(() => backupWorkspace(f.options), code('speech-journal-unavailable'));
    assert.equal(existsSync(path), false); assert.equal(existsSync(f.options.destination), false);
    writeFileSync(path, bytes, { mode: 0o600 });
  }
  writeFileSync(f.identityPath, '00000000-0000-0000-0000-000000000000');
  assert.throws(() => backupWorkspace(f.options), code('speech-identity-mismatch')); writeFileSync(f.identityPath, identity);
  writeFileSync(f.journalPath, 'FIXTURE corrupt database'); assert.throws(() => backupWorkspace(f.options), code('speech-journal-unavailable')); writeFileSync(f.journalPath, journal);
  rmSync(f.identityPath); symlinkSync(f.journalPath, f.identityPath);
  assert.throws(() => backupWorkspace(f.options), code('unsafe-path')); rmSync(f.identityPath); writeFileSync(f.identityPath, identity, { mode: 0o600 });
  chmodSync(f.identityPath, 0o644); assert.throws(() => backupWorkspace(f.options), code('private-output-required')); chmodSync(f.identityPath, 0o600);
  backupWorkspace(f.options); assert.deepEqual(speechRows(f.journalPath), speechRows(join(f.options.destination, 'speech.sqlite')));
});

test('host lease alone cannot establish speech quiescence; all independently open instances and exact root inventory must be held', async t => {
  const f = await speechFixture(t); const writer = f.open(), second = f.open();
  assert.ok(writer); assert.ok(second);
  assert.throws(() => backupWorkspace(f.options), /independent speech instances/);
  await f.stop();
  const { speechWriters: omittedHold, ...noSpeech } = f.maintenance; assert.ok(omittedHold);
  assert.throws(() => backupWorkspace({ ...f.options, maintenance: noSpeech }), code('speech-maintenance-required'));
  assert.throws(() => backupWorkspace({ ...f.options, maintenance: { ...f.maintenance, speechWriters: { ...f.maintenance.speechWriters!, journal: join(f.root, 'wrong.sqlite') } } }), code('speech-maintenance-required'));
  backupWorkspace(f.options);
  assert.throws(() => restoreDetached({ backup: f.options.destination, current: f.sources, destination: join(f.root, 'no-hold') }), code('speech-maintenance-required'));
  const { speechJournal: omittedJournal, speechIdentity: omittedIdentity, ...noPair } = f.sources; assert.ok(omittedJournal); assert.ok(omittedIdentity);
  assert.throws(() => restoreDetached({ backup: f.options.destination, current: noPair, destination: join(f.root, 'omitted-current') }), code('speech-inventory-mismatch'));
  assert.equal(existsSync(join(f.root, 'omitted-current')), false);
});

test('speech-only committed calls reject rollback and drift during restore without clearing newer liabilities', async t => {
  const f = await speechFixture(t); backupWorkspace(f.options); const revision = f.store.revision;
  const next = f.open(); await next.synthesize('FIXTURE newer call', { idempotencyKey: 'FIXTURE newer' }); await f.stop();
  const newer = speechRows(f.journalPath); assert.equal(f.store.revision, revision);
  assert.throws(() => checkRollbackUnchanged(f.options.destination, f.sources, f.maintenance, f.options.verifyQuiescence), code('newer-work'));
  assert.deepEqual(speechRows(f.journalPath), newer);
  const destination = join(f.root, 'speech-drift-restore');
  assert.throws(() => restoreDetached({ backup: f.options.destination, current: f.sources, destination, maintenance: f.maintenance, verifyQuiescence: f.options.verifyQuiescence, checkpoint: phase => {
    if (phase === 'copied') {
      const db = new DatabaseSync(f.journalPath);
      try { db.prepare("UPDATE speech_calls SET reserved_micro_usd=reserved_micro_usd+1 WHERE state='reserved'").run(); } finally { db.close(); }
    }
  } }), code('current-state-changed'));
  assert.equal(existsSync(join(destination, 'RESTORE-BLOCKED.json')), false);
  assert.equal(speechRows(f.journalPath).calls.length, newer.calls.length);
  assert.equal(Number(speechRows(f.journalPath).calls[3]!['reserved_micro_usd']), Number(newer.calls[3]!['reserved_micro_usd']) + 1);
});

test('speech WAL snapshot captures committed liability without checkpointing source; written pair corruption and interrupted/disk-full outputs never commit', async t => {
  const f = await speechFixture(t); const db = new DatabaseSync(f.journalPath);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;');
  db.prepare("UPDATE speech_calls SET error_code='speech-call-uncertain' WHERE state='reserved'").run();
  assert.ok(existsSync(`${f.journalPath}-wal`));
  const before = speechRows(f.journalPath); const main = readFileSync(f.journalPath), wal = readFileSync(`${f.journalPath}-wal`);
  try {
    backupWorkspace(f.options);
    assert.deepEqual(speechRows(join(f.options.destination, 'speech.sqlite')), before);
    assert.deepEqual(readFileSync(f.journalPath), main); assert.deepEqual(readFileSync(`${f.journalPath}-wal`), wal);
  } finally { db.close(); }
  for (const [index, failure] of ['created', 'copied', 'before-commit'].entries()) {
    const destination = join(f.root, `speech-failure-${index}`);
    assert.throws(() => backupWorkspace({ ...f.options, destination, checkpoint: phase => { if (phase === failure) throw Object.assign(new Error('FIXTURE ENOSPC or interrupted write'), { code: 'ENOSPC' }); } }), /ENOSPC/);
    assert.equal(existsSync(join(destination, 'backup.json')), false); assert.ok(existsSync(join(destination, 'INCOMPLETE.json')));
    assert.deepEqual(speechRows(f.journalPath), before);
  }
  const destination = join(f.root, 'speech-written-corrupt');
  assert.throws(() => backupWorkspace({ ...f.options, destination, checkpoint: phase => { if (phase === 'before-commit') writeFileSync(join(destination, 'speech.sqlite.identity'), '00000000-0000-0000-0000-000000000000'); } }), code('backup-corrupt'));
  assert.equal(existsSync(join(destination, 'backup.json')), false);
  const restored = join(f.root, 'speech-restore-failed');
  assert.throws(() => restoreDetached({ backup: f.options.destination, current: f.sources, destination: restored, maintenance: f.maintenance, verifyQuiescence: f.options.verifyQuiescence, checkpoint: phase => { if (phase === 'copied') throw new Error('FIXTURE restore disk full'); } }), /disk full/);
  assert.equal(existsSync(join(restored, 'RESTORE-BLOCKED.json')), false); assert.deepEqual(speechRows(f.journalPath), before);
});

test('speech drift during capture and actual backup process death leave liabilities and incomplete output intact', async t => {
  const f = await speechFixture(t); const before = speechRows(f.journalPath);
  const drift = join(f.root, 'speech-drift-backup');
  assert.throws(() => backupWorkspace({ ...f.options, destination: drift, checkpoint: phase => {
    if (phase === 'copied') {
      const db = new DatabaseSync(f.journalPath);
      try { db.prepare('UPDATE speech_policy SET policy=? WHERE id=1').run(JSON.stringify({ perCall: 100000, daily: 999999, minute: 6000, millionCharacters: 15000000 })); } finally { db.close(); }
    }
  } }), code('state-changed'));
  assert.equal(existsSync(join(drift, 'backup.json')), false);
  assert.deepEqual(speechRows(f.journalPath).calls, before.calls);
  const module = fileURLToPath(new URL('../src/operations.js', import.meta.url));
  const killed = spawnSync(process.execPath, ['--input-type=module', '-e', `import { backupWorkspace } from ${JSON.stringify(module)}; const options=${JSON.stringify({ ...f.options, verifyQuiescence: undefined })}; backupWorkspace({...options,verifyQuiescence:()=>{},checkpoint:phase=>{if(phase==='copied')process.exit(47)}});`], { encoding: 'utf8', env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin' } });
  assert.equal(killed.status, 47, killed.stderr); assert.ok(existsSync(join(f.options.destination, 'speech.sqlite')));
  assert.equal(existsSync(join(f.options.destination, 'backup.json')), false);
  assert.deepEqual(speechRows(f.journalPath).calls, before.calls);
  assert.equal(readFileSync(f.identityPath, 'utf8'), String(before.identity[0]!['identity']));
});

test('speech backup pair inventory, hashes, schema, identity and written restored bytes fail closed', async t => {
  const f = await speechFixture(t); backupWorkspace(f.options);
  const manifestPath = join(f.options.destination, 'backup.json'); const original = readFileSync(manifestPath);
  const identityPath = join(f.options.destination, 'speech.sqlite.identity'); const identity = readFileSync(identityPath);
  writeFileSync(identityPath, '00000000-0000-0000-0000-000000000000');
  assert.throws(() => verifyBackup(f.options.destination), code('backup-corrupt'));
  const edited = JSON.parse(original.toString()); const member = edited.files.find((file: { path: string }) => file.path === 'speech.sqlite.identity');
  member.sha256 = hash(readFileSync(identityPath)); writeFileSync(manifestPath, JSON.stringify(edited));
  assert.throws(() => verifyBackup(f.options.destination), code('speech-identity-mismatch'));
  writeFileSync(identityPath, identity); writeFileSync(manifestPath, original);
  rmSync(identityPath); symlinkSync(f.identityPath, identityPath);
  assert.throws(() => verifyBackup(f.options.destination), code('unsafe-path')); rmSync(identityPath); writeFileSync(identityPath, identity, { mode: 0o600 });
  const missing = JSON.parse(original.toString()); missing.files = missing.files.filter((file: { path: string }) => file.path !== 'speech.sqlite.identity');
  writeFileSync(manifestPath, JSON.stringify(missing)); assert.throws(() => verifyBackup(f.options.destination), code('invalid-backup'));
  const future = JSON.parse(original.toString()); future.speechJournalVersion = 2; writeFileSync(manifestPath, JSON.stringify(future));
  assert.throws(() => verifyBackup(f.options.destination), code('invalid-backup')); writeFileSync(manifestPath, original);
  for (const [index, path] of ['speech.sqlite', 'speech.sqlite.identity'].entries()) {
    const destination = join(f.root, `speech-written-restore-${index}`);
    assert.throws(() => restoreDetached({ backup: f.options.destination, current: f.sources, destination, maintenance: f.maintenance, verifyQuiescence: f.options.verifyQuiescence, checkpoint: phase => { if (phase === 'copied') writeFileSync(join(destination, path), 'FIXTURE interrupted/corrupt written pair'); } }), code('backup-corrupt'));
    assert.equal(existsSync(join(destination, 'RESTORE-BLOCKED.json')), false);
  }
  assert.deepEqual(speechRows(f.journalPath), speechRows(join(f.options.destination, 'speech.sqlite')));
});

const tarFixtureProgram = String.raw`
import base64, io, json, sys, tarfile
config = json.load(sys.stdin)
with tarfile.open(fileobj=sys.stdout.buffer, mode='w|', format=tarfile.PAX_FORMAT) as archive:
 for file in config['members']:
  member = tarfile.TarInfo(file['path'])
  member.mode = file.get('mode', 0o640); member.uid = 1000; member.gid = 1000; member.mtime = 1700000000
  member.pax_headers = file.get('pax', {})
  data = base64.b64decode(file.get('contentBase64', ''))
  if file.get('kind') == 'dir': member.type = tarfile.DIRTYPE
  elif file.get('kind') == 'symlink': member.type = tarfile.SYMTYPE; member.linkname = file['target']
  else: member.size = len(data)
  archive.addfile(member, io.BytesIO(data) if member.isreg() else None)
`;
type FixtureMember = { path: string; content?: Buffer; kind?: 'dir' | 'symlink'; target?: string; mode?: number; pax?: Record<string, string> };
function tarFixture(members: FixtureMember[]): Buffer {
  const result = spawnSync('python3', ['-I', '-c', tarFixtureProgram], { input: JSON.stringify({ members: members.map(({ content, ...member }) => ({ ...member, contentBase64: (content ?? Buffer.alloc(0)).toString('base64') })) }), maxBuffer: 128 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr.toString()); return result.stdout;
}
function hash(data: Buffer): string { return createHash('sha256').update(data).digest('hex'); }
function fixtureStream(data: Buffer, chunkBytes = 65536) {
  return { bytes: data.length, sha256: hash(data), open: () => Readable.from((function* () { for (let i = 0; i < data.length; i += chunkBytes) yield data.subarray(i, i + chunkBytes); })()) };
}
function exportFixture(taskId: string, files: { path: string; content: Buffer }[], members: FixtureMember[] = files, chunkBytes = 65536): ExportArtifact {
  return { taskId, environmentId: 'FIXTURE-environment', epoch: 5, files: files.map(file => ({ path: file.path, ...fixtureStream(file.content, chunkBytes) })), rawArchive: fixtureStream(tarFixture(members), chunkBytes) };
}
function cleanupFixture(t: TestContext) {
  const f = fixture(t); let state: EnvironmentSnapshot['state'] = 'stopped'; let destroyed = false; let archiveCalls = 0;
  const snapshot: EnvironmentSnapshot = { taskId: f.task.id, environmentId: 'FIXTURE-environment', state, lease: { taskId: f.task.id, epoch: 5, owner: 'handoff', detail: 'FIXTURE stopped' }, views: [], detail: 'FIXTURE no actual Docker container' };
  const evidence: CleanupEvidence = { taskId: f.task.id, coordinatorTaskId: 'FIXTURE-coordinator-task', terminal: true, activeRunIds: [], uncertainRunIds: [], reservationIds: [], evidenceRefs: ['FIXTURE retained stop/outcome evidence'], inspectedAt: new Date().toISOString() };
  const port: CleanupPort = {
    snapshot: () => ({ ...snapshot, state }),
    exportArchive: async () => exportFixture(f.task.id, [{ path: 'nested/FIXTURE-rich-artifact.txt', content: Buffer.from('FIXTURE all durable bytes') }, { path: 'FIXTURE-empty.txt', content: Buffer.alloc(0) }]),
    archive: async () => { archiveCalls++; state = 'archived'; return { ...snapshot, state }; },
    destroy: async () => { destroyed = true; },
  };
  const options: CleanupOptions = { taskId: f.task.id, expectedEpoch: 5, destination: join(f.root, 'archive'), environment: port, current: f.sources, inspect: async () => evidence, maintenance: f.maintenance, verifyQuiescence: () => {}, destroy: true };
  return { ...f, options, evidence, port, setState: (value: typeof state) => { state = value; }, destroyed: () => destroyed, archiveCalls: () => archiveCalls };
}

test('cleanup exports and verifies complete durable files with evidence before archive/destruction', async t => {
  const f = cleanupFixture(t); const result = await archiveEnvironment(f.options);
  assert.equal(result.destroyed, true); assert.equal(f.destroyed(), true); assert.equal(f.archiveCalls(), 1);
  assert.equal(readFileSync(join(result.archive, 'workspace/nested/FIXTURE-rich-artifact.txt'), 'utf8'), 'FIXTURE all durable bytes');
  const inventory = JSON.parse(readFileSync(join(result.archive, 'archive.json'), 'utf8'));
  assert.equal(inventory.format, 2); assert.equal(inventory.taskId, f.task.id); assert.equal(inventory.epoch, 5);
  assert.equal(inventory.rawArchive.bytes, lstatSync(join(result.archive, 'workspace.tar')).size);
  assert.equal(inventory.rawArchive.sha256, hash(readFileSync(join(result.archive, 'workspace.tar'))));
  assert.ok(existsSync(join(result.archive, 'cleanup-result.json')));
  assert.equal(readdirSync(join(result.archive, 'workspace')).length, 2);
});

test('cleanup refuses active, uncertain, reserved, stale and unexportable work; no destructor runs', async t => {
  const f = cleanupFixture(t);
  for (const state of ['running', 'uncertain'] as const) { f.setState(state); await assert.rejects(archiveEnvironment(f.options), code('cleanup-blocked')); }
  f.setState('stopped');
  for (const patch of [{ activeRunIds: ['FIXTURE-active'] }, { uncertainRunIds: ['FIXTURE-unknown'] }, { reservationIds: ['FIXTURE-held'] }, { terminal: false }]) await assert.rejects(archiveEnvironment({ ...f.options, inspect: async () => ({ ...f.evidence, ...patch }) }), code('cleanup-blocked'));
  await assert.rejects(archiveEnvironment({ ...f.options, expectedEpoch: 4 }), code('cleanup-blocked'));
  await assert.rejects(archiveEnvironment({ ...f.options, environment: { ...f.port, exportArchive: async () => { throw new Error('FIXTURE actual export unavailable'); } } }), /export unavailable/);
  assert.equal(f.archiveCalls(), 0); assert.equal(f.destroyed(), false);
  assert.equal(existsSync(f.options.destination), false);
});

test('new reservation or revoked/failed maintenance after export prevents destruction while retaining artifacts', async t => {
  const f = cleanupFixture(t); let reads = 0;
  await assert.rejects(archiveEnvironment({ ...f.options, inspect: async () => { reads++; return { ...f.evidence, reservationIds: reads > 1 ? ['FIXTURE-new-reservation'] : [] }; } }), code('cleanup-blocked'));
  assert.equal(f.destroyed(), false); assert.equal(f.archiveCalls(), 0);
  assert.ok(existsSync(join(f.options.destination, 'workspace/nested/FIXTURE-rich-artifact.txt')));
  const second = join(f.root, 'archive-hold-failed'); let checks = 0;
  await assert.rejects(archiveEnvironment({ ...f.options, destination: second, verifyQuiescence: () => { if (++checks > 1) throw new Error('FIXTURE maintenance revoked'); } }), /maintenance revoked/);
  assert.equal(f.destroyed(), false);
});

test('archive refuses path escape, secret content, stale identities and failed destruction never reports success', async t => {
  const f = cleanupFixture(t);
  const original = await f.port.exportArchive(f.task.id, 5);
  for (const [index, patch] of [{ files: [{ path: '../FIXTURE-escape', ...fixtureStream(Buffer.alloc(0)) }] }, { files: [{ path: 'FIXTURE-secret', ...fixtureStream(Buffer.from('{"api_key":"FIXTURE-private"}')) }] }, { epoch: 4 }].entries()) await assert.rejects(archiveEnvironment({ ...f.options, destination: join(f.root, `bad-export-${index}`), environment: { ...f.port, exportArchive: async () => ({ ...original, ...patch }) } }));
  await assert.rejects(archiveEnvironment({ ...f.options, environment: { ...f.port, destroy: async () => { throw new Error('FIXTURE uncertain engine removal'); } } }), /uncertain engine removal/);
  assert.equal(existsSync(join(f.options.destination, 'cleanup-result.json')), false);
  assert.ok(existsSync(join(f.options.destination, 'archive.json')));
});

test('actual broker owner stream contract retains 20 MiB, empty directories, modes and xattrs without extraction', async t => {
  const f = cleanupFixture(t);
  const large = Buffer.alloc(20 * 1024 * 1024, 0x61); large[large.length - 1] = 0x7a;
  const members: FixtureMember[] = [{ path: 'FIXTURE-empty-dir', kind: 'dir', mode: 0o750 }, { path: 'FIXTURE-large.bin', content: large, mode: 0o640, pax: { 'SCHILY.xattr.user.mime_type': 'application/octet-stream' } }, { path: 'FIXTURE-empty.txt', content: Buffer.alloc(0) }];
  const tar = tarFixture(members);
  const engine: EnvironmentEngine = { readiness: async () => ({ id: 'FIXTURE', state: 'ready', detail: 'FIXTURE engine, no Docker' }), create: async () => 'a'.repeat(64), start: async () => {}, stopAndVerify: async () => {}, remove: async () => {}, removeVolume: async () => {}, tool: async () => ({}), captureWorkspace: async (_environment, fd) => { writeFileSync(fd, tar); }, verifyWorkspace: async () => {} };
  const broker = new EnvironmentBroker(join(f.root, 'broker-stream-FIXTURE'), engine); t.after(() => broker.close());
  const initial = await broker.create(f.task.id); const owner = broker.owner();
  const stopped = await owner.stop(f.task.id, initial.lease.epoch, true);
  const result = await archiveEnvironment({ ...f.options, expectedEpoch: stopped.epoch, environment: { ...owner, snapshot: taskId => broker.snapshot(taskId) } });
  assert.equal(result.destroyed, true);
  assert.equal(lstatSync(join(result.archive, 'workspace/FIXTURE-large.bin')).size, large.length);
  assert.equal(hash(readFileSync(join(result.archive, 'workspace/FIXTURE-large.bin'))), hash(large));
  assert.deepEqual(readFileSync(join(result.archive, 'workspace.tar')), tar);
  assert.equal(existsSync(join(result.archive, 'workspace/FIXTURE-empty-dir')), false, 'Raw metadata must never be unpacked onto the host');
  for (const path of ['workspace.tar', 'workspace/FIXTURE-large.bin', 'archive.json']) assert.equal(lstatSync(join(result.archive, path)).mode & 0o777, 0o600);
  const manifest = JSON.parse(readFileSync(join(result.archive, 'archive.json'), 'utf8'));
  assert.equal(manifest.environmentId, initial.environmentId); assert.equal(manifest.epoch, stopped.epoch);
  assert.equal(manifest.rawArchive.sha256, hash(tar)); assert.equal(manifest.files[0].bytes, large.length);
});

test('stream count/hash mismatch, truncation, raw corruption and source errors prevent archive/destruction', async t => {
  const f = cleanupFixture(t); const original = await f.port.exportArchive(f.task.id, 5);
  const good = original.files[0]!;
  const cases: ExportArtifact[] = [
    { ...original, files: [{ ...good, bytes: good.bytes + 1 }] },
    { ...original, files: [{ ...good, bytes: good.bytes - 1 }] },
    { ...original, files: [{ ...good, sha256: '0'.repeat(64) }] },
    { ...original, files: [{ ...good, open: () => Readable.from([Buffer.from('short')]) }] },
    { ...original, rawArchive: { ...original.rawArchive, sha256: '0'.repeat(64) } },
    { ...original, rawArchive: fixtureStream(Buffer.from('FIXTURE-not-a-tar')) },
    { ...original, files: [{ ...good, open: () => Readable.from((async function* () { yield Buffer.from('FIXTURE'); throw new Error('FIXTURE source interrupted'); })()) }] },
  ];
  for (const [index, artifact] of cases.entries()) {
    const destination = join(f.root, `corrupt-${index}`);
    await assert.rejects(archiveEnvironment({ ...f.options, destination, environment: { ...f.port, exportArchive: async () => artifact } }));
    assert.equal(existsSync(join(destination, 'cleanup-result.json')), false); assert.equal(existsSync(join(destination, 'archive.json')), false);
  }
  assert.equal(f.archiveCalls(), 0); assert.equal(f.destroyed(), false);
});

test('chunk-boundary JSON, escaped quotes, long tokens and private keys refuse without read-all or redaction', async t => {
  const f = cleanupFixture(t);
  const values = ['prefix {"api_key":"FIXTURE-not-a-real-secret"}', String.raw`prefix {\"access_token\":\"FIXTURE\"}`, '-----BEGIN ' + 'OPENSSH PRIVATE KEY-----', 'sk-proj-' + 'a'.repeat(2000), '{"password"' + ' '.repeat(2000) + ':"FIXTURE"}', '-----BEGIN ' + 'ENCRYPTED PRIVATE KEY-----', 'Bearer' + ' '.repeat(2000) + 'FIXTURE-token', '-----BEGIN ' + 'DSA PRIVATE KEY-----'];
  for (const [index, text] of values.entries()) {
    const artifact = exportFixture(f.task.id, [{ path: 'FIXTURE.txt', content: Buffer.from(text) }], undefined, 1);
    await assert.rejects(archiveEnvironment({ ...f.options, destination: join(f.root, `secret-${index}`), environment: { ...f.port, exportArchive: async () => artifact } }), code('secret-in-state'));
  }
  assert.equal(f.archiveCalls(), 0); assert.equal(f.destroyed(), false);
});

test('raw tar inventory rejects unexpected/missing/duplicate files, unsafe names, secrets and links', async t => {
  const f = cleanupFixture(t); const content = Buffer.from('FIXTURE public bytes'); const file = { path: 'FIXTURE.txt', content };
  const cases: FixtureMember[][] = [
    [file, { path: 'FIXTURE-unlisted.txt', content }], [], [file, file],
    [file, { path: '../FIXTURE-escape', kind: 'dir' }], [file, { path: '/FIXTURE-absolute', kind: 'dir' }],
    [file, { path: 'FIXTURE-link', kind: 'symlink', target: '/etc/passwd' }],
    [file, { path: 'auth', kind: 'dir' }], [{ ...file, content: Buffer.from('FIXTURE different bytes') }],
  ];
  for (const [index, members] of cases.entries()) {
    const artifact = exportFixture(f.task.id, [file], members);
    await assert.rejects(archiveEnvironment({ ...f.options, destination: join(f.root, `unsafe-raw-${index}`), environment: { ...f.port, exportArchive: async () => artifact } }));
  }
  const good = exportFixture(f.task.id, [file]);
  for (const files of [[good.files[0]!, good.files[0]!], [{ ...good.files[0]!, path: 'auth/FIXTURE.txt' }], [good.files[0]!, { ...good.files[0]!, path: 'FIXTURE.txt/child' }]]) {
    await assert.rejects(archiveEnvironment({ ...f.options, environment: { ...f.port, exportArchive: async () => ({ ...good, files }) } }), code('unsafe-export'));
  }
  assert.equal(f.archiveCalls(), 0); assert.equal(f.destroyed(), false);
});

test('raw metadata and compressed secret content are screened, unsupported containers block cleanup', async t => {
  const f = cleanupFixture(t); const file = { path: 'FIXTURE.txt', content: Buffer.from('FIXTURE harmless text') };
  const metadata = [ { 'SCHILY.xattr.user.note': '{"api_key":"FIXTURE"}' }, { 'SCHILY.xattr.user.note': Buffer.from('{"password":"FIXTURE"}').toString('base64') }, { 'SCHILY.xattr.user.api_key': 'FIXTURE' } ];
  for (const [index, pax] of metadata.entries()) {
    const artifact = exportFixture(f.task.id, [file], [{ ...file, pax }]);
    await assert.rejects(archiveEnvironment({ ...f.options, destination: join(f.root, `metadata-secret-${index}`), environment: { ...f.port, exportArchive: async () => artifact } }), code('secret-in-state'));
  }
  for (const format of ['gzip', 'bz2', 'lzma']) {
    const result = spawnSync('python3', ['-I', '-c', `import ${format},sys; sys.stdout.buffer.write(${format}.compress(sys.stdin.buffer.read()))`], { input: Buffer.from('{"api_key":"FIXTURE compressed secret"}') });
    assert.equal(result.status, 0);
    const artifact = exportFixture(f.task.id, [{ path: `FIXTURE-${format}.bin`, content: result.stdout }]);
    await assert.rejects(archiveEnvironment({ ...f.options, destination: join(f.root, `compressed-${format}`), environment: { ...f.port, exportArchive: async () => artifact } }), code('secret-in-state'));
    const clean = spawnSync('python3', ['-I', '-c', `import ${format},sys; sys.stdout.buffer.write(${format}.compress(sys.stdin.buffer.read()))`], { input: Buffer.from('FIXTURE nonsecret compressed text') });
    const cleanArtifact = exportFixture(f.task.id, [{ path: `FIXTURE-${format}.bin`, content: clean.stdout }]);
    const resultClean = await archiveEnvironment({ ...f.options, destroy: false, destination: join(f.root, `compressed-clean-${format}`), environment: { ...f.port, exportArchive: async () => cleanArtifact } });
    assert.equal(resultClean.destroyed, false);
  }
  const opaque = exportFixture(f.task.id, [{ path: 'FIXTURE.zip', content: Buffer.from([0x50, 0x4b, 3, 4, 1, 2, 3, 4]) }]);
  await assert.rejects(archiveEnvironment({ ...f.options, destination: join(f.root, 'opaque'), environment: { ...f.port, exportArchive: async () => opaque } }), code('unsupported-content'));
  assert.equal(f.destroyed(), false);
});

test('wx failed write, cancellation and midstream epoch change retain environment and incomplete output', async t => {
  const f = cleanupFixture(t);
  await assert.rejects(archiveEnvironment({ ...f.options, checkpoint: phase => { if (phase === 'created') { mkdirSync(join(f.options.destination, 'workspace/nested'), { recursive: true }); writeFileSync(join(f.options.destination, 'workspace/nested/FIXTURE-rich-artifact.txt'), 'FIXTURE conflicting write'); } } }), /EEXIST/);
  const controller = new AbortController(); const original = await f.port.exportArchive(f.task.id, 5); let closed = false;
  const interrupted: ExportArtifact = { ...original, files: [{ ...original.files[0]!, open: () => Readable.from((async function* () { try { yield Buffer.from('FIXTURE'); controller.abort(new Error('FIXTURE owner abort')); yield Buffer.from(' all durable bytes'); } finally { closed = true; } })()) }] };
  const abortDestination = join(f.root, 'aborted');
  await assert.rejects(archiveEnvironment({ ...f.options, signal: controller.signal, destination: abortDestination, environment: { ...f.port, exportArchive: async () => interrupted } }));
  assert.equal(closed, true); assert.ok(existsSync(join(abortDestination, 'INCOMPLETE.json')));
  let epoch = 5;
  const staleSource: ExportArtifact = { ...original, files: [{ ...original.files[0]!, open: () => Readable.from((function* () { yield Buffer.from('FIXTURE'); epoch++; yield Buffer.from(' all durable bytes'); })()) }, original.files[1]!] };
  await assert.rejects(archiveEnvironment({ ...f.options, destination: join(f.root, 'epoch-changed'), environment: { ...f.port, exportArchive: async () => staleSource, snapshot: taskId => { const snapshot = f.port.snapshot(taskId); return { ...snapshot, lease: { ...snapshot.lease, epoch } }; } } }), code('stale-export'));
  const preAborted = new AbortController(); preAborted.abort(new Error('FIXTURE pre-abort')); let exported = false;
  await assert.rejects(archiveEnvironment({ ...f.options, destination: join(f.root, 'pre-abort'), signal: preAborted.signal, environment: { ...f.port, exportArchive: async () => { exported = true; return original; } } }), /pre-abort/);
  assert.equal(exported, false);
  assert.equal(f.archiveCalls(), 0); assert.equal(f.destroyed(), false);
  const release = acquireFileLease(f.sources.productLeasePath); release(); // Failure released the product kernel guard.
});

test('written bytes/inventory are reverified after inspection and immediately before destruction', async t => {
  const f = cleanupFixture(t);
  for (const [index, target] of ['workspace/nested/FIXTURE-rich-artifact.txt', 'workspace.tar', 'archive.json', 'FIXTURE-unexpected'].entries()) {
    const destination = join(f.root, `changed-written-${index}`);
    await assert.rejects(archiveEnvironment({ ...f.options, destination, checkpoint: phase => { if (phase === 'before-destroy') writeFileSync(join(destination, target), 'FIXTURE altered after initial verification'); } }));
    assert.equal(existsSync(join(destination, 'cleanup-result.json')), false); assert.equal(f.destroyed(), false);
  }
  assert.equal(f.archiveCalls(), 4, 'Archive may finish, but no destruction can follow changed output');
});
