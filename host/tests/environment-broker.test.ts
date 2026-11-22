import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EnvironmentBroker, EnvironmentError, type EnvironmentEngine, type ManagedEnvironment } from '../src/environment-broker.js';
import type { TaskInput } from '../src/protocol.js';

const png = Buffer.alloc(40); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
function tar(entries: { path: string; content?: Buffer; type?: string }[]): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const content = entry.content ?? Buffer.alloc(0); const header = Buffer.alloc(512);
    header.write(entry.path, 0, 100, 'utf8');
    header.write('0000644\0', 100); header.write('0001750\0', 108); header.write('0001750\0', 116);
    header.write(content.length.toString(8).padStart(11, '0') + '\0', 124); header.write('00000000000\0', 136);
    header.fill(32, 148, 156); header.write(entry.type ?? '0', 156); header.write('ustar\0', 257); header.write('00', 263);
    header.write([...header].reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0') + '\0 ', 148);
    blocks.push(header, content, Buffer.alloc((512 - content.length % 512) % 512));
  }
  return Buffer.concat([...blocks, Buffer.alloc(1024)]);
}
async function streamBytes(stream: AsyncIterable<Buffer>): Promise<Buffer> { const chunks: Buffer[] = []; for await (const chunk of stream) chunks.push(chunk); return Buffer.concat(chunks); }
class FakeEngine implements EnvironmentEngine {
  operations: { operation: string; container: string | null }[] = [];
  files = new Map<string, string>();
  counter = 0;
  stopFault = false;
  startFault = false;
  toolFault = false;
  gate: Promise<void> | null = null;
  captureGate: Promise<void> | null = null;
  archiveOverride: Buffer | null = null;
  exportFault = false;
  async readiness() { return { id: 'fake', state: 'ready' as const, detail: 'Test engine; not capability evidence' }; }
  async create() { return (++this.counter).toString(16).padStart(64, '0'); }
  async start() { if (this.startFault) throw new Error('start failure'); }
  async stopAndVerify(environment: ManagedEnvironment) { this.operations.push({ operation: 'stop', container: environment.containerId }); if (this.stopFault) throw new Error('unverified stop'); }
  async remove(environment: ManagedEnvironment) { this.operations.push({ operation: 'remove', container: environment.containerId }); }
  async removeVolume() { this.operations.push({ operation: 'removeVolume', container: null }); this.files.clear(); }
  async captureWorkspace(environment: ManagedEnvironment, fd: number) {
    this.operations.push({ operation: 'capture', container: environment.containerId });
    if (this.captureGate) await this.captureGate;
    if (this.exportFault) throw new Error('disk full or interrupted engine stream fixture');
    const entries = [...this.files].filter(([path]) => path.startsWith(environment.taskId + ':')).map(([path, content]) => ({ path: path.slice(environment.taskId.length + 1), content: Buffer.from(content, 'base64') }));
    writeFileSync(fd, this.archiveOverride ?? tar(entries));
  }
  async tool(environment: ManagedEnvironment, operation: string, payload: Record<string, unknown>) {
    this.operations.push({ operation, container: environment.containerId });
    if (['exec', 'read', 'frame'].includes(operation) && this.gate) await this.gate;
    if (this.toolFault) throw new Error('lost tool acknowledgement');
    if (operation === 'frame') return { pngBase64: png.toString('base64'), width: 1280, height: 800 };
    if (operation === 'write') this.files.set(`${environment.taskId}:${String(payload.path)}`, String(payload.contentBase64));
    if (operation === 'read') return { contentBase64: this.files.get(`${environment.taskId}:${String(payload.path)}`) ?? '' };
    return { output: 'real output belongs to engine, fixture here', exitCode: 0 };
  }
}
let directory: string;
let engine: FakeEngine;
let broker: EnvironmentBroker;
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'spatial-env-unit-')); engine = new FakeEngine(); broker = new EnvironmentBroker(directory, engine); });
afterEach(() => { broker.close(); rmSync(directory, { recursive: true, force: true }); });
function input(task = 'task'): TaskInput {
  const snapshot = broker.snapshot(task); const view = snapshot.views[0]!;
  return { taskId: task, environmentId: snapshot.environmentId, viewId: view.id, generation: view.generation, leaseEpoch: snapshot.lease.epoch, kind: 'text', x: 0, y: 0, key: '', button: '', text: 'hello' };
}
function errorCode(code: string) { return (error: unknown) => error instanceof EnvironmentError && error.code === code; }

