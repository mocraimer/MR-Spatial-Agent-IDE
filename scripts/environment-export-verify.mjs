import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import console from 'node:console';
import process from 'node:process';
import { DockerEnvironmentEngine, EnvironmentBroker, EnvironmentError } from '../build/host/src/environment-broker.js';

// Actual offline image, real stopped private volumes. Never searches for or deletes unrelated objects.
const evidence = join(homedir(), '.local/share/spatial-agent-workspace/environment-export-verification', randomUUID());
mkdirSync(evidence, { recursive: true, mode: 0o700 });
const directory = join(evidence, 'broker');
let broker = new EnvironmentBroker(directory);
const results = []; const cleanup = [];
const rejected = code => error => error instanceof EnvironmentError && error.code === code;
function managed(taskId) { return JSON.parse(readFileSync(join(directory, 'environments.json'), 'utf8')).find(row => row.taskId === taskId); }
async function docker(args) {
  const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH, HOME: process.env.HOME } });
  let output = ''; let error = '';
  child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { error += chunk; });
  await new Promise((accept, reject) => { child.on('error', reject); child.on('close', code => code === 0 ? accept() : reject(new Error(error))); });
  return output.trim();
}
async function exec(taskId, command) {
  const state = broker.snapshot(taskId); const port = state.lease.owner === 'owner' ? broker.owner() : broker.agent();
  const result = await port.exec(taskId, state.lease.epoch, command); assert.equal(result.exitCode, 0, result.output); return result.output;
}
async function copy(stream, destination) {
  const h = createHash('sha256'); let bytes = 0;
  const source = stream.open(); source.on('data', chunk => { h.update(chunk); bytes += chunk.length; });
  await pipeline(source, createWriteStream(destination, { flags: 'wx', mode: 0o600 }));
  assert.equal(bytes, stream.bytes); assert.equal(h.digest('hex'), stream.sha256);
}
async function destroy(taskId) {
  const state = broker.snapshot(taskId); const env = managed(taskId);
  assert.equal(await docker(['ps', '-a', '--no-trunc', '--filter', `id=${env.containerId}`, '--format', '{{.ID}}']), env.containerId);
  await broker.owner().archive(taskId, state.lease.epoch);
  await broker.owner().destroy(taskId, state.lease.epoch);
  assert.equal(await docker(['ps', '-a', '--no-trunc', '--filter', `id=${env.containerId}`, '--format', '{{.ID}}']), '');
  const volumes = await docker(['volume', 'ls', '--filter', `name=${env.volume}`, '--format', '{{.Name}}']);
  assert.ok(!volumes.split('\n').includes(env.volume));
  cleanup.push({ taskId, rootId: env.rootId, environmentId: env.environmentId, containerId: env.containerId, volume: env.volume, verifiedArchiveBeforeRemoval: true, exactContainerAbsent: true, exactVolumeAbsent: true });
}
try {
  assert.equal((await broker.readiness()).state, 'ready');
  const state = await broker.create('large-workspace');
  assert.equal('exportArchive' in broker.agent(), false);
  await assert.rejects(broker.owner().exportArchive('large-workspace', 1), rejected('active-environment'));
  const sentinel = join(evidence, 'HOST_ONLY_SENTINEL'); writeFileSync(sentinel, 'host-only-export-boundary');
  const creation = await exec('large-workspace', `python3 - <<'PY'\nimport hashlib, json, os, socket\nassert os.getuid() == 1000\nfor path in [${JSON.stringify(sentinel)}, '/var/run/docker.sock', '/run/docker.sock', ${JSON.stringify(join(homedir(), '.pi'))}, ${[...new Set(['/mnt/c', /^\/mnt\/[a-z]/.exec(process.cwd())?.[0]].filter(Boolean))].map(drive => JSON.stringify(drive)).join(', ')}]:\n assert not os.path.exists(path), path\nassert not any(('TOKEN' in k or 'SECRET' in k or 'KEY' in k or k.startswith(('PI_', 'OPENAI_', 'ANTHROPIC_', 'AWS_'))) for k in os.environ)\nassert 'CapEff:\\t0000000000000000' in open('/proc/self/status').read()\nassert 'NoNewPrivs:\\t1' in open('/proc/self/status').read()\ntry:\n socket.create_connection(('1.1.1.1',443),timeout=1)\nexcept OSError: pass\nelse: raise AssertionError('direct network permitted')\nos.makedirs('/workspace/saved/code', exist_ok=True)\nos.makedirs('/workspace/artifacts/empty-directory', exist_ok=True)\nblock=bytes(range(256))*4096\nh=hashlib.sha256()\nwith open('/workspace/artifacts/large.bin','wb') as f:\n for _ in range(20): f.write(block); h.update(block)\n f.flush(); os.fsync(f.fileno())\nwith open('/workspace/saved/code/main.py','wb') as f: f.write(b'print("saved real task code")\\n')\nopen('/workspace/artifacts/empty.bin','wb').close()\nprint(json.dumps({'bytes':20*len(block),'sha256':h.hexdigest()}))\nPY`);
  const expected = JSON.parse(creation.match(/\{"bytes"[^\n]+/)[0]);
  assert.ok(expected.bytes > 16_000_000);
  const stopped = await broker.owner().stop('large-workspace', state.lease.epoch, true);
  await assert.rejects(broker.owner().exportArchive('large-workspace', 1), rejected('stale-epoch'));
  await assert.rejects(broker.owner().exportArchive('unknown-task', 1), rejected('environment-missing'));
  await assert.rejects(broker.owner().destroy('large-workspace', stopped.epoch), rejected('archive-required'));
  const source = managed('large-workspace');
  const engine = new DockerEnvironmentEngine();
  await assert.rejects(engine.verifyWorkspace({ ...source, taskId: 'wrong-label' }), rejected('unmanaged-environment'));
  await assert.rejects(engine.verifyWorkspace({ ...source, volume: 'other-root-volume' }), rejected('unmanaged-environment'));
  // Verify source stop state again, not merely the broker's remembered lifecycle.
  await docker(['start', source.containerId]);
  await assert.rejects(broker.owner().exportArchive('large-workspace', stopped.epoch), rejected('active-environment'));
  await docker(['kill', '--signal', 'KILL', source.containerId]);
  const exported = await broker.owner().exportArchive('large-workspace', stopped.epoch);
  const big = exported.files.find(file => file.path === 'artifacts/large.bin');
  assert.equal(big.bytes, expected.bytes); assert.equal(big.sha256, expected.sha256);
  await copy(big, join(evidence, 'large-file-proof.bin'));
  const code = exported.files.find(file => file.path === 'saved/code/main.py');
  await copy(code, join(evidence, 'saved-code-proof.py'));
  assert.equal(readFileSync(join(evidence, 'saved-code-proof.py'), 'utf8'), 'print("saved real task code")\n');
  await copy(exported.rawArchive, join(evidence, 'workspace-proof.tar'));
  assert.equal(readFileSync(sentinel, 'utf8'), 'host-only-export-boundary');
  results.push('real 20 MiB binary + saved code + empty file and directory captured from fully stopped private volume; byte counts and SHA-256 verified; private raw tar retained without extraction', 'owner-only; active/stale/unknown/labels/wrong-volume failures; actual externally restarted container refused; host/network/socket/credential/capability denial');
  writeFileSync(join(evidence, 'export-inventory.json'), JSON.stringify({ taskId: exported.taskId, environmentId: exported.environmentId, epoch: exported.epoch, files: exported.files.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })), rawArchive: { bytes: exported.rawArchive.bytes, sha256: exported.rawArchive.sha256 } }, null, 2));
  await destroy('large-workspace');
  for (const [kind, command] of [
    ['host-symlink', `ln -s ${JSON.stringify(sentinel)} /workspace/attack`],
    ['directory-symlink', `ln -s ${JSON.stringify(homedir())} /workspace/attack`],
    ['hardlink', 'printf hardlink >/workspace/link-target; ln /workspace/link-target /workspace/attack'],
    ['fifo', 'mkfifo /workspace/attack']
  ]) {
    await broker.create(kind); await exec(kind, command);
    const stopped = await broker.owner().stop(kind, 1, true);
    await assert.rejects(broker.owner().exportArchive(kind, stopped.epoch), rejected('archive-invalid'));
    await assert.rejects(broker.owner().destroy(kind, stopped.epoch), rejected('archive-required'));
    assert.equal(readFileSync(sentinel, 'utf8'), 'host-only-export-boundary');
    // Explicit owner reset permits repair INSIDE this new task's own volume; no host extraction or cleanup bypass.
    const controlled = await broker.owner().takeControl(kind, stopped.epoch, true); assert.equal(controlled.owner, 'owner');
    await exec(kind, 'rm /workspace/attack');
    const repaired = await broker.owner().stop(kind, controlled.epoch, true); assert.notEqual(repaired.owner, 'uncertain');
    await destroy(kind);
    results.push(`actual ${kind} refused without cleanup; explicit task-local repair then verified archive/removal`);
  }
  await broker.create('recovered-uncertain'); broker.close(); broker = new EnvironmentBroker(directory);
  const uncertain = broker.snapshot('recovered-uncertain'); assert.equal(uncertain.state, 'uncertain');
  await assert.rejects(broker.owner().exportArchive('recovered-uncertain', uncertain.lease.epoch), rejected('active-environment'));
  await broker.owner().stop('recovered-uncertain', uncertain.lease.epoch, true); await destroy('recovered-uncertain');
  results.push('real broker restart leaves running work uncertain; export refused until explicit verified stop');
  const report = { status: 'PASS', evidence, results, cleanup, limitations: ['100000 member / 64 MB inventory and five-minute operation limits fail explicitly, never drop files', 'Host-path traversal tar fixtures and queued/generation/disk-interruption cases are unit tests, not Docker-produced paths', 'No headset claim; no model calls, services, grants, global or other-root Docker mutations'] };
  writeFileSync(join(evidence, 'result.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
} catch (failure) {
  // No destructive finally: a failed export must retain its volume and pending archive for inspection.
  writeFileSync(join(evidence, 'FAILURE.json'), JSON.stringify({ error: String(failure), retained: broker.snapshots(), cleanup }, null, 2));
  console.error(JSON.stringify({ status: 'FAIL', evidence, error: String(failure), retained: broker.snapshots(), cleanup }, null, 2));
  throw failure;
} finally { broker.close(); }
