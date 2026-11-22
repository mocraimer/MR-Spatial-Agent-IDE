import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { EnvironmentBroker, type EnvironmentEngine, type ManagedEnvironment } from '../src/environment-broker.js';
import { archiveReceivers, assertArchiveDestinationAvailable, createArchiveLifecycle, productArchiveId, type ArchiveCommands } from '../src/lifecycle.js';
import type { Actor, CoordinatorCommands, RuntimeAdapter, RuntimeCapabilities } from '../src/runtime-coordinator.js';
import { WorkspaceStore } from '../src/store.js';
import { PairingAuthority, ensureHostCertificate } from '../src/auth.js';
import { createHostServer } from '../src/server.js';
import { coordinatorSkip, coordinatorUrl } from './coordinator.js';

const commandsUrl = coordinatorUrl('commands.js');
const actor: Actor = { kind: 'operator', id: 'archive-fixture-owner' };
const owner = { clientId: 'fixture-client', surface: 'native' as const };
class ProvenEngine implements EnvironmentEngine {
  operations: string[] = [];
  gate: Promise<void> | undefined;
  fault = false;
  async readiness() { return { id: 'fixture', state: 'ready' as const, detail: 'Fixture only, not Docker capability evidence' }; }
  async create() { return '1'.repeat(64); }
  async start() {}
  async stopAndVerify() { this.operations.push('stop'); }
  async remove() { this.operations.push('remove'); }
  async removeVolume() { this.operations.push('removeVolume'); }
  async verifyWorkspace(environment: ManagedEnvironment) { this.operations.push('verify:' + environment.taskId); await this.gate; if (this.fault) throw new Error('actual fixture verification failed'); assert.ok(['stopped', 'archived'].includes(environment.state)); }
  async tool() { this.operations.push('tool'); return { output: 'fixture', exitCode: 0 }; }
}
class Adapter implements RuntimeAdapter {
  readonly guardedInteractive = true;
  readonly capabilities: RuntimeCapabilities = { runtime: 'pi-local', subscriptionId: 'archive-fixture', supportsModelSelection: true, supportsEffortSelection: true, effortLevels: ['high'], reportsEffectiveSettings: true, acceptsCallerSessionId: true, skillInvocationForm: 'fixture' };
  async checkReadiness() { return undefined; }
  async readUsage() { return { ok: true as const, reading: { subscriptionId: 'archive-fixture', observedAt: new Date().toISOString(), source: 'fixture', windows: [{ kind: 'five-hour' as const, usedPercent: 0, vendorLabel: 'fixture' }, { kind: 'weekly' as const, usedPercent: 0, vendorLabel: 'fixture' }] } }; }
  async reconcile() { return { kind: 'remote-uncertain' as const, summary: 'fixture', nextAction: 'inspect' }; }
  async dispatch(input: Parameters<RuntimeAdapter['dispatch']>[0]) { const settings = { model: input.settings.model!, effort: input.settings.effort! }; return { outcome: { kind: 'completed' as const, runId: input.runId, taskId: input.taskId, summary: 'fixture', nextAction: 'inspect' }, settings: { requested: settings, resolved: settings, observed: settings } }; }
}
async function fixture(withGrant = true) {
  const directory = mkdtempSync(join(tmpdir(), 'spatial-archive-')), state = join(directory, 'coordinator');
  const previous = process.env.AGENTSYS_STATE; process.env.AGENTSYS_STATE = state;
  mkdirSync(state); writeFileSync(join(state, 'config.json'), JSON.stringify({ operator: actor.id }));
  let store = new WorkspaceStore(join(directory, 'workspace.sqlite'));
  const engine = new ProvenEngine(), broker = new EnvironmentBroker(join(directory, 'environments'), engine);
  const module = await import(commandsUrl) as { createCoordinatorCommands(factory: () => RuntimeAdapter): CoordinatorCommands & ArchiveCommands };
  const commands = module.createCoordinatorCommands(() => new Adapter());
  if (withGrant) commands.grantCreate(actor, { repos: ['fixture'], workClasses: ['fixture'], triggerSources: ['owner'], actions: ['conversation', 'task-tools', 'delegate-task'], runtimes: ['pi-local'], profiles: ['fixture'], perTask: { maxAttempts: 12, maxConcurrentRuns: 2, maxPaidCallUsd: 0 }, aggregate: { maxDispatchesPerWindow: 20, maxConcurrentRuns: 2, windowHours: 24 }, reason: 'Disposable test state only; never live authority' });
  const project = store.createProject({ name: 'Archive test fixture', purpose: 'No real provider or Docker calls' });
  const product = { kind: 'project' as const, id: project.id };
  let activated = true;
  const lifecycle = () => createArchiveLifecycle({ store, broker, commands, actor: () => actor, activated: () => activated, authenticateOwner: value => { assert.deepEqual(value, owner); return actor; } });
  async function task(spaceId = project.rootSpaceId, parentTaskId: string | null = null, environment = true) {
    const task = store.createTask({ idempotencyKey: 'task:' + store.revision, spaceId, title: 'Fixture history', prompt: 'Fixture only', runtime: 'pi-local', model: 'fixture/model', effort: 'high', parentTaskId });
    const submission = store.getSubmissionByKey('task:' + (store.revision - 1))!;
    const parent = parentTaskId ? store.getTask(parentTaskId) : null;
    const result = await commands.interactiveSubmit({ taskId: 'coordinator:' + task.id, repo: 'fixture', workClass: 'fixture', runtime: 'pi-local', profile: 'fixture', actions: ['conversation', 'task-tools', 'delegate-task'], triggerSource: 'owner', settings: { model: 'fixture/model', effort: 'high' }, prompt: 'Fixture only', estimate: { basis: 'operator-bound', detail: 'fixture', fiveHourPercent: 1, weeklyPercent: 1, uncertaintyPercent: 0 }, entry: 'interactive', interactive: { requestId: submission.id, conversationId: task.conversationId, ...(parent?.runId ? { parentRunId: parent.runId } : {}) } });
    assert.equal(result?.run?.status, 'completed');
    store.updateSubmission(submission.id, { state: 'settled', coordinatorTaskId: result!.taskId, runId: result!.run!.id });
    store.updateMessage(submission.messageId, { state: 'complete' });
    store.updateTask(task.id, { state: 'completed', coordinatorTaskId: result!.taskId, runId: result!.run!.id });
    if (environment) { const env = await broker.create(task.id); store.updateTask(task.id, { environmentId: env.environmentId }); await broker.owner().stop(task.id, env.lease.epoch, true); engine.operations.length = 0; }
    return store.getTask(task.id);
  }
  return { directory, state, engine, broker, commands, product, project, lifecycle, task, get store() { return store; }, setActivation(value: boolean) { activated = value; }, reopen() { store.close(); store = new WorkspaceStore(join(directory, 'workspace.sqlite')); }, close() { broker.close(); store.close(); if (previous === undefined) delete process.env.AGENTSYS_STATE; else process.env.AGENTSYS_STATE = previous; rmSync(directory, { recursive: true, force: true }); } };
}

