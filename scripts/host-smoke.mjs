import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import process from 'node:process';
import { once } from 'node:events';
import { setTimeout, clearTimeout } from 'node:timers';
import console from 'node:console';

const installation = resolve(process.argv[2] ?? '.');
const root = mkdtempSync(join(tmpdir(), 'spatial-host-smoke-'));
const configPath = join(root, 'owner.json');
writeFileSync(configPath, JSON.stringify({ nativePort: 0, consolePort: 0 }), { mode: 0o600 });
// No live coordinator, login, provider key or speech settings inherited by this rehearsal.
const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: root, SPATIAL_HOST_ROOT: root, SPATIAL_HOST_CONFIG: configPath };
const child = spawn('npm', ['start'], { cwd: installation, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
let exited = false;
const completion = once(child, 'exit').then(([code, signal]) => { exited = true; return { code, signal }; });
let output = '', errors = '', buffered = '';
child.stderr.on('data', bytes => { errors = (errors + String(bytes)).slice(-4096); });
try {
  const listening = await new Promise((accept, reject) => {
    const timer = setTimeout(() => reject(new Error('Private npm start did not become ready within 30 seconds.')), 30000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', () => { clearTimeout(timer); reject(new Error('Private npm start exited before readiness: ' + errors)); });
    child.stdout.on('data', bytes => {
      output = (output + String(bytes)).slice(-4096);
      buffered += String(bytes);
      for (let end; (end = buffered.indexOf('\n')) >= 0;) {
        const line = buffered.slice(0, end); buffered = buffered.slice(end + 1);
        if (!line.startsWith('{')) continue;
        const record = JSON.parse(line);
        if (record.event === 'host-listening') { clearTimeout(timer); accept(record); }
      }
    });
  });
  assert.equal(listening.nativeHost, '127.0.0.1'); assert.equal(listening.consoleHost, '127.0.0.1');
  const base = `http://127.0.0.1:${listening.consolePort}`;
  assert.equal((await globalThis.fetch(base + '/setup')).status, 200);
  const snapshot = await (await globalThis.fetch(base + '/v1/snapshot')).json();
  assert.deepEqual(snapshot.projects, []); assert.deepEqual(snapshot.tasks, []); assert.deepEqual(snapshot.inbox, []);
  assert.equal(snapshot.readiness.find(item => item.id === 'execution').state, 'blocked');
  assert.equal(snapshot.readiness.find(item => item.id === 'speech').state, 'blocked');
  for (const file of ['host.lock', 'workspace.sqlite', 'auth/clients.json', 'tls/host-key.pem', 'tls/host-cert.pem']) assert.equal(statSync(join(root, file)).mode & 0o077, 0, file);
  assert.equal(readFileSync(join(root, 'auth/clients.json'), 'utf8').includes('apiKey'), false);
  process.kill(-child.pid, 'SIGINT');
  const result = await Promise.race([completion, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Graceful host shutdown timed out.')), 15000); timer.unref(); })]);
  if (!child.stdout.destroyed) await once(child.stdout, 'close');
  assert.ok(result.code === 0 || result.signal === 'SIGINT', JSON.stringify(result));
  assert.ok(output.includes('host-closed'), 'Host must acknowledge actual graceful close, not just npm exit.');
  console.log('PASS: actual npm start; private temporary SQLite/TLS/setup; empty workspace; providers BLOCKED; SIGINT drained. No production activation/provider calls.');
} finally {
  if (!exited && child.pid) {
    process.kill(-child.pid, 'SIGTERM');
    await completion;
  }
  rmSync(root, { recursive: true, force: true });
}
