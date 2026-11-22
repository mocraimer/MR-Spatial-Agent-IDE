import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertPrivatePath, DEFAULT_HOST_ROOT, loadHostConfig, loadSpeechOptions, parseHostConfig, prepareHostRoot } from '../src/config.js';

function temporary() { return mkdtempSync(join(tmpdir(), 'spatial-config-')); }
function configured(root: string) {
  return { coordinator: { buildDirectory: '/explicit/coordinator/dist', stateRoot: '/explicit/separate/coordinator-state', operator: 'fixture-owner', activationEvidence: join(root, 'evidence/activation.json') }, profiles: [{ runtime: 'pi-local', bin: '/explicit/pi', configDirectory: join(root, 'runtime/pi/login'), dataDirectory: join(root, 'runtime/pi/history'), scriptDirectory: '/explicit/product/scripts', models: [{ id: 'provider/exact', efforts: ['high'] }], subscriptionId: 'fixture-account' }], scopes: [{ projectId: 'fixture-project', spaceId: 'fixture-space', receiver: 'task', runtime: 'pi-local', scope: { repo: 'fixture/repo', workClass: 'interactive', profile: 'offline-tools', actions: ['conversation', 'task-tools'], estimate: { basis: 'operator-bound', detail: 'fixture only', fiveHourPercent: 1, weeklyPercent: 1, uncertaintyPercent: 0 }, timeoutMs: 30000 } }] };
}
test('defaults are stable, loopback, empty and independent of ambient model/coordinator settings', () => {
  const config = loadHostConfig({ AGENTSYS_STATE: '/live/main.state', OPENAI_API_KEY: 'fixture-do-not-copy', PI_CODING_AGENT_DIR: '/harness/login' });
  assert.equal(config.root, DEFAULT_HOST_ROOT); assert.equal(config.nativePort, 47843); assert.equal(config.consolePort, 47844); assert.equal(config.nativeHost, '127.0.0.1');
  assert.equal(config.coordinator, null); assert.deepEqual(config.profiles, []); assert.deepEqual(config.scopes, []); assert.equal(config.speechConfig, null); assert.equal(config.telemetry.enabled, false);
  assert.equal(JSON.stringify(config).includes('fixture-do-not-copy'), false);
});
test('owner config keeps explicit models, scopes and app-private profiles; no fallback account or state', () => {
  const root = temporary();
  try {
    const source = configured(root), config = parseHostConfig(source, root);
    assert.deepEqual(config.scopes[0]?.scope, source.scopes[0]?.scope); assert.equal(config.profiles[0]?.models[0]?.id, 'provider/exact');
    assert.throws(() => parseHostConfig({ ...source, coordinator: { ...source.coordinator, stateRoot: undefined } }, root));
    assert.throws(() => parseHostConfig({ ...source, coordinator: { ...source.coordinator, activated: true } }, root));
    assert.throws(() => parseHostConfig({ ...source, runtimeAccounts: [{ runtime: 'pi-local', orgId: 'fixture', email: 'fixture@example.invalid' }] }, root));
    assert.throws(() => parseHostConfig({ profiles: source.profiles }, root));
    assert.throws(() => parseHostConfig({ ...source, profiles: [{ ...source.profiles[0], configDirectory: '/harness/profile' }] }, root));
    assert.throws(() => parseHostConfig({ ...source, profiles: [{ ...source.profiles[0], configDirectory: join(root, 'auth/cli') }] }, root));
    assert.throws(() => parseHostConfig({ ...source, profiles: [{ ...source.profiles[0], runtimeAuthentication: true }] }, root));
    assert.throws(() => parseHostConfig({ ...source, scopes: [{ ...source.scopes[0], scope: { ...source.scopes[0]!.scope, actions: ['conversation', 'host-shell'] } }] }, root));
    assert.throws(() => parseHostConfig({ ...source, scopes: [{ ...source.scopes[0], receiver: 'space' }] }, root));
    assert.throws(() => parseHostConfig({ ...source, scopes: [source.scopes[0], source.scopes[0]] }, root));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('space delegation requires an explicit bounded owner envelope, never a direct tool-only registration', () => {
  const root = temporary();
  try {
    const source = configured(root);
    const registration = { ...source.scopes[0]!, receiver: 'space' };
    const parse = (actions: string[]) => parseHostConfig({ ...source, scopes: [{ ...registration, scope: { ...registration.scope, actions } }] }, root);
    assert.deepEqual(parse(['conversation']).scopes[0]!.scope.actions, ['conversation']);
    assert.deepEqual(parse(['conversation', 'delegate-task']).scopes[0]!.scope.actions, ['conversation', 'delegate-task']);
    assert.deepEqual(parse(['conversation', 'delegate-task', 'task-tools']).scopes[0]!.scope.actions, ['conversation', 'delegate-task', 'task-tools']);
    assert.throws(() => parse(['conversation', 'task-tools']));
    assert.throws(() => parse(['conversation', 'delegate-task', 'host-shell']));
    assert.throws(() => parseHostConfig({ ...source, scopes: [{ ...registration, delegationDefaults: true }] }, root));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('unknown privileged fields, invalid network/limits and symlink/public configuration are refused', () => {
  const root = temporary();
  try {
    for (const value of [{ grants: [] }, { nativeHost: 'host.example' }, { nativePort: 65536 }, { nativePort: 42, consolePort: 42 }, { consoleHost: '0.0.0.0' }, { telemetry: { enabled: 'yes' } }, { telemetry: { event: 'arbitrary' } }, { telemetry: { maxBytes: 100000000 } }]) assert.throws(() => parseHostConfig(value, root));
    const file = join(root, 'owner.json'); writeFileSync(file, '{}', { mode: 0o600 });
    assert.equal(loadHostConfig({ SPATIAL_HOST_ROOT: root, SPATIAL_HOST_CONFIG: file }).root, root);
    chmodSync(file, 0o644); assert.throws(() => loadHostConfig({ SPATIAL_HOST_ROOT: root, SPATIAL_HOST_CONFIG: file }));
    chmodSync(file, 0o600); symlinkSync(file, join(root, 'link.json')); assert.throws(() => assertPrivatePath(join(root, 'link.json')));
    mkdirSync(join(root, 'real')); symlinkSync(join(root, 'real'), join(root, 'linked-root')); assert.throws(() => prepareHostRoot(join(root, 'linked-root')));
    prepareHostRoot(root); prepareHostRoot(root); assertPrivatePath(root, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('speech options allow only the actual fixed provider contract, private journal and explicit price/caps', () => {
  const root = temporary(), file = join(root, 'speech-options.json');
  try {
    const load = (value: unknown) => { writeFileSync(file, JSON.stringify(value), { mode: 0o600 }); return loadSpeechOptions(file, root); };
    assert.deepEqual(load({}), { journalPath: join(root, 'speech.sqlite') });
    assert.equal(load({ approvedPerCallUsd: 0.1, approvedDailyUsd: 1, pricing: { whisperUsdPerMinute: 0.006, ttsUsdPerMillionCharacters: 15, verifiedAt: new Date().toISOString() } }).approvedDailyUsd, 1);
    for (const options of [{ key: 'fixture-secret' }, { endpoint: 'https://elsewhere' }, { fetch: true }, { journalPath: '/unrelated/journal' }, { timeoutMs: 26000 }, { approvedDailyUsd: -1 }, { voice: 'unknown' }, { initializeJournal: true }]) assert.throws(() => load(options));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