test('offline blocked never-executed history fences explicit receivers with zero runs and no grant or provider', { skip: coordinatorSkip }, async () => {
  const f = await fixture(false);
  try {
    const task = f.store.createTask({ idempotencyKey: 'offline-task', spaceId: f.project.rootSpaceId, title: 'Offline fixture', prompt: 'Never sent', runtime: '', model: '', effort: '' });
    const submission = f.store.getSubmissionByKey('offline-task')!;
    f.store.updateSubmission(submission.id, { state: 'blocked' }); f.store.updateMessage(submission.messageId, { state: 'failed' }); f.store.updateTask(task.id, { state: 'stopped' });
    const receivers = archiveReceivers(f.store, f.product);
    await f.lifecycle().archive(receivers, owner, () => f.store.archiveProject(f.product.id), f.product);
    const receipt = f.commands.interactiveArchiveLookup(actor, productArchiveId(f.product))!;
    assert.deepEqual(receipt.input.runIds, []); assert.deepEqual(receipt.fence.runIds, []);
    assert.ok(receipt.fence.conversationIds.includes(task.conversationId)); assert.deepEqual(f.commands.grantList(), []);
    assert.deepEqual(f.engine.operations, []); assert.equal(f.store.isArchived('task', task.id), true);
  } finally { f.close(); }
});

