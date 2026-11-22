import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PairingAuthority } from '../src/auth.js';
import { parseHostConfig, prepareHostRoot } from '../src/config.js';
import { EnvironmentBroker, type EnvironmentEngine } from '../src/environment-broker.js';
import { authenticateHostOwner, bindTaskEnvironment, nativeEvidenceRecorder, resolveExecutionScope, startHost, verifyRuntimeAuthentication } from '../src/main.js';
import { WorkspaceStore } from '../src/store.js';
import { OpenAiSpeechService } from '../src/speech.js';
import type { RuntimeProfile } from '../src/runtime-adapters.js';
import type { Snapshot } from '../src/protocol.js';
import type { NativeEvidence } from '../src/server.js';

function temporary() { return mkdtempSync(join(tmpdir(), 'spatial-main-')); }
function fakeEngine(): EnvironmentEngine {
  return { async readiness() { return { id: 'fixture', state: 'ready', detail: 'fixture engine, not Docker proof' }; }, async create() { return 'fixture-container'; }, async start() {}, async stopAndVerify() {}, async remove() {}, async removeVolume() {}, async tool(_environment, operation) { if (operation === 'read') return { contentBase64: Buffer.from('fixture').toString('base64') }; if (operation === 'exec') return { output: 'fixture', exitCode: 0 }; return {}; } };
}
test('actual assembly boots empty owner setup on real HTTP/HTTPS, no grants or providers, stable lease across restart', async () => {
  const root = temporary(), config = parseHostConfig({ nativePort: 0, consolePort: 0 }, root);
  const original = process.env.AGENTSYS_STATE; process.env.AGENTSYS_STATE = '/fixture-forbidden-ambient-state';
  let host: Awaited<ReturnType<typeof startHost>> | undefined;
  try {
    host = await startHost(config);
    const base = `http://127.0.0.1:${host.ports.consolePort}`;
    const setup = await fetch(base + '/setup'); assert.equal(setup.status, 200);
    const body = await setup.json() as { pairing: { code: string }; fingerprint: string };
    assert.ok(body.pairing.code); assert.match(body.fingerprint, /^[a-f0-9]{64}$/);
    const snapshot = await (await fetch(base + '/v1/snapshot')).json() as Snapshot;
    assert.deepEqual(snapshot.projects, []); assert.deepEqual(snapshot.tasks, []); assert.deepEqual(snapshot.inbox, []);
    assert.equal(snapshot.readiness.find(item => item.id === 'execution')?.state, 'blocked');
    assert.equal(snapshot.readiness.find(item => item.id === 'history-archive')?.state, 'blocked');
    assert.equal(snapshot.readiness.find(item => item.id === 'speech')?.state, 'blocked');
    assert.equal(process.env.AGENTSYS_STATE, '/fixture-forbidden-ambient-state');
    await assert.rejects(() => startHost(config), /lease/);
    const inode = statSync(join(root, 'host.lock')).ino;
    for (const path of ['workspace.sqlite', 'host.lock', 'auth/clients.json', 'tls/host-key.pem', 'tls/host-cert.pem']) assert.equal(statSync(join(root, path)).mode & 0o077, 0, path);
    await host.close(); await host.close(); host = await startHost(config);
    assert.equal(statSync(join(root, 'host.lock')).ino, inode);
    assert.deepEqual(host.store.snapshot().projects, []);
  } finally { await host?.close(); if (original === undefined) delete process.env.AGENTSYS_STATE; else process.env.AGENTSYS_STATE = original; rmSync(root, { recursive: true, force: true }); }
});
test('shutdown drains an actual in-flight HTTP component before closing SQLite and releasing ownership', async () => {
  const root = temporary(), host = await startHost(parseHostConfig({ nativePort: 0, consolePort: 0 }, root));
  let ready!: () => void, complete!: () => void, closed = false;
  const started = new Promise<void>(resolve => { ready = resolve; }), held = new Promise<void>(resolve => { complete = resolve; });
  // Explicit readiness fixture only; no Docker/provider operation is issued.
  host.broker.readiness = async () => { ready(); await held; return { id: 'fixture-readiness', state: 'blocked', detail: 'fixture, not environment acceptance' }; };
  try {
    const response = fetch(`http://127.0.0.1:${host.ports.consolePort}/v1/snapshot`); await started;
    const closing = host.close().then(() => { closed = true; });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(closed, false); assert.deepEqual(host.store.snapshot().projects, []);
    complete(); assert.equal((await response).status, 200); await closing; assert.equal(closed, true);
    assert.throws(() => host.store.snapshot());
  } finally { complete(); await host.close(); rmSync(root, { recursive: true, force: true }); }
});
test('missing explicitly configured activation stays a setup blocker without touching selected state', async () => {
  const root = temporary();
  const config = parseHostConfig({ nativePort: 0, consolePort: 0, coordinator: { buildDirectory: '/missing/build', stateRoot: '/missing/state', operator: 'fixture-owner', activationEvidence: join(root, 'missing.json') }, profiles: [{ runtime: 'pi-local', bin: '/missing/pi', configDirectory: join(root, 'runtime/login'), dataDirectory: join(root, 'runtime/history'), scriptDirectory: '/missing/scripts', models: [{ id: 'fixture/model', efforts: ['high'] }], subscriptionId: 'fixture' }] }, root);
  const host = await startHost(config);
  try {
    const snapshot = await (await fetch(`http://127.0.0.1:${host.ports.consolePort}/v1/snapshot`)).json() as Snapshot;
    assert.equal(snapshot.readiness.find(item => item.id === 'execution')?.state, 'blocked');
    assert.match(snapshot.readiness.find(item => item.id === 'execution')!.detail, /could not verify/);
    assert.deepEqual(snapshot.tasks, []);
  } finally { await host.close(); rmSync(root, { recursive: true, force: true }); }
});
for (const profiles of [false, true]) test(`archive reader composes without inference ${profiles ? 'reader module/account authentication' : 'profiles'}; execution stays blocked`, async () => {
  const root = temporary(); prepareHostRoot(root);
  const state = temporary(), build = join(root, 'fixture-build'), evidence = join(root, 'activation');
  for (const directory of [build, evidence]) mkdirSync(directory, { mode: 0o700 });
  const digest = 'a'.repeat(64), operator = 'fixture-owner', mergedPr = 'https://fixture.invalid/pull/1';
  writeFileSync(join(build, 'build-identity.json'), JSON.stringify({ digest }), { mode: 0o600 });
  // Activation/lookup stub ONLY for composition. Actual coordinator cutoff behavior is proved in lifecycle.test.ts.
  writeFileSync(join(build, 'commands.js'), `export function adapterFor(){throw Error('No provider allowed');}
    export function createCoordinatorCommands(){return {configuredOperator:()=>${JSON.stringify(operator)},
      version:()=>({active:{coordinator:${JSON.stringify(digest)},activatedBy:${JSON.stringify(operator)},mergedPr:${JSON.stringify(mergedPr)}}}),
      authorityPreviewForOperator(){throw Error('No authority operation allowed');},authorityConfirmationRecord(){throw Error('No authority operation allowed');},
      interactiveLookup(){},interactiveArchiveLookup(){},interactiveArchive(){throw Error('Composition fixture never archives');},interactiveArchiveReconcile(){throw Error('Composition fixture never archives');}}}`, { mode: 0o600 });
  const files = ['writerInventory', 'quiescenceEvidence', 'backupEvidence'];
  const records = Object.fromEntries(files.map(name => { const path = join(evidence, name); writeFileSync(path, 'Disposable fixture proof', { mode: 0o600 }); return [name, path]; }));
  const activationEvidence = join(evidence, 'approved.json');
  writeFileSync(activationEvidence, JSON.stringify({ stateRoot: state, buildDigest: digest, operator, approvedAt: new Date().toISOString(), mergedPr, ...records }), { mode: 0o600 });
  const config = parseHostConfig({ nativePort: 0, consolePort: 0, coordinator: { stateRoot: state, buildDirectory: build, operator, activationEvidence },
    profiles: profiles ? [{ runtime: 'pi-local', bin: '/missing/pi', configDirectory: join(root, 'runtime/login'), dataDirectory: join(root, 'runtime/history'), scriptDirectory: '/missing/scripts', models: [{ id: 'fixture/model', efforts: ['high'] }], subscriptionId: 'fixture' }] : [],
  }, root);
  const previous = process.env.AGENTSYS_STATE; delete process.env.AGENTSYS_STATE;
  let host: Awaited<ReturnType<typeof startHost>> | undefined;
  try {
    host = await startHost(config);
    const project = host.store.createProject({ name: 'Retained zero-run family', purpose: 'Composition fixture' }), space = host.store.getSpace(project.rootSpaceId);
    const submission = host.store.submitTurn('composition-history', { spaceId: space.id, conversationId: space.conversationId, taskId: null }, 'Never executed');
    host.store.updateSubmission(submission.id, { state: 'blocked' }); host.store.updateMessage(submission.messageId, { state: 'failed' });
    const base = `http://127.0.0.1:${host.ports.consolePort}`;
    const snapshot = await (await fetch(base + '/v1/snapshot')).json() as Snapshot;
    assert.equal(snapshot.readiness.find(item => item.id === 'execution')?.state, 'blocked');
    assert.equal(snapshot.readiness.find(item => item.id === 'history-archive')?.state, 'ready');
    const response = await fetch(base + `/v1/spaces/${space.id}/sources`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Allowed local source', text: 'Verified cutoff absence, no inference', provenance: 'Fixture' }) });
    assert.equal(response.status, 201);
  } finally { await host?.close(); if (previous === undefined) delete process.env.AGENTSYS_STATE; else process.env.AGENTSYS_STATE = previous; rmSync(root, { recursive: true, force: true }); rmSync(state, { recursive: true, force: true }); }
});

test('paired identity derives only configured operator; revocation and forged owner identities cannot become operator', () => {
  const root = temporary();
  try {
    const auth = new PairingAuthority(join(root, 'auth')), paired = auth.pair(auth.setupCode().code, 'fixture-owner');
    const owner = { clientId: paired.clientId, surface: 'native' as const };
    assert.deepEqual(authenticateHostOwner(auth, () => 'configured-owner', 'configured-owner', owner), { kind: 'operator', id: 'configured-owner' });
    assert.throws(() => authenticateHostOwner(auth, () => 'other-account', 'configured-owner', owner));
    assert.throws(() => authenticateHostOwner(auth, () => 'configured-owner', 'configured-owner', { clientId: 'configured-owner', surface: 'console' }));
    auth.revoke(owner.clientId); assert.throws(() => authenticateHostOwner(auth, () => 'configured-owner', 'configured-owner', owner), /paired/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('fixed run creates real broker binding after admission and fences reads/queued mutations on owner takeover', async () => {
  const root = temporary(); prepareHostRoot(root);
  const store = new WorkspaceStore(join(root, 'workspace.sqlite')), broker = new EnvironmentBroker(join(root, 'environments'), fakeEngine());
  try {
    const project = store.createProject({ name: 'fixture', purpose: 'isolated test data' });
    const task = store.createTask({ idempotencyKey: 'fixture-task', spaceId: project.rootSpaceId, title: 'fixture', prompt: 'fixture', runtime: 'pi-local', model: 'fixture/model', effort: 'high' });
    const submission = store.getSubmissionByKey('fixture-task')!;
    let admitted = false;
    const bridge = { assertTaskToolAllowed(id: string, runId: string) { assert.equal(id, submission.id); assert.equal(runId, 'fixture-run'); if (!admitted) throw new Error('not admitted'); } };
    await assert.rejects(() => bindTaskEnvironment(store, broker, bridge, submission, 'fixture-run'), /not admitted/); assert.deepEqual(broker.snapshots(), []);
    assert.equal(await bindTaskEnvironment(store, broker, bridge, { ...submission, receiver: { ...submission.receiver, taskId: null } }, 'fixture-run'), null);
    admitted = true;
    const bound = (await bindTaskEnvironment(store, broker, bridge, submission, 'fixture-run'))!;
    assert.equal(store.getTask(task.id).environmentId, broker.snapshot(task.id).environmentId);
    assert.equal((await bound.tools.read(task.id, 'fixture.txt')).toString(), 'fixture');
    await assert.rejects(() => bound.tools.read('other-task', 'fixture.txt'));
    const first = bound.tools.exec(task.id, bound.epoch, 'fixture');
    const queued = bound.tools.exec(task.id, bound.epoch, 'fixture');
    const takeover = broker.owner().takeControl(task.id, bound.epoch, true);
    const results = await Promise.allSettled([first, queued]); assert.ok(results.every(result => result.status === 'rejected')); await takeover;
    await assert.rejects(() => bound.tools.read(task.id, 'fixture.txt'), /lease/);
    assert.throws(() => bound.identity('browser'), /lease/);
  } finally { broker.close(); store.close(); rmSync(root, { recursive: true, force: true }); }
});
test('scope registrations bind project, receiver kind and runtime, never source/model-selected authority', () => {
  const root = temporary(), store = new WorkspaceStore(join(root, 'workspace.sqlite'));
  try {
    const project = store.createProject({ name: 'fixture', purpose: 'test' });
    store.createTask({ idempotencyKey: 'scope-fixture', spaceId: project.rootSpaceId, title: 'fixture', prompt: 'fixture', runtime: 'pi-local', model: 'fixture/model', effort: 'high' });
    const submission = store.getSubmissionByKey('scope-fixture')!;
    const base = { coordinator: { buildDirectory: '/explicit/dist', stateRoot: '/explicit/state', operator: 'fixture-owner', activationEvidence: join(root, 'evidence/activation.json') }, profiles: [{ runtime: 'pi-local', bin: '/explicit/pi', configDirectory: join(root, 'runtime/login'), dataDirectory: join(root, 'runtime/history'), scriptDirectory: '/explicit/scripts', models: [{ id: 'fixture/model', efforts: ['high'] }], subscriptionId: 'fixture' }] };
    const scope = { repo: 'fixture/repo', workClass: 'interactive', profile: 'offline', actions: ['conversation', 'task-tools'], estimate: { basis: 'operator-bound', detail: 'fixture', fiveHourPercent: 1, weeklyPercent: 1, uncertaintyPercent: 0 }, timeoutMs: 30000 };
    const config = parseHostConfig({ ...base, scopes: [{ projectId: project.id, spaceId: project.rootSpaceId, receiver: 'task', runtime: 'pi-local', scope }] }, root);
    assert.deepEqual(resolveExecutionScope(config, store, submission), scope);
    const selected = resolveExecutionScope(config, store, submission)!; selected.actions.push('delegate-task'); assert.equal(config.scopes[0]?.scope.actions.includes('delegate-task'), false);
    assert.equal(resolveExecutionScope(config, store, { ...submission, runtime: 'claude-local' }), null);
    config.scopes[0]!.projectId = 'different-project'; assert.equal(resolveExecutionScope(config, store, submission), null);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});
test('native telemetry retains only bounded typed fields, rotates and rejects revoked owner or invalid measurements', async () => {
  const root = temporary(); prepareHostRoot(root);
  let permitted = true;
  const recorder = nativeEvidenceRecorder(root, 16384, () => { if (!permitted) throw new Error('revoked'); });
  const owner = { clientId: 'fixture-client', surface: 'native' as const };
  const evidence: NativeEvidence & { secret: string } = { sessionId: 'fixture-session', unity: '6000.0.32f1', mode: 'VR', frameCount: 100, unscaledFrameSeconds: 10, spaceId: 'overview', taskId: null, viewId: null, microphoneEnabled: false, captureAllowed: false, metrics: { timingAvailable: false, samples: 0, cpuP95Ms: 0, gpuP95Ms: 0, allocatedBytes: 0 }, secret: 'fixture-do-not-log' };
  try {
    for (let index = 0; index < 100; index++) await recorder.record(evidence, owner);
    for (const name of ['native.jsonl', 'native.jsonl.1', 'native.jsonl.2']) {
      const path = join(root, 'evidence', name); assert.ok(statSync(path).size <= 16384); assert.equal(statSync(path).mode & 0o077, 0);
      const text = readFileSync(path, 'utf8'); assert.equal(text.includes(evidence.secret), false); assert.equal(text.includes('audio'), false);
      for (const line of text.trim().split('\n')) assert.equal((JSON.parse(line) as NativeEvidence).metrics.timingAvailable, false);
    }
    await assert.rejects(() => recorder.record({ ...evidence, frameCount: -1 }, owner));
    permitted = false; await assert.rejects(() => recorder.record(evidence, owner), /revoked/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('runtime identity proof uses actual local auth command shape and current legitimate-reader identity, never directories/flags', async () => {
  const root = temporary(), bin = join(root, 'fixture-claude.mjs'), configDirectory = join(root, 'login'); mkdirSync(configDirectory, { mode: 0o700 });
  const account = { runtime: 'claude-local' as const, email: 'fixture@example.invalid', orgId: 'fixture-org' };
  const profile: RuntimeProfile = { runtime: 'claude-local', bin, configDirectory, dataDirectory: join(root, 'history'), scriptDirectory: root, models: [{ id: 'fixture', efforts: ['high'] }], subscriptionId: 'claude-max' };
  const status = { loggedIn: true, authMethod: 'oauth', apiProvider: 'firstParty', orgId: account.orgId, email: account.email, subscriptionType: 'max' };
  const reader = async () => ({ id: account.orgId, plan: 'max' });
  const write = (value: unknown) => writeFileSync(bin, '#!/usr/bin/env node\nif(process.argv.slice(2).join(" ")!=="auth status")process.exit(2);process.stdout.write(' + JSON.stringify(JSON.stringify(value)) + ');', { mode: 0o700 });
  const overrides = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_CUSTOM_HEADERS', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX'];
  const previous = new Map(overrides.map(key => [key, process.env[key]])); for (const key of overrides) delete process.env[key];
  try {
    write(status); assert.equal(await verifyRuntimeAuthentication(profile, account, reader, bin), true);
    assert.equal(await verifyRuntimeAuthentication(profile, undefined, reader, bin), false);
    assert.equal(await verifyRuntimeAuthentication(profile, { ...account, email: 'different@example.invalid' }, reader, bin), false);
    assert.equal(await verifyRuntimeAuthentication(profile, account, async () => ({ id: 'other-org', plan: 'max' }), bin), false);
    assert.equal(await verifyRuntimeAuthentication({ ...profile, runtime: 'pi-local' }, account, reader, bin), false);
    process.env.ANTHROPIC_BASE_URL = 'https://fixture.invalid'; assert.equal(await verifyRuntimeAuthentication(profile, account, reader, bin), false); delete process.env.ANTHROPIC_BASE_URL;
    write({ ...status, loggedIn: false }); assert.equal(await verifyRuntimeAuthentication(profile, account, reader, bin), false);
    write({ ...status, email: undefined }); assert.equal(await verifyRuntimeAuthentication(profile, account, reader, bin), false);
  } finally { for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } rmSync(root, { recursive: true, force: true }); }
});
test('missing speech journal never implies permission to initialize it or prevents owner setup', async () => {
  const root = temporary(); prepareHostRoot(root); const path = join(root, 'speech-options.json'); writeFileSync(path, '{}', { mode: 0o600 });
  const host = await startHost(parseHostConfig({ nativePort: 0, consolePort: 0, speechConfig: path }, root));
  try {
    const snapshot = await (await fetch(`http://127.0.0.1:${host.ports.consolePort}/v1/snapshot`)).json() as Snapshot;
    assert.equal(snapshot.readiness.find(item => item.id === 'speech')?.state, 'blocked');
    assert.equal(existsSync(join(root, 'speech.sqlite')), false); assert.equal(existsSync(join(root, 'speech.sqlite.identity')), false);
  } finally { await host.close(); rmSync(root, { recursive: true, force: true }); }
});
test('optional real speech module with missing paid caps/key stays BLOCKED and closes its private journal', async () => {
  const root = temporary(); prepareHostRoot(root); const path = join(root, 'speech-options.json'); writeFileSync(path, '{}', { mode: 0o600 });
  // Explicit trusted fixture provisioning, equivalent to the one-time owner CLI.
  const provisioned = new OpenAiSpeechService({ journalPath: join(root, 'speech.sqlite'), initializeJournal: true }); await provisioned.close();
  const host = await startHost(parseHostConfig({ nativePort: 0, consolePort: 0, speechConfig: path }, root));
  try {
    const snapshot = await (await fetch(`http://127.0.0.1:${host.ports.consolePort}/v1/snapshot`)).json() as Snapshot;
    assert.equal(snapshot.readiness.find(item => item.id === 'speech-budget')?.state, 'blocked');
    assert.equal(statSync(join(root, 'speech.sqlite')).mode & 0o077, 0);
  } finally { await host.close(); rmSync(root, { recursive: true, force: true }); }
});