describe('trusted environment broker authority and fault fencing (fake engine, not capability proof)', () => {
  it('requires confirmation without destroying or fencing the ordinary request', async () => {
    await broker.create('task');
    const owner = broker.owner(); const agent = broker.agent();
    assert.equal('takeControl' in agent, false);
    const pending = await owner.takeControl('task', 1);
    assert.equal(pending.owner, 'handoff'); assert.match(pending.detail, /confirmation-required.*unsaved/);
    assert.equal(broker.snapshot('task').lease.owner, 'agent');
    assert.equal(engine.operations.length, 0);
    assert.equal((await owner.takeControl('task', 1, 'false' as unknown as boolean)).owner, 'handoff');
    assert.equal(engine.operations.length, 0);
    await agent.exec('task', 1, 'echo still-running');
    const controlled = await owner.takeControl('task', 1, true);
    assert.equal(controlled.owner, 'owner'); assert.equal(controlled.epoch, 2);
    assert.equal(broker.snapshot('task').views[0]?.generation, 2);
    await assert.rejects(async () => agent.exec('task', 2, 'echo denied'), errorCode('control-unavailable'));
    await owner.exec('task', 2, 'echo owner');
    assert.equal((await owner.resume('task', 2)).owner, 'handoff');
    assert.equal(broker.snapshot('task').lease.owner, 'owner');
    assert.equal((await owner.resume('task', 2, true)).owner, 'agent');
    await assert.rejects(async () => owner.exec('task', 3, 'denied'), errorCode('control-unavailable'));
  });

  it('fences all queued mutations, uses a new physical container, and rejects old acknowledgement', async () => {
    await broker.create('task');
    let release!: () => void; engine.gate = new Promise<void>(accept => { release = accept; });
    const agent = broker.agent(); const owner = broker.owner();
    const running = agent.exec('task', 1, 'blocking');
    await new Promise(resolve => setImmediate(resolve));
    const queued = agent.write('task', 1, 'late.txt', 'must not execute');
    const outcomes = Promise.allSettled([running, queued]);
    const controlled = await owner.takeControl('task', 1, true);
    assert.equal(controlled.owner, 'owner');
    engine.gate = null; release();
    assert.deepEqual((await outcomes).map(result => result.status), ['rejected', 'rejected']);
    assert.equal(engine.operations.filter(op => op.operation === 'write').length, 0);
    await owner.exec('task', 2, 'new');
    const ids = engine.operations.filter(op => op.operation === 'exec').map(op => op.container);
    assert.notEqual(ids[0], ids[1]);
    assert.equal(broker.snapshot('task').lease.owner, 'owner');
  });

  it('does not call an unverified stop exclusive and blocks cleanup until reconciliation', async () => {
    await broker.create('task'); engine.stopFault = true;
    const lease = await broker.owner().takeControl('task', 1, true);
    assert.equal(lease.owner, 'uncertain'); assert.equal(broker.snapshot('task').state, 'uncertain');
    assert.equal(engine.counter, 1);
    await assert.rejects(async () => broker.owner().exec('task', lease.epoch, 'denied'), errorCode('control-unavailable'));
    await assert.rejects(broker.owner().destroy('task', lease.epoch), errorCode('active-environment'));
    await assert.rejects(broker.owner().archive('task', lease.epoch), errorCode('active-environment'));
    engine.stopFault = false;
    assert.equal((await broker.owner().takeControl('task', lease.epoch, true)).owner, 'owner');
  });

  it('makes lost mutation acknowledgement uncertain; start failure cannot be ready', async () => {
    await broker.create('task'); engine.toolFault = true;
    await assert.rejects(broker.agent().exec('task', 1, 'effect'), error => error instanceof EnvironmentError && error.effectState === 'uncertain');
    assert.equal(broker.snapshot('task').lease.owner, 'uncertain');
    engine.toolFault = false; engine.startFault = true;
    const reset = await broker.owner().takeControl('task', broker.snapshot('task').lease.epoch, true);
    assert.equal(reset.owner, 'uncertain'); assert.equal(broker.views().every(view => !view.available), true);
  });

  it('rejects stale lease, cross-task/view/environment and reconnected generations', async () => {
    await broker.create('task'); await broker.create('second');
    const agent = broker.agent(); const old = input();
    await agent.input(old);
    const frame = await broker.frame('task', old.viewId);
    assert.equal(frame.identity.leaseEpoch, 1);
    await assert.rejects(async () => agent.input({ ...old, taskId: 'second' }), errorCode('stale-view'));
    await assert.rejects(async () => agent.input({ ...old, environmentId: 'forged' }), errorCode('stale-view'));
    await assert.rejects(async () => agent.input({ ...old, leaseEpoch: 0 }), errorCode('stale-epoch'));
    broker.reconnect('task');
    await assert.rejects(async () => agent.input(old), errorCode('stale-view'));
    await agent.input(input());
    assert.equal((await broker.frame('task', old.viewId)).identity.sequence, 2);
  });

  it('rejects reconnected queued input and cannot rewrite its queued identity', async () => {
    await broker.create('task');
    let release!: () => void; engine.gate = new Promise<void>(accept => { release = accept; });
    const running = broker.agent().exec('task', 1, 'blocking');
    await new Promise(resolve => setImmediate(resolve));
    const request = input();
    const queued = broker.agent().input(request);
    const settled = Promise.allSettled([running, queued]);
    broker.reconnect('task'); request.generation = broker.snapshot('task').views[0]!.generation;
    engine.gate = null; release();
    assert.deepEqual((await settled).map(result => result.status), ['fulfilled', 'rejected']);
    assert.equal(engine.operations.filter(operation => operation.operation === 'input').length, 0);
    assert.equal(broker.snapshot('task').lease.owner, 'agent');
  });

  it('rechecks current authority inside every queued mutation without poisoning a never-admitted environment', async () => {
    await broker.create('task');
    let allowed = true; const guarded = broker.agent(taskId => { assert.equal(taskId, 'task'); if (!allowed) throw new Error('authority revoked'); });
    let release!: () => void; engine.gate = new Promise<void>(accept => { release = accept; });
    const running = guarded.exec('task', 1, 'blocking');
    await new Promise(resolve => setImmediate(resolve));
    const write = guarded.write('task', 1, 'blocked.txt', 'no');
    const desktop = guarded.input(input());
    const results = Promise.allSettled([running, write, desktop]);
    allowed = false; engine.gate = null; release();
    const outcomes = await results;
    assert.deepEqual(outcomes.map(result => result.status), ['rejected', 'rejected', 'rejected']);
    assert.deepEqual(outcomes.map(result => result.status === 'rejected' && result.reason instanceof EnvironmentError ? result.reason.effectState : 'invalid'), ['uncertain', 'not-sent', 'not-sent']);
    assert.equal(engine.operations.filter(operation => ['write', 'input'].includes(operation.operation)).length, 0);
    assert.equal(broker.snapshot('task').lease.owner, 'agent');
    allowed = true;
    await guarded.write('task', 1, 'allowed.txt', 'yes');
    assert.equal((await guarded.read('task', 'allowed.txt')).toString(), 'yes');
  });

  it('withholds read and frame data when authority changes during an awaited capture', async () => {
    await broker.create('task'); await broker.agent().write('task', 1, 'private.txt', 'data');
    for (const kind of ['read', 'frame']) {
      let allowed = true; const guard = () => { if (!allowed) throw new Error('authority revoked'); };
      let release!: () => void; engine.gate = new Promise<void>(accept => { release = accept; });
      const operation = kind === 'read' ? broker.agent(guard).read('task', 'private.txt') : broker.frame('task', broker.views()[0]!.id, guard);
      const failure = assert.rejects(operation, /authority revoked/);
      await new Promise(resolve => setImmediate(resolve)); allowed = false; engine.gate = null; release();
      await failure;
    }
    assert.equal(broker.snapshot('task').state, 'running');
  });

  it('preserves durable files, and protects active or uncertain work from cleanup', async () => {
    await broker.create('task'); await broker.agent().write('task', 1, 'notes.txt', 'retained');
    await assert.rejects(broker.owner().archive('task', 1), errorCode('active-environment'));
    await broker.owner().takeControl('task', 1, true);
    assert.equal((await broker.owner().read('task', 'notes.txt')).toString(), 'retained');
    const stop = await broker.owner().stop('task', 2, true);
    assert.equal(broker.snapshot('task').state, 'stopped');
    await broker.owner().archive('task', stop.epoch);
    assert.equal(broker.snapshot('task').state, 'archived');
    await broker.owner().destroy('task', stop.epoch);
    assert.equal(broker.snapshots().length, 0);
    await assert.rejects(broker.create('task'), errorCode('environment-destroyed'));
    broker.close(); broker = new EnvironmentBroker(directory, engine);
    await assert.rejects(broker.create('task'), errorCode('environment-destroyed'));
  });

  it('offers full exports only to owner, preserves bytes, and refuses destruction without an archive', async () => {
    await broker.create('task');
    assert.equal('exportArchive' in broker.agent(), false);
    await assert.rejects(broker.owner().exportArchive('task', 1), errorCode('active-environment'));
    const bytes = Buffer.from([0, 255, 0, 10, 128]);
    await broker.agent().write('task', 1, 'saved/code.bin', bytes);
    await broker.agent().write('task', 1, 'empty', Buffer.alloc(0));
    const lease = await broker.owner().stop('task', 1, true);
    await assert.rejects(broker.owner().exportArchive('task', 1), errorCode('stale-epoch'));
    await assert.rejects(broker.owner().exportArchive('unknown', lease.epoch), errorCode('environment-missing'));
    await assert.rejects(broker.owner().destroy('task', lease.epoch), errorCode('archive-required'));
    const exported = await broker.owner().exportArchive('task', lease.epoch);
    assert.deepEqual(Object.keys(exported).sort(), ['environmentId', 'epoch', 'files', 'rawArchive', 'taskId']);
    assert.deepEqual(await streamBytes(exported.files[0]!.open()), bytes);
    assert.equal(exported.files[0]!.sha256, createHash('sha256').update(bytes).digest('hex'));
    assert.equal((await streamBytes(exported.files[1]!.open())).length, 0);
    const raw = await streamBytes(exported.rawArchive.open());
    assert.equal(createHash('sha256').update(raw).digest('hex'), exported.rawArchive.sha256);
    await broker.owner().archive('task', lease.epoch);
    await broker.owner().destroy('task', lease.epoch);
    assert.throws(() => exported.rawArchive.open(), errorCode('environment-missing'));
  });

  it('rejects links, paths, special files, duplicates, malformed/truncated tar and never removes workspace', async () => {
    await broker.create('task'); const lease = await broker.owner().stop('task', 1, true);
    const invalid = [
      tar([{ path: '../host' }]), tar([{ path: '/etc/passwd' }]), tar([{ path: 'a\\b' }]),
      ...['1', '2', '3', '4', '6'].map(type => tar([{ path: 'bad', type }])),
      tar([{ path: 'a' }, { path: 'a' }]), tar([{ path: 'a' }, { path: 'a/child' }]),
      tar([{ path: 'good' }]).subarray(0, 512), Buffer.from('not a tar'),
      Buffer.concat([tar([{ path: 'good' }]), Buffer.from('hidden trailing bytes')])
    ];
    for (const archive of invalid) {
      engine.archiveOverride = archive;
      await assert.rejects(broker.owner().exportArchive('task', lease.epoch), errorCode('archive-invalid'));
      await assert.rejects(broker.owner().destroy('task', lease.epoch), errorCode('archive-required'));
    }
    assert.equal(engine.operations.some(operation => ['remove', 'removeVolume'].includes(operation.operation)), false);
    assert.equal(broker.snapshot('task').state, 'stopped');
  });

  it('refuses uncertain, still-queued, and generation-stale exports; preserves failed pending capture', async () => {
    await broker.create('task');
    let release!: () => void; engine.gate = new Promise<void>(accept => { release = accept; });
    const running = broker.agent().exec('task', 1, 'blocking'); const outcome = Promise.allSettled([running]);
    await new Promise(resolve => setImmediate(resolve));
    const lease = await broker.owner().stop('task', 1, true);
    await assert.rejects(broker.owner().exportArchive('task', lease.epoch), errorCode('active-environment'));
    engine.gate = null; release(); await outcome;
    engine.captureGate = new Promise<void>(accept => { release = accept; });
    const capture = broker.owner().exportArchive('task', lease.epoch); const failure = assert.rejects(capture, errorCode('stale-export'));
    await new Promise(resolve => setImmediate(resolve)); broker.reconnect('task'); engine.captureGate = null; release(); await failure;
    engine.exportFault = true;
    await assert.rejects(broker.owner().exportArchive('task', lease.epoch), /interrupted/);
    assert.equal(engine.operations.some(operation => operation.operation === 'removeVolume'), false);
    const captures = readdirSync(join(directory, 'archives'));
    assert.ok(captures.some(path => readdirSync(join(directory, 'archives', path)).includes('workspace.pending.tar')));
    engine.exportFault = false; engine.stopFault = true;
    const uncertain = await broker.owner().takeControl('task', lease.epoch, true);
    await assert.rejects(broker.owner().exportArchive('task', uncertain.epoch), errorCode('active-environment'));
  });

  it('reverifies durable archive before destruction and rejects damaged bytes', async () => {
    await broker.create('task'); const lease = await broker.owner().stop('task', 1, true);
    await broker.owner().archive('task', lease.epoch);
    const capture = readdirSync(join(directory, 'archives'))[0]!;
    writeFileSync(join(directory, 'archives', capture, 'workspace.tar'), 'broken');
    await assert.rejects(broker.owner().destroy('task', lease.epoch), errorCode('archive-invalid'));
    assert.equal(engine.operations.some(operation => ['remove', 'removeVolume'].includes(operation.operation)), false);
  });

  it('refuses host paths and task IDs cannot choose container or host paths', async () => {
    await broker.create('../../host');
    const agent = broker.agent();
    for (const path of ['/etc/passwd', '../secret', 'sub/../secret', './file', '', 'a//b', 'a\0b']) {
      await assert.rejects(async () => agent.read('../../host', path), errorCode('invalid-workspace-path'));
      await assert.rejects(async () => agent.write('../../host', 1, path, 'data'), errorCode('invalid-workspace-path'));
    }
    assert.match(broker.snapshot('../../host').environmentId, /^[a-f0-9-]{36}$/);
    assert.equal(engine.operations.length, 0);
  });

  it('recovers running work as uncertain with bumped epoch/generation and excludes another broker', async () => {
    await broker.create('task');
    assert.throws(() => new EnvironmentBroker(directory, engine), errorCode('broker-locked'));
    broker.close(); broker = new EnvironmentBroker(directory, engine);
    assert.equal(broker.snapshot('task').lease.owner, 'uncertain');
    assert.equal(broker.snapshot('task').lease.epoch, 2);
    assert.equal(broker.snapshot('task').views[0]?.generation, 2);
    assert.equal((await broker.owner().takeControl('task', 2, true)).owner, 'owner');
  });

  it('history-only proof requires an actual verifier, rejects missing/active/queued environments and exports no controls to agents', async () => {
    assert.equal('withInactive' in broker.agent(), false); assert.equal('withInactive' in broker.owner(), false);
    await assert.rejects(broker.withInactive([{ taskId: 'missing', epoch: 1 }], () => assert.fail('missing cannot commit')), errorCode('environment-missing'));
    await broker.create('task');
    await assert.rejects(broker.withInactive([{ taskId: 'task', epoch: 1 }], () => assert.fail('active cannot commit')), errorCode('active-environment'));
    const lease = await broker.owner().stop('task', 1, true);
    await assert.rejects(broker.withInactive([{ taskId: 'task', epoch: lease.epoch }], () => assert.fail('cached stop is not proof')), errorCode('verification-unavailable'));
    assert.equal(broker.snapshot('task').state, 'stopped');
    assert.deepEqual(engine.operations.map(item => item.operation), ['stop']);
  });

  it('holds all task identities through engine verification, rejects promises and releases every fence after refusal', async () => {
    await broker.create('first'); await broker.create('second');
    await broker.owner().stop('first', 1, true); await broker.owner().stop('second', 1, true);
    let release!: () => void, calls = 0;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const verifier: EnvironmentEngine = engine;
    verifier.verifyWorkspace = async () => { calls++; await gate; };
    const operation = broker.withInactive([{ taskId: 'first', epoch: 2 }, { taskId: 'second', epoch: 2 }], assertCurrent => { assertCurrent(); return 'committed'; });
    while (!calls) await new Promise(resolve => setImmediate(resolve));
    await assert.rejects(broker.owner().resume('second', 2, true), errorCode('control-unavailable'));
    release(); assert.equal(await operation, 'committed'); assert.equal(calls, 2);
    await assert.rejects(broker.withInactive([{ taskId: 'first', epoch: 2 }], () => Promise.resolve('not synchronous')), errorCode('invalid-callback'));
    assert.equal((await broker.owner().resume('first', 2, true)).owner, 'agent');
  });

  it('fences simultaneous transitions and explicitly discloses destructive resume', async () => {
    await broker.create('task');
    const owner = broker.owner(); const first = owner.takeControl('task', 1, true);
    await assert.rejects(owner.takeControl('task', 1, true), errorCode('stale-epoch'));
    await first;
    const request = await owner.resume('task', 2);
    assert.match(request.detail, /loses unsaved/); assert.equal(engine.counter, 2);
  });
});