test('actual public coordinator + SQLite retains stopped volume, all history, exact binding and idempotent original tombstone', { skip: coordinatorSkip }, async () => {
  const f = await fixture();
  try {
    const task = await f.task(), receivers = archiveReceivers(f.store, f.product), before = f.store.exportHistory();
    const forbidden = { kind: 'space' as const, id: f.project.rootSpaceId };
    assert.throws(() => archiveReceivers(f.store, forbidden), /project instead/);
    await assert.rejects(f.lifecycle().archive(receivers, owner, () => f.store.archiveSpace(forbidden.id), forbidden), /project instead/);
    assert.equal(f.commands.interactiveArchiveLookup(actor, productArchiveId(forbidden)), undefined);
    const run = f.commands.interactiveLookup(before.submissions[0]!.id)!.run!, evidence = readFileSync(join(run.evidenceDir!, 'dispatch-request.json'));
    let commits = 0;
    const archive = await f.lifecycle().archive(receivers, owner, () => { commits++; return f.store.archiveProject(f.product.id); }, f.product);
    const reference = f.store.getArchiveBinding('project', f.product.id)!;
    assert.equal(reference.archiveId, productArchiveId(f.product));
    assert.deepEqual(f.store.getArchiveBinding('task', task.id)?.product, f.product);
    assert.deepEqual(f.engine.operations, ['verify:' + task.id]);
    assert.equal(f.broker.snapshot(task.id).state, 'stopped');
    assert.deepEqual(readFileSync(join(run.evidenceDir!, 'dispatch-request.json')), evidence);
    assert.deepEqual(f.store.exportHistory().messages, before.messages);
    const revision = f.store.revision;
    f.reopen();
    assert.deepEqual(await f.lifecycle().archive(receivers, owner, () => assert.fail('duplicate SQL commit'), f.product), archive);
    assert.equal(f.store.revision, revision); assert.equal(commits, 1);
    assert.equal(f.commands.interactiveArchiveLookup(actor, reference.archiveId)?.state, 'archived');
    assert.throws(() => f.lifecycle().assertDestinationAvailable(receivers[0]!));
  } finally { f.close(); }
});

test('all sibling delegated environments stay fenced through awaited actual verification and synchronous coordinator/SQL commit', { skip: coordinatorSkip }, async () => {
  const f = await fixture(); let release!: () => void;
  try {
    const parent = await f.task(), other = f.store.createSpace({ projectId: f.project.id, parentId: f.project.rootSpaceId, name: 'Sibling fixture', purpose: '' });
    const child = await f.task(other.id, parent.id), product = { kind: 'task' as const, id: parent.id };
    f.engine.gate = new Promise<void>(resolve => { release = resolve; });
    const receivers = archiveReceivers(f.store, product);
    assert.ok(receivers.some(receiver => receiver.taskId === child.id));
    const operation = f.lifecycle().archive(receivers, owner, () => f.store.archiveTask(parent.id), product);
    while (!f.engine.operations.length) await new Promise(resolve => setImmediate(resolve));
    for (const task of [parent, child]) await assert.rejects(f.broker.owner().resume(task.id, f.broker.snapshot(task.id).lease.epoch, true), /progress/);
    f.engine.gate = undefined; release(); await operation;
    assert.equal(f.store.isArchived('task', child.id), true); assert.equal(f.store.isArchived('space', other.id), false);
    assert.equal(f.commands.interactiveArchiveLookup(actor, productArchiveId(product))!.fence.runIds.length, 2);
    assert.deepEqual(f.engine.operations.sort(), ['verify:' + parent.id, 'verify:' + child.id].sort());
  } finally { release?.(); f.close(); }
});

test('actual verification failure, missing retained environment, active work, stale generation and absent activation refuse without SQL or silent stop', { skip: coordinatorSkip }, async () => {
  const f = await fixture(); let release!: () => void;
  try {
    const task = await f.task(), receivers = archiveReceivers(f.store, f.product), revision = f.store.revision;
    const archive = () => f.lifecycle().archive(receivers, owner, () => f.store.archiveProject(f.product.id), f.product);
    f.setActivation(false); await assert.rejects(archive(), /activation/); f.setActivation(true);
    f.engine.fault = true; await assert.rejects(archive(), /verification failed/); f.engine.fault = false;
    f.engine.gate = new Promise<void>(resolve => { release = resolve; });
    const pending = archive(); while (f.engine.operations.length < 2) await new Promise(resolve => setImmediate(resolve));
    f.broker.reconnect(task.id); release(); await assert.rejects(pending, /changed/); f.engine.gate = undefined;
    assert.equal(f.store.revision, revision); assert.deepEqual(f.store.listArchives(), []);
    assert.equal(f.commands.interactiveArchiveLookup(actor, productArchiveId(f.product)), undefined);
    await f.broker.owner().resume(task.id, f.broker.snapshot(task.id).lease.epoch, true);
    await assert.rejects(archive(), /active/);
    assert.deepEqual(f.store.listArchives(), []);
  } finally { release?.(); f.close(); }
});

