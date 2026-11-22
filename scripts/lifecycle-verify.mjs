import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import console from 'node:console';
import process from 'node:process';
import { DockerEnvironmentEngine, EnvironmentBroker } from '../build/host/src/environment-broker.js';
import { archiveReceivers, assertArchiveDestinationAvailable, createArchiveLifecycle, productArchiveId } from '../build/host/src/lifecycle.js';
import { WorkspaceStore } from '../build/host/src/store.js';

const coordinatorDist = process.env.SPATIAL_COORDINATOR_DIST;
if (!coordinatorDist) { console.error("SPATIAL_COORDINATOR_DIST is not set; set it to the coordinator build's dist directory (docs/COORDINATOR-BUILD.md)."); process.exit(2); }

// Real Docker + real public coordinator + SQLite. No grants, CLI inference, providers,
// activation, service changes, or existing state. Gates delay ACKs only; engine calls stay real.
const rehearsalId = randomUUID();
const evidence = join(homedir(), '.local/share/spatial-agent-workspace/lifecycle-verification', rehearsalId);
mkdirSync(evidence, { recursive: true, mode: 0o700 });
const directory = join(evidence, 'broker'), state = join(evidence, 'coordinator');
mkdirSync(state, { mode: 0o700 });
const actor = { kind: 'operator', id: 'disposable-archive-rehearsal' };
writeFileSync(join(state, 'config.json'), JSON.stringify({ operator: actor.id }), { mode: 0o600 });
const previous = process.env.AGENTSYS_STATE; process.env.AGENTSYS_STATE = state;
const owner = { clientId: 'disposable-owner-fixture', surface: 'console' };
const trace = [], cleanup = [], owned = [], extra = [];
const docker = args => execFileSync('docker', args, { encoding: 'utf8', timeout: 30000, env: { PATH: process.env.PATH, HOME: process.env.HOME } }).trim();
const managed = taskId => JSON.parse(readFileSync(join(directory, 'environments.json'), 'utf8')).find(row => row.taskId === taskId);
function deferred() { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; }
class ObservedDockerEngine extends DockerEnvironmentEngine {
  verifyGate; toolGate; entered;
  async tool(environment, operation, payload) {
    const result = await super.tool(environment, operation, payload);
    if (this.toolGate && operation === 'write') { this.entered.release(); await this.toolGate.promise; }
    return result;
  }
  async verifyWorkspace(environment) {
    await super.verifyWorkspace(environment);
    const actual = JSON.parse(docker(['inspect', '--type', 'container', environment.containerId]))[0];
    const consumers = docker(['ps', '-a', '--no-trunc', '--filter', `volume=${environment.volume}`, '--format', '{{.ID}}']);
    assert.equal(actual.Id, environment.containerId); assert.equal(actual.State.Running, false); assert.equal(actual.State.Pid, 0);
    assert.equal(consumers, environment.containerId);
    trace.push({ stage: 'actual-docker-verify', taskId: environment.taskId, containerId: actual.Id, volume: environment.volume, pid: actual.State.Pid, running: actual.State.Running, soleConsumer: consumers, generation: environment.generation, epoch: environment.epoch });
    if (this.verifyGate) { this.entered.release(); await this.verifyGate.promise; }
  }
}
const engine = new ObservedDockerEngine();
let broker = new EnvironmentBroker(directory, engine), store = new WorkspaceStore(join(evidence, 'workspace.sqlite'));
let status = 'FAIL', failure;
try {
  assert.equal((await broker.readiness()).state, 'ready');
  const module = await import(pathToFileURL(resolve(coordinatorDist, 'commands.js')).href);
  const core = module.createCoordinatorCommands(() => { throw new Error('Rehearsal forbids runtime dispatch'); });
  assert.deepEqual(core.grantList(), []);
  const project = store.createProject({ name: 'Disposable Docker archive fixture', purpose: 'Test-owned zero-run history, not business data' });
  const source = store.registerSource({ spaceId: project.rootSpaceId, name: 'Retained fixture source', text: 'Test-owned source bytes', provenance: 'Disposable owner source fixture' });
  const tasks = [];
  for (let index = 0; index < 2; index++) {
    const task = store.createTask({ idempotencyKey: `offline:${index}`, spaceId: project.rootSpaceId, title: 'Offline fixture', prompt: 'Never executed', runtime: '', model: '', effort: '' });
    const submission = store.getSubmissionByKey(`offline:${index}`);
    store.updateSubmission(submission.id, { state: 'blocked' }); store.updateMessage(submission.messageId, { state: 'failed' }); store.updateTask(task.id, { state: 'stopped' });
    const environment = await broker.create(task.id); owned.push(managed(task.id));
    store.updateTask(task.id, { environmentId: environment.environmentId });
    tasks.push(task);
  }
  const product = { kind: 'project', id: project.id }, receivers = archiveReceivers(store, product);
  const commands = { ...core, interactiveArchive(actor, input, commit) {
    assert.equal(store.listArchiveIntents().length, 1);
    trace.push({ stage: 'before-coordinator-prepare', archiveId: input.archiveId });
    return core.interactiveArchive(actor, input, receipt => {
      assert.equal(core.interactiveArchiveLookup(actor, input.archiveId).state, 'prepared');
      trace.push({ stage: 'durable-coordinator-prepare', archiveId: receipt.archiveId, fingerprint: receipt.fingerprint });
      // The broker must still fence EVERY receiver, both here and inside SQL.
      for (const task of tasks) assert.equal(broker.controls.has(task.id), true);
      return commit(receipt);
    });
  } };
  const lifecycle = () => createArchiveLifecycle({ store, broker, commands, activated: () => true, actor: () => actor, authenticateOwner: value => { assert.deepEqual(value, owner); return actor; } });
  const archive = callback => lifecycle().archive(receivers, owner, callback ?? (() => store.archiveProject(project.id)), product);
  const first = tasks[0];
  // A real Docker write has happened, but its ACK and a following write remain queued.
  engine.toolGate = deferred(); engine.entered = deferred();
  const runningEpoch = broker.snapshot(first.id).lease.epoch;
  const write = broker.agent().write(first.id, runningEpoch, 'retained-proof.txt', 'actual Docker workspace bytes');
  const queued = broker.agent().write(first.id, runningEpoch, 'must-not-write.txt', 'superseded queued write');
  const settled = Promise.allSettled([write, queued]);
  await engine.entered.promise;
  await broker.owner().stop(first.id, runningEpoch, true);
  await broker.owner().stop(tasks[1].id, broker.snapshot(tasks[1].id).lease.epoch, true);
  assert.equal(broker.snapshot(first.id).state, 'stopped');
  assert.equal(broker.queues.has(first.id), true); // Explicit white-box queue evidence, not a fake queue.
  await assert.rejects(archive(), /active, queued or uncertain/);
  assert.equal(core.interactiveArchiveLookup(actor, productArchiveId(product)), undefined);
  trace.push({ stage: 'pending-queue-refused', stopped: true, pendingQueue: true });
  engine.toolGate.release(); engine.toolGate = undefined;
  assert.deepEqual((await settled).map(result => result.status), ['rejected', 'rejected']);
  // The product's retained environment must match the exact broker identity.
  const raw = new DatabaseSync(join(evidence, 'workspace.sqlite'));
  const original = store.getTask(first.id);
  raw.prepare('UPDATE tasks SET data=? WHERE id=?').run(JSON.stringify({ ...original, environmentId: randomUUID() }), first.id);
  await assert.rejects(archive(), /identity is missing or changed/);
  raw.prepare('UPDATE tasks SET data=? WHERE id=?').run(JSON.stringify(original), first.id); raw.close();
  trace.push({ stage: 'changed-retained-identity-refused', taskId: first.id });
  await assert.rejects(engine.verifyWorkspace({ ...managed(first.id), taskId: 'wrong-task-identity' }), /labels do not match/);
  // Additional consumer is test-owned, stopped, never started; exact-ID cleanup only.
  const env = managed(first.id);
  const extraId = docker(['create', '--label', `spatial.rehearsal=${rehearsalId}`, '--network', 'none', '--read-only', '--mount', `type=volume,src=${env.volume},dst=/workspace`, 'spatial-workspace-task:offline-v1']);
  extra.push(extraId);
  await assert.rejects(archive(), /additional container consumers/);
  assert.equal(JSON.parse(docker(['inspect', extraId]))[0].State.Pid, 0);
  docker(['rm', extraId]); extra.pop();
  trace.push({ stage: 'additional-stopped-volume-consumer-refused', extraId });
  // Real verifier held after Docker stopped/PID-zero/consumer checks, through failure.
  engine.verifyGate = deferred(); engine.entered = deferred();
  const changed = archive(); const changedResult = assert.rejects(changed, /identity or inactivity changed/);
  await engine.entered.promise;
  for (const task of tasks) {
    assert.equal(broker.controls.has(task.id), true);
    await assert.rejects(broker.owner().resume(task.id, broker.snapshot(task.id).lease.epoch, true), /progress/);
  }
  broker.reconnect(first.id);
  engine.verifyGate.release(); engine.verifyGate = undefined; await changedResult;
  assert.equal(core.interactiveArchiveLookup(actor, productArchiveId(product)), undefined);
  trace.push({ stage: 'changed-generation-refused-under-held-all-task-fence' });
  // Hold again, then run durable prepare -> failing SQL while proving all fences.
  engine.verifyGate = deferred(); engine.entered = deferred();
  const failed = archive(() => {
    for (const task of tasks) assert.equal(broker.controls.has(task.id), true);
    trace.push({ stage: 'sql-callback-failure-with-fences-held' });
    store.archiveProject(project.id); throw new Error('Disposable callback crash after tombstones before SQL commit');
  });
  const failedResult = assert.rejects(failed, /Disposable callback crash/);
  await engine.entered.promise;
  for (const task of tasks) await assert.rejects(broker.owner().stop(task.id, broker.snapshot(task.id).lease.epoch, true), /progress/);
  engine.verifyGate.release(); engine.verifyGate = undefined; await failedResult;
  const prepared = core.interactiveArchiveLookup(actor, productArchiveId(product));
  assert.equal(prepared.state, 'prepared'); assert.deepEqual(prepared.fence.runIds, []);
  assert.deepEqual(store.listArchives(), []); assert.equal(store.listArchiveIntents().length, 1);
  const before = store.exportHistory();
  broker.close(); store.close(); broker = new EnvironmentBroker(directory, engine); store = new WorkspaceStore(join(evidence, 'workspace.sqlite'));
  for (const receiver of receivers) assert.throws(() => assertArchiveDestinationAvailable(store, receiver), /archive attempt/);
  const guardedOwner = broker.owner(taskId => {
    const task = store.getTask(taskId); assertArchiveDestinationAvailable(store, { spaceId: task.spaceId, conversationId: task.conversationId, taskId });
  });
  await assert.rejects(async () => guardedOwner.resume(first.id, broker.snapshot(first.id).lease.epoch, true), /archive attempt/);
  trace.push({ stage: 'restart-without-reader-retains-prepared-ingress-and-owner-cutoff' });
  const tombstone = await archive(() => {
    for (const task of tasks) assert.equal(broker.controls.has(task.id), true);
    const result = store.archiveProject(project.id);
    trace.push({ stage: 'sqlite-tombstones-inside-held-transaction', archiveId: prepared.archiveId });
    return result;
  });
  assert.equal(core.interactiveArchiveLookup(actor, prepared.archiveId).state, 'archived');
  assert.equal(store.getArchiveBinding('project', project.id).fingerprint, prepared.fingerprint);
  trace.push({ stage: 'sqlite-commit-and-coordinator-archived', archiveId: prepared.archiveId, tombstone });
  const revision = store.revision;
  assert.deepEqual(await archive(() => assert.fail('Lost ACK must not repeat SQL')), tombstone); assert.equal(store.revision, revision);
  assert.deepEqual(store.exportHistory().messages, before.messages); assert.deepEqual(store.exportHistory().sources[0], { ...before.sources[0], id: source.id });
  const exported = await broker.owner().exportArchive(first.id, broker.snapshot(first.id).lease.epoch);
  const file = exported.files.find(file => file.path === 'retained-proof.txt');
  assert.equal(file.sha256, createHash('sha256').update('actual Docker workspace bytes').digest('hex'));
  assert.equal(exported.files.some(file => file.path === 'must-not-write.txt'), false);
  assert.deepEqual(core.grantList(), []);
  status = 'PASS';
} catch (error) { failure = String(error); }
finally {
  engine.toolGate?.release(); engine.verifyGate?.release();
  // Never prune or use names/prefixes. Every object was created in this rehearsal.
  for (const id of extra) {
    const item = JSON.parse(docker(['inspect', id]))[0];
    assert.equal(item.Id, id); assert.equal(item.Config.Labels['spatial.rehearsal'], rehearsalId);
    assert.equal(item.State.Running, false); assert.equal(item.State.Pid, 0); docker(['rm', id]);
  }
  for (const created of owned) {
    const environment = managed(created.taskId);
    assert.equal(environment.environmentId, created.environmentId); assert.equal(environment.rootId, created.rootId);
    assert.equal(environment.containerId, created.containerId); assert.equal(environment.volume, created.volume);
    const current = broker.snapshot(created.taskId);
    if (current.state !== 'stopped') await broker.owner().stop(created.taskId, current.lease.epoch, true);
    await engine.verifyWorkspace(environment);
    await engine.remove(environment); await engine.removeVolume(environment);
    assert.equal(docker(['ps', '-a', '--no-trunc', '--filter', `id=${environment.containerId}`, '--format', '{{.ID}}']), '');
    assert.equal(docker(['volume', 'ls', '--format', '{{.Name}}']).split('\n').includes(environment.volume), false);
    cleanup.push({ taskId: created.taskId, rootId: created.rootId, environmentId: created.environmentId, containerId: created.containerId, volume: created.volume, exactContainerAbsent: true, exactVolumeAbsent: true });
  }
  broker.close(); store.close();
  if (previous === undefined) delete process.env.AGENTSYS_STATE; else process.env.AGENTSYS_STATE = previous;
  const report = { status, evidence, rehearsalId, fixture: 'actual Docker engine + public coordinator in isolated state + real SQLite; no runtime/grants', failure, trace, cleanup, limits: ['Scheduling gates and white-box fence/queue assertions are test instrumentation; Docker stop, identity, labels, sole-consumer checks and coordinator/SQL commits are real.', 'Not live activation, inference, service cutover, provider or headset acceptance.'] };
  writeFileSync(join(evidence, 'result.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
}
if (status !== 'PASS') throw new Error(failure);
