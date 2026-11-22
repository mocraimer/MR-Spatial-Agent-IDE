import assert from 'node:assert/strict';
import { createWriteStream, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import process from 'node:process';
import { URL } from 'node:url';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { EnvironmentBroker } from '../build/host/src/environment-broker.js';
import { setTimeout } from 'node:timers';
import console from 'node:console';

// Requires a built host and the local image. No provider calls or pre-existing containers.
const evidence = join(homedir(), '.local/share/spatial-agent-workspace/environment-verification', randomUUID());
mkdirSync(evidence, { recursive: true, mode: 0o700 });
const broker = new EnvironmentBroker(join(evidence, 'broker'));
const agent = broker.agent(); const owner = broker.owner();
const results = []; const cleanup = [];
async function docker(args) {
  const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH, HOME: process.env.HOME } });
  let output = ''; let error = '';
  child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { error += chunk; });
  await new Promise((accept, reject) => { child.on('error', reject); child.on('close', code => code === 0 ? accept() : reject(new Error(error))); });
  return output.trim();
}
async function copy(stream, destination) {
  const hash = createHash('sha256'); let bytes = 0;
  const source = stream.open(); source.on('data', chunk => { hash.update(chunk); bytes += chunk.length; });
  await pipeline(source, createWriteStream(destination, { flags: 'wx', mode: 0o600 }));
  assert.equal(bytes, stream.bytes); assert.equal(hash.digest('hex'), stream.sha256);
}
async function archiveAndDestroy(snapshot) {
  const taskId = snapshot.taskId;
  const env = JSON.parse(readFileSync(join(evidence, 'broker', 'environments.json'), 'utf8')).find(row => row.taskId === taskId);
  assert.ok(env.containerId); assert.ok(env.rootId); assert.equal(env.environmentId, snapshot.environmentId);
  const stopped = await owner.stop(taskId, snapshot.lease.epoch, true);
  assert.notEqual(stopped.owner, 'uncertain', `Cleanup uncertain for ${taskId}: ${stopped.detail}`);
  const exported = await owner.exportArchive(taskId, stopped.epoch);
  const captureDirectory = join(evidence, 'exports', taskId); mkdirSync(captureDirectory, { recursive: true, mode: 0o700 });
  // Broker screens all tar members. Verify every exported file and the retained raw tar without host extraction.
  for (const [index, file] of exported.files.entries()) await copy(file, join(captureDirectory, `file-${index}.bin`));
  await copy(exported.rawArchive, join(captureDirectory, 'workspace.tar'));
  writeFileSync(join(captureDirectory, 'inventory.json'), JSON.stringify({ taskId, environmentId: exported.environmentId, epoch: exported.epoch, files: exported.files.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })), rawArchive: { bytes: exported.rawArchive.bytes, sha256: exported.rawArchive.sha256 } }, null, 2), { mode: 0o600 });
  await owner.archive(taskId, stopped.epoch);
  await owner.destroy(taskId, stopped.epoch);
  assert.equal(await docker(['ps', '-a', '--no-trunc', '--filter', `id=${env.containerId}`, '--format', '{{.ID}}']), '');
  assert.ok(!(await docker(['volume', 'ls', '--filter', `name=${env.volume}`, '--format', '{{.Name}}'])).split('\n').includes(env.volume));
  cleanup.push({ taskId, rootId: env.rootId, environmentId: env.environmentId, containerId: env.containerId, volume: env.volume, verifiedArchiveBeforeRemoval: true, exactContainerAbsent: true, exactVolumeAbsent: true });
}
const delay = milliseconds => new Promise(accept => setTimeout(accept, milliseconds));
async function input(taskId, kind, value = '') {
  const state = broker.snapshot(taskId); const view = state.views.find(view => view.kind === value.view) ?? state.views.find(view => view.kind === 'browser');
  const request = { taskId, environmentId: state.environmentId, viewId: view.id, generation: view.generation, leaseEpoch: state.lease.epoch, kind, x: 0, y: 0, button: '', key: '', text: '', ...value };
  delete request.view;
  await (state.lease.owner === 'owner' ? owner : agent).input(request);
}
async function command(code) {
  const lease = broker.snapshot('proof').lease;
  const result = await (lease.owner === 'owner' ? owner : agent).exec('proof', lease.epoch, code);
  assert.equal(result.exitCode, 0, result.output); return result.output;
}
async function capture(kind, name) {
  const view = broker.snapshot('proof').views.find(view => view.kind === kind);
  const frame = await broker.frame('proof', view.id);
  assert.equal(frame.identity.width, 1280); assert.equal(frame.identity.height, 800);
  writeFileSync(join(evidence, name + '.png'), frame.png);
  writeFileSync(join(evidence, name + '.json'), JSON.stringify(frame.identity, null, 2));
  return frame;
}
try {
  assert.equal((await broker.readiness()).state, 'ready');
  const state = await broker.create('proof');
  assert.equal(state.lease.owner, 'agent');
  await broker.create('other');
  const proof = JSON.parse(readFileSync(join(evidence, 'broker', 'environments.json'), 'utf8')).find(row => row.taskId === 'proof');
  const expectedRuntime = createHash('sha256').update(readFileSync(new URL('../environments/runtime.py', import.meta.url))).digest('hex');
  const terminalProof = await docker(['exec', proof.containerId, 'python3', '-c', `import hashlib,json,socket
assert hashlib.sha256(open('/opt/spatial/runtime.py','rb').read()).hexdigest()==${JSON.stringify(expectedRuntime)}, 'image runtime does not match actual source; rebuild baseline first'
def call(command, timeout=20):
 s=socket.socket(socket.AF_UNIX); s.settimeout(15); s.connect('/tmp/spatial-terminal.sock'); s.sendall(json.dumps({'op':'exec','command':command,'timeout':timeout}).encode()+b'\\n'); data=bytearray()
 while True:
  chunk=s.recv(65536)
  if not chunk: break
  data.extend(chunk)
 s.close(); return json.loads(data)
r=call('python3 -c \\'import sys;sys.stdout.write("x"*1048580)\\'')
assert r=={'error':'output limit reached; process state uncertain'}, r.keys()
r=call('printf "next command after output bound\\\\n"')
assert r['exitCode']==0 and 'next command after output bound' in r['output'], r
r=call('sleep 0.3', timeout=0.1)
assert r=={'error':'terminal timeout; process state uncertain'}, r
import time
time.sleep(0.5)
r=call('printf "next command after deadline\\\\n"')
assert r['exitCode']==0 and 'next command after deadline' in r['output'], r
print('actual-source PTY byte bound and deadline refused completion; service and next command survived')`]);
  assert.match(terminalProof, /service and next command survived/); results.push(terminalProof);
  const imageId = await docker(['inspect', '--type', 'container', proof.containerId, '--format', '{{.Image}}']);
  writeFileSync(join(evidence, 'runtime-image.json'), JSON.stringify({ imageId, runtimeSha256: expectedRuntime, containerId: proof.containerId }, null, 2), { mode: 0o600 });
  assert.match(await command('id -u; test "$(id -u)" = 1000; printf "PTY shell operation\\n"'), /PTY shell operation/);
  assert.match(await broker.terminal('proof'), /PTY shell operation/);
  await agent.write('proof', 1, 'retained.txt', 'durable private workspace');
  assert.equal((await agent.read('proof', 'retained.txt')).toString(), 'durable private workspace');
  await assert.rejects(agent.read('other', 'retained.txt'));
  await agent.write('other', 1, 'retained.txt', 'separate task files');
  assert.equal((await agent.read('proof', 'retained.txt')).toString(), 'durable private workspace');
  const hostSentinel = join(evidence, 'HOST_ONLY_SECRET');
  writeFileSync(hostSentinel, 'never-exposed-to-task');
  // Real raw shell negative paths: host resources, credentials, Docker/control and networking.
  const deny = `python3 - <<'PY'\nimport os, socket, subprocess\nassert os.getuid() == 1000\nfor path in [${JSON.stringify(hostSentinel)}, '/var/run/docker.sock', '/run/docker.sock', ${[...new Set(['/mnt/c', /^\/mnt\/[a-z]/.exec(process.cwd())?.[0]].filter(Boolean))].map(drive => JSON.stringify(drive)).join(', ')}, '/root/.claude', '/root/.config', ${JSON.stringify(join(homedir(), '.pi'))}, ${JSON.stringify(join(homedir(), '.aws'))}]:\n assert not os.path.exists(path), path\nassert not any(('KEY' in k or 'TOKEN' in k or 'SECRET' in k or k.startswith(('PI_', 'ANTHROPIC_', 'OPENAI_', 'AWS_', 'BIFROST_'))) for k in os.environ)\nassert 'CapEff:\\t0000000000000000' in open('/proc/self/status').read()\nassert 'NoNewPrivs:\\t1' in open('/proc/self/status').read()\nfor host, port in [('172.17.0.1',8080), ('1.1.1.1',443), ('host.docker.internal',8080)]:\n try:\n  s=socket.create_connection((host,port),timeout=1)\n except OSError:\n  pass\n else:\n  s.close(); raise AssertionError('network bypass '+host)\ntry:\n open('/opt/spatial/host-write','w').write('bad')\nexcept OSError:\n pass\nelse:\n raise AssertionError('root filesystem writable')\nr=subprocess.run(['unshare','--mount','true'],capture_output=True)\nassert r.returncode != 0\nprint('host/socket/credentials/network/root/caps denial verified')\nPY`;
  assert.match(await command(deny), /denial verified/);
  assert.equal(readFileSync(hostSentinel, 'utf8'), 'never-exposed-to-task');
  results.push('real shell/PTy/output/files; host/socket/credential/network/privilege denial');
  await command('ln -s /etc/passwd /workspace/outside; ln -s /tmp /workspace/outside-dir');
  for (const path of ['/etc/passwd', '../HOST_ONLY_SECRET', 'outside', 'outside-dir/file']) await assert.rejects(async () => agent.read('proof', path));
  await assert.rejects(async () => agent.write('proof', 1, 'outside', 'overwrite'));
  // A failed attempted mutation is conservatively uncertain; explicitly reconcile before GUI proof.
  let lease = broker.snapshot('proof').lease;
  if (lease.owner === 'uncertain') { lease = await owner.resume('proof', lease.epoch, true); assert.equal(lease.owner, 'agent'); }
  // These two task-owned negative-test symlinks cannot remain in a screened workspace archive.
  await command('rm /workspace/outside /workspace/outside-dir');
  const firstBrowser = await capture('browser', 'browser-initial');
  await agent.write('proof', lease.epoch, 'browser-proof.html', '<!doctype html><title>Real Chromium proof</title><h1>Local browser operation</h1><input autofocus id="i"><button onclick="document.title=\'Browser proof: \'+document.querySelector(\'#i\').value">Apply</button>');
  await input('proof', 'key', { key: 'ctrl+l', view: 'browser' });
  await input('proof', 'text', { text: 'file:///workspace/browser-proof.html', view: 'browser' });
  await input('proof', 'key', { key: 'Return', view: 'browser' });
  await delay(1000);
  await input('proof', 'text', { text: 'real-browser', view: 'browser' });
  // Pixel coordinates verified against the actual 1280×800 baseline capture.
  await input('proof', 'pointer', { x: 220, y: 235, button: 'left', view: 'browser' });
  await delay(300);
  assert.match(await command('DISPLAY=:10 xdotool search --onlyvisible --class chromium getwindowname'), /Browser proof: real-browser/);
  const browserAfter = await capture('browser', 'browser-operated');
  assert.notDeepEqual(browserAfter.png, firstBrowser.png);
  await input('proof', 'key', { key: 'ctrl+a', view: 'desktop' });
  await input('proof', 'text', { text: 'Saved by actual GTK desktop input', view: 'desktop' });
  await input('proof', 'key', { key: 'ctrl+s', view: 'desktop' });
  await delay(400);
  assert.equal((await agent.read('proof', 'notes.txt')).toString().trim(), 'Saved by actual GTK desktop input');
  await capture('desktop', 'gtk-operated');
  await input('proof', 'text', { text: "printf 'GUI terminal saved file' > /workspace/gui-terminal.txt", view: 'terminal' });
  await input('proof', 'key', { key: 'Return', view: 'terminal' });
  await delay(300);
  assert.equal((await agent.read('proof', 'gui-terminal.txt')).toString(), 'GUI terminal saved file');
  await capture('terminal', 'terminal-operated');
  results.push('visible real Chromium local DOM operation + PNG; Mousepad GTK input/save + PNG; real PTY terminal PNG');
  const view = broker.snapshot('proof').views[0];
  const stale = { taskId: 'proof', environmentId: state.environmentId, viewId: view.id, generation: view.generation, leaseEpoch: lease.epoch, kind: 'text', x: 0, y: 0, button: '', key: '', text: 'stale' };
  await assert.rejects(async () => agent.input({ ...stale, taskId: 'other' }));
  broker.reconnect('proof');
  await assert.rejects(async () => agent.input(stale));
  // A detached raw-shell daemon mutates the durable workspace. Pointer fencing alone cannot stop it.
  await command("nohup python3 -c 'import time; f=open(\"/workspace/heartbeat\",\"a\"); [(f.write(\"beat\\n\"),f.flush(),time.sleep(.1)) for _ in range(100000)]' >/workspace/daemon.log 2>&1 </dev/null & echo $! >/workspace/daemon.pid");
  await delay(400);
  const beforeRequest = (await agent.read('proof', 'heartbeat')).length;
  const pending = await owner.takeControl('proof', lease.epoch);
  assert.equal(pending.owner, 'handoff'); assert.match(pending.detail, /confirmation-required/);
  await delay(250);
  assert.ok((await agent.read('proof', 'heartbeat')).length > beforeRequest, 'ordinary request must not silently kill process state');
  const blocking = agent.exec('proof', lease.epoch, 'sleep 10; echo should-not-complete >/workspace/old-effect');
  const queued = agent.write('proof', lease.epoch, 'queued-effect', 'must be fenced');
  const settlement = Promise.allSettled([blocking, queued]);
  await delay(300);
  const controlled = await owner.takeControl('proof', lease.epoch, true);
  assert.equal(controlled.owner, 'owner', controlled.detail);
  assert.deepEqual((await settlement).map(result => result.status), ['rejected', 'rejected']);
  assert.equal((await owner.read('proof', 'retained.txt')).toString(), 'durable private workspace');
  assert.equal((await owner.read('proof', 'notes.txt')).toString().trim(), 'Saved by actual GTK desktop input');
  const stoppedLength = (await owner.read('proof', 'heartbeat')).length;
  await delay(700);
  assert.equal((await owner.read('proof', 'heartbeat')).length, stoppedLength, 'old daemon must actually be dead');
  await command('test ! -e /workspace/old-effect; test ! -e /workspace/queued-effect; test -z "$(pgrep -f "[h]eartbeat")"');
  await assert.rejects(async () => owner.input({ ...stale, leaseEpoch: controlled.epoch }));
  await assert.rejects(async () => agent.exec('proof', controlled.epoch, 'owner-only'));
  const resumed = await owner.resume('proof', controlled.epoch);
  assert.equal(resumed.owner, 'handoff');
  assert.equal(broker.snapshot('proof').lease.owner, 'owner');
  const resumedConfirmed = await owner.resume('proof', controlled.epoch, true);
  assert.equal(resumedConfirmed.owner, 'agent');
  await command('printf "agent resumed after explicit reset\\n"');
  results.push('cross-task/stale generation/epoch denial; confirmed full-container takeover kills detached daemon and in-flight shell; queued write rejected; files preserved; explicit destructive resume');
  for (const taskId of ['proof', 'other']) await archiveAndDestroy(broker.snapshot(taskId));
  results.push('all verification-owned workload containers and workspace volumes stopped; screened full archives and all file hashes verified before exact deletion');
  writeFileSync(join(evidence, 'result.json'), JSON.stringify({ status: 'PASS', results, cleanup }, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ status: 'PASS', evidence, results, cleanup }, null, 2));
} catch (failure) {
  // Never destroy after a failed proof/export. Keep only this new private root's resources for inspection.
  writeFileSync(join(evidence, 'FAILURE.json'), JSON.stringify({ error: String(failure), retained: broker.snapshots(), cleanup }, null, 2), { mode: 0o600 });
  console.error(JSON.stringify({ status: 'FAIL', evidence, error: String(failure), retained: broker.snapshots(), cleanup }, null, 2));
  throw failure;
} finally { broker.close(); }