test('actual prepared coordinator cutoff blocks HTTP voice/source/control before effects, then archive retry keeps retained history readable', { skip: coordinatorSkip }, async () => {
  const f = await fixture(); let host: ReturnType<typeof createHostServer> | undefined;
  try {
    const task = await f.task(), receivers = archiveReceivers(f.store, f.product);
    await assert.rejects(f.lifecycle().archive(receivers, owner, () => { throw new Error('fixture SQL refusal'); }, f.product));
    const auth = new PairingAuthority(join(f.directory, 'auth')), certificate = ensureHostCertificate(join(f.directory, 'tls'));
    const lifecycle = createArchiveLifecycle({ store: f.store, broker: f.broker, commands: f.commands, activated: () => true, actor: () => actor, authenticateOwner: () => actor });
    let paid = 0;
    host = createHostServer({ store: f.store, auth, certificate, services: { lifecycle, speech: { readiness: async () => [], transcribe: async () => { paid++; return 'not allowed'; }, synthesize: async () => Buffer.alloc(0) } } });
    const ports = await host.listen(), base = `http://127.0.0.1:${ports.consolePort}`;
    const post = (path: string, body: unknown) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const target = receivers.find(receiver => receiver.taskId === null)!;
    assert.equal((await post('/v1/voice', { idempotencyKey: 'prepared-voice', receiver: target, wavBase64: 'not-paid' })).status, 409);
    assert.equal(paid, 0); assert.equal(f.store.getVoiceIntent('prepared-voice'), undefined);
    assert.equal((await post('/v1/spaces/' + task.spaceId + '/sources', { name: 'No', text: 'No effect', provenance: 'fixture' })).status, 409);
    assert.equal((await post('/v1/tasks/' + task.id + '/control', { action: 'resume', expectedEpoch: f.broker.snapshot(task.id).lease.epoch, confirmReset: true })).status, 409);
    assert.equal((await fetch(base + '/v1/history/export')).status, 200);
    assert.equal((await post('/v1/archive/project/' + f.product.id, {})).status, 200);
    assert.equal((await post('/v1/tasks/' + task.id + '/control', { action: 'resume', expectedEpoch: f.broker.snapshot(task.id).lease.epoch, confirmReset: true })).status, 409);
    assert.equal((await fetch(base + '/v1/history/export')).status, 200);
  } finally { await host?.close(); f.close(); }
});

test('uncommitted prepared archive blocks ingress and same-key retry reconciles fresh SQL under held proof', { skip: coordinatorSkip }, async () => {
  const f = await fixture();
  try {
    await f.task(); const receivers = archiveReceivers(f.store, f.product);
    await assert.rejects(f.lifecycle().archive(receivers, owner, () => { f.store.archiveProject(f.product.id); throw new Error('SQLite fixture callback failure'); }, f.product), /callback failure/);
    assert.deepEqual(f.store.listArchives(), []); assert.deepEqual(f.store.exportHistory().archiveBindings, []);
    const prepared = f.commands.interactiveArchiveLookup(actor, productArchiveId(f.product))!;
    assert.equal(prepared.state, 'prepared'); assert.equal(f.store.observeCoordinatedArchive({ archiveId: prepared.archiveId, fingerprint: prepared.fingerprint, product: f.product }).state, 'uncommitted');
    assert.throws(() => f.lifecycle().assertDestinationAvailable(receivers[0]!), /cutoff/);
    f.reopen(); await f.lifecycle().archive(receivers, owner, () => f.store.archiveProject(f.product.id), f.product);
    assert.equal(f.commands.interactiveArchiveLookup(actor, prepared.archiveId)?.state, 'archived');
    assert.equal(f.store.exportHistory().archiveBindings.filter(binding => binding.kind === 'project').length, 1);
  } finally { f.close(); }
});

for (const kind of ['project', 'task'] as const) test(`zero-run failed ${kind} archive survives restart without reader; exact receivers and ancestors close, unrelated root remains usable`, { skip: coordinatorSkip }, async () => {
  const f = await fixture(false); let host: ReturnType<typeof createHostServer> | undefined;
  try {
    const child = f.store.createSpace({ projectId: f.project.id, parentId: f.project.rootSpaceId, name: 'Affected fixture', purpose: '' });
    const source = f.store.registerSource({ spaceId: child.id, name: 'Retained fixture', text: 'Exact source history', provenance: 'Fixture owner upload' });
    const task = f.store.createTask({ idempotencyKey: 'zero-run', spaceId: child.id, title: 'Offline', prompt: 'Never sent', runtime: '', model: '', effort: '' });
    const submission = f.store.getSubmissionByKey('zero-run')!;
    f.store.updateSubmission(submission.id, { state: 'blocked' }); f.store.updateMessage(submission.messageId, { state: 'failed' }); f.store.updateTask(task.id, { state: 'stopped' });
    const product = kind === 'task' ? { kind, id: task.id } : f.product, receivers = archiveReceivers(f.store, product);
    const before = f.store.exportHistory();
    await assert.rejects(f.lifecycle().archive(receivers, owner, () => { if (kind === 'task') f.store.archiveTask(task.id); else f.store.archiveProject(f.product.id); throw new Error('Failed SQL fixture'); }, product), /Failed SQL/);
    const receipt = f.commands.interactiveArchiveLookup(actor, productArchiveId(product))!;
    assert.equal(receipt.state, 'prepared'); assert.deepEqual(receipt.fence.runIds, []);
    assert.deepEqual(f.store.listArchives(), []); assert.deepEqual(f.store.exportHistory().archiveBindings, []);
    f.reopen();
    assert.equal(f.store.exportHistory().archiveIntents.length, 1);
    // Trusted SQL may exempt only the exact receipt input, never a matching ID alone.
    assert.throws(() => f.store.commitCoordinatedArchive({ archiveId: receipt.archiveId, fingerprint: receipt.fingerprint, product }, () => f.store.archiveTask(task.id)), /trusted receipt/);
    assert.throws(() => f.store.archiveProject(f.project.id), /attempt/);
    const auth = new PairingAuthority(join(f.directory, 'auth')), certificate = ensureHostCertificate(join(f.directory, 'tls'));
    let paid = 0, controls = 0;
    host = createHostServer({ store: f.store, auth, certificate, services: {
      speech: { readiness: async () => [], transcribe: async () => { paid++; return 'open my global inbox'; }, synthesize: async () => Buffer.alloc(0) },
      environment: { readiness: async () => ({ id: 'fixture', state: 'blocked', detail: 'Fixture only' }), views: () => [], snapshots: () => [], frame: async () => assert.fail('No frame effect'), terminal: async () => '', owner: () => { controls++; return f.broker.owner(); } },
    } });
    const ports = await host.listen(), base = `http://127.0.0.1:${ports.consolePort}`;
    const request = (path: string, body: unknown, method = 'POST') => fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const target = { spaceId: task.spaceId, conversationId: task.conversationId, taskId: task.id };
    for (const receiver of [target, { spaceId: child.id, conversationId: child.conversationId, taskId: null }]) {
      assert.equal((await request('/v1/voice', { idempotencyKey: 'failed-voice', receiver, wavBase64: 'before-paid-call' })).status, 409);
    }
    assert.equal(paid, 0); assert.equal(f.store.getVoiceIntent('failed-voice'), undefined);
    assert.equal((await request(`/v1/tasks/${task.id}/control`, { action: 'resume', expectedEpoch: 1, confirmReset: true })).status, 409); assert.equal(controls, 0);
    assert.equal((await request(`/v1/spaces/${child.id}/sources`, { name: 'No', text: 'No mutation', provenance: 'Fixture' })).status, 409);
    assert.equal((await request(`/v1/projects/${f.project.id}`, { name: 'Ancestor edit' }, 'PATCH')).status, 409);
    assert.equal((await request('/v1/spaces', { projectId: f.project.id, parentId: child.id, name: 'New child', purpose: '' })).status, 409);
    assert.equal((await request('/v1/tasks', { idempotencyKey: 'new-child', spaceId: child.id, parentTaskId: task.id, title: 'No', prompt: 'No', runtime: '', model: '', effort: '' })).status, 409);
    const response = await request('/v1/projects', { name: 'Unrelated empty root', purpose: '' }); assert.equal(response.status, 201);
    const unrelated = await response.json() as { rootSpaceId: string };
    assert.equal((await request(`/v1/spaces/${unrelated.rootSpaceId}/sources`, { name: 'Allowed', text: 'Local only', provenance: 'Fixture' })).status, 201);
    const unrelatedSpace = f.store.getSpace(unrelated.rootSpaceId);
    const wave = Buffer.alloc(46); wave.write('RIFF'); wave.writeUInt32LE(38, 4); wave.write('WAVEfmt ', 8); wave.writeUInt32LE(16, 16); wave.writeUInt16LE(1, 20); wave.writeUInt16LE(1, 22); wave.writeUInt32LE(16000, 24); wave.writeUInt32LE(32000, 28); wave.writeUInt16LE(2, 32); wave.writeUInt16LE(16, 34); wave.write('data', 36); wave.writeUInt32LE(2, 40);
    assert.equal((await request('/v1/voice', { idempotencyKey: 'unrelated-local-command', receiver: { spaceId: unrelatedSpace.id, conversationId: unrelatedSpace.conversationId, taskId: null }, wavBase64: wave.toString('base64') })).status, 200);
    assert.equal(paid, 1);
    assert.deepEqual(f.store.exportHistory().messages.filter(message => before.messages.some(old => old.id === message.id)), before.messages);
    assert.deepEqual(f.store.exportHistory().sources.find(item => item.id === source.id), before.sources[0]);
    await host.close(); host = undefined;
    await f.lifecycle().archive(receivers, owner, () => kind === 'task' ? f.store.archiveTask(task.id) : f.store.archiveProject(f.product.id), product);
    const original = f.store.listArchives(), revision = f.store.revision;
    await f.lifecycle().archive(receivers, owner, () => assert.fail('Lost ACK must retain original tombstone'), product);
    assert.deepEqual(f.store.listArchives(), original); assert.equal(f.store.revision, revision);
    if (kind === 'task') {
      // Matching coordinator receipt + atomic SQL end the pending ancestor fence, not the task cutoff.
      f.lifecycle().assertDestinationAvailable({ spaceId: child.id, conversationId: child.conversationId, taskId: null });
      assert.equal(f.store.readSourceForSpace(child.id, source.id).text, 'Exact source history');
      f.store.updateProject(f.project.id, { name: 'Still-active parent' });
      assert.equal(f.store.listArchiveIntents().length, 1); assert.throws(() => f.store.assertDestinationAvailable(task.spaceId, task.id), /archived/);
    }
  } finally { await host?.close(); f.close(); }
});

test('unavailable reader uses retained zero-run family rather than links; verified reader absence opens unaffected history', { skip: coordinatorSkip }, async () => {
  const f = await fixture(false);
  try {
    const task = f.store.createTask({ idempotencyKey: 'old-zero-run', spaceId: f.project.rootSpaceId, title: 'Pre-intent fixture', prompt: 'Never sent', runtime: '', model: '', effort: '' });
    const receiver = { spaceId: task.spaceId, conversationId: task.conversationId, taskId: task.id };
    assert.throws(() => assertArchiveDestinationAvailable(f.store, receiver), /reader is unavailable/);
    f.setActivation(false); assert.throws(() => f.lifecycle().assertDestinationAvailable(receiver), /reader is unavailable/);
    const other = f.store.createProject({ name: 'Unrelated fixture', purpose: '' }), space = f.store.getSpace(other.rootSpaceId);
    f.lifecycle().assertDestinationAvailable({ spaceId: space.id, conversationId: space.conversationId, taskId: null });
    f.setActivation(true); f.lifecycle().assertDestinationAvailable(receiver);
  } finally { f.close(); }
});

for (const committed of [false, true]) test(`killed independent host ${committed ? 'after' : 'before'} SQLite commit retains prepared cutoff; restart preserves one original binding`, { timeout: 20000, skip: coordinatorSkip }, async () => {
  const f = await fixture(false);
  const storeUrl = new URL('../src/store.js', import.meta.url).href, lifecycleUrl = new URL('../src/lifecycle.js', import.meta.url).href;
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const task = f.store.createTask({ idempotencyKey: 'killed-zero-run', spaceId: f.project.rootSpaceId, title: 'Zero-run killed fixture', prompt: 'Never executed', runtime: '', model: '', effort: '' });
    const submission = f.store.getSubmissionByKey('killed-zero-run')!;
    f.store.updateSubmission(submission.id, { state: 'blocked' }); f.store.updateMessage(submission.messageId, { state: 'failed' }); f.store.updateTask(task.id, { state: 'stopped' });
    const receivers = archiveReceivers(f.store, f.product);
    const code = `import {createCoordinatorCommands} from ${JSON.stringify(commandsUrl)};
      import {WorkspaceStore} from ${JSON.stringify(storeUrl)};
      import {createArchiveLifecycle} from ${JSON.stringify(lifecycleUrl)};
      const core=createCoordinatorCommands(()=>{throw Error('no runtime');});
      const commands={interactiveLookup:core.interactiveLookup,interactiveArchiveLookup:core.interactiveArchiveLookup,interactiveArchiveReconcile:core.interactiveArchiveReconcile,
        interactiveArchive(actor,input,commit){return core.interactiveArchive(actor,input,receipt=>{const result=commit(receipt);if(${committed}){process.send('prepared');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);}return result;});}};
      const store=new WorkspaceStore(${JSON.stringify(join(f.directory, 'workspace.sqlite'))});
      const broker={snapshots(){return [];},async withInactive(_tasks,callback){return callback(()=>{});}};
      const lifecycle=createArchiveLifecycle({store,broker,commands,activated:()=>true,actor:()=>(${JSON.stringify(actor)}),authenticateOwner:()=>(${JSON.stringify(actor)})});
      await lifecycle.archive(${JSON.stringify(receivers)},${JSON.stringify(owner)},()=>{if(!${committed}){process.send('prepared');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);}return store.archiveProject(${JSON.stringify(f.product.id)});},${JSON.stringify(f.product)});`;
    child = spawn(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, AGENTSYS_STATE: f.state }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let stderr = ''; child.stderr!.on('data', chunk => { stderr += String(chunk); });
    const ready = new Promise<void>((resolve, reject) => { child!.once('message', () => resolve()); child!.once('error', reject); child!.once('exit', code => reject(new Error('Fixture process exited early: ' + code + ': ' + stderr))); });
    await ready; const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    f.reopen();
    assert.equal(f.commands.interactiveArchiveLookup(actor, productArchiveId(f.product))?.state, 'prepared');
    if (!committed) {
      assert.throws(() => f.lifecycle().assertDestinationAvailable(receivers[0]!), /cutoff/);
      assert.throws(() => assertArchiveDestinationAvailable(f.store, receivers[0]!), /archive attempt/);
      assert.equal(f.store.exportHistory().archiveIntents.length, 1);
      const auth = new PairingAuthority(join(f.directory, 'auth')), certificate = ensureHostCertificate(join(f.directory, 'tls'));
      let paid = 0;
      const server = createHostServer({ store: f.store, auth, certificate, services: { speech: { readiness: async () => [], transcribe: async () => { paid++; return 'denied'; }, synthesize: async () => Buffer.alloc(0) } } });
      try {
        const ports = await server.listen();
        const response = await fetch(`http://127.0.0.1:${ports.consolePort}/v1/voice`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idempotencyKey: 'killed-voice', receiver: receivers[0], wavBase64: 'not-paid' }) });
        assert.equal(response.status, 409); assert.equal(paid, 0); assert.equal(f.store.getVoiceIntent('killed-voice'), undefined);
        for (const [path, value] of [
          [`/v1/spaces/${task.spaceId}/sources`, { name: 'No killed source', text: 'No new effect', provenance: 'Fixture' }],
          [`/v1/tasks/${task.id}/control`, { action: 'resume', expectedEpoch: 1, confirmReset: true }],
        ] as const) {
          const denied = await fetch(`http://127.0.0.1:${ports.consolePort}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
          assert.equal(denied.status, 409);
        }
      } finally { await server.close(); }
    }
    const old = f.store.listArchives().find(record => record.kind === 'project');
    await f.lifecycle().archive(receivers, owner, () => { if (committed) assert.fail('lost ack must not duplicate commit'); return f.store.archiveProject(f.product.id); }, f.product);
    if (old) assert.deepEqual(f.store.listArchives().find(record => record.kind === 'project'), old);
    assert.equal(f.store.exportHistory().archiveBindings.filter(binding => binding.kind === 'project').length, 1);
    assert.equal(f.commands.interactiveArchiveLookup(actor, productArchiveId(f.product))?.state, 'archived');
  } finally { child?.kill('SIGKILL'); f.close(); }
});
