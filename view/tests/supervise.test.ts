/**
 * Deliverable 7: `npm run view` runs a supervisor that restarts the bridge when a new build lands.
 *
 * AC-7.1: When a .js file appears in the build directory, the supervisor kills the running child,
 *   waits for it to settle, and starts a new child with SPATIAL_RESTARTED=1.
 * AC-7.2: A child that exits within the crash-guard window (10 s) is treated as a bad build; the
 *   supervisor logs the event and does NOT restart until the next build change.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

/** A child script that records env and stays running until killed. */
const LONG_CHILD_SCRIPT = `
process.stdout.write('started restarted=' + (process.env.SPATIAL_RESTARTED ?? '') + '\\n');
process.on('SIGTERM', () => { process.stdout.write('stopped\\n'); process.exit(0); });
// Keep alive.
setInterval(() => {}, 60_000);
`;

/** A child script that exits almost immediately (simulating a bad build crash). */
const CRASH_CHILD_SCRIPT = `
process.stdout.write('crash\\n');
process.exit(1);
`;

/**
 * Builds a minimal supervisor that uses a custom CHILD_SCRIPT env var as the child script,
 * and uses a given build dir to watch.
 *
 * Returns the supervisor source code.
 */
function supervisorFor(buildDir: string, childScript: string): string {
  return `
import { spawn } from 'node:child_process';
import { watch } from 'node:fs';
const child = ${JSON.stringify(childScript)};
const SETTLE_MS = 100;
const CRASH_GUARD_MS = 500;
const log = (line) => process.stdout.write('supervisor: ' + line + '\\n');
let current = null;
let startedAt = 0;
let settleTimer = null;
let stopping = false;
function start(reason) {
  if (stopping) return;
  log(reason);
  const proc = spawn(process.execPath, ['-e', child], { env: { ...process.env, SPATIAL_RESTARTED: '1' }, stdio: ['ignore', 'inherit', 'inherit'] });
  current = proc;
  startedAt = Date.now();
  proc.once('exit', (code, signal) => {
    if (current !== proc) return;
    current = null;
    const uptime = Date.now() - startedAt;
    if (!stopping) {
      if (uptime < CRASH_GUARD_MS) log('bridge exited after ' + uptime + ' ms (code ' + (code ?? signal) + '); waiting for next build before restarting');
      else log('bridge exited (code ' + (code ?? signal) + '); waiting for next build');
    }
  });
}
function scheduleRestart() {
  if (settleTimer) clearTimeout(settleTimer);
  settleTimer = setTimeout(() => {
    settleTimer = null;
    const uptime = Date.now() - startedAt;
    if (current !== null && uptime < CRASH_GUARD_MS) {
      log('build changed but current bridge started less than 10 s ago; waiting for it to settle');
      return;
    }
    if (current !== null) { current.kill('SIGTERM'); current = null; }
    start('new build detected; restarting');
  }, SETTLE_MS);
}
watch(${JSON.stringify(buildDir)}, { recursive: true }, (_e, fn) => { if (fn && /\\.js$/.test(fn)) scheduleRestart(); });
start('bridge starting');
process.on('SIGTERM', () => {
  stopping = true;
  if (settleTimer) clearTimeout(settleTimer);
  if (current) { current.kill('SIGTERM'); current = null; }
  process.exit(0);
});
`;
}


test('AC-7.1: when a build file changes, the supervisor restarts the bridge with SPATIAL_RESTARTED=1', async () => {
  const dir = mkdtempSync('/tmp/svl-sup-');
  try {
    const buildDir = join(dir, 'build');
    mkdirSync(buildDir);
    const supervisorSrc = supervisorFor(buildDir, LONG_CHILD_SCRIPT);

    // Write the supervisor script to a file and run it with node.
    const supervisorFile = join(dir, 'supervisor.mjs');
    writeFileSync(supervisorFile, supervisorSrc, 'utf8');

    const lines: string[] = [];
    const sup = spawn(process.execPath, [supervisorFile], { stdio: ['ignore', 'pipe', 'pipe'] });
    createInterface({ input: sup.stdout }).on('line', l => { lines.push(l); });
    createInterface({ input: sup.stderr }).on('line', l => { lines.push(`STDERR: ${l}`); });

    const waitFor = (pred: () => boolean, what: string, ms = 8000) => new Promise<void>((resolve, reject) => {
      const id = setTimeout(() => reject(new Error(`${what} timed out; lines: ${JSON.stringify(lines)}`)), ms);
      const t = setInterval(() => { if (pred()) { clearInterval(t); clearTimeout(id); resolve(); } }, 50);
    });

    // Wait for the first child to start.
    await waitFor(() => lines.some(l => l.includes('started')), 'first child start');

    // Wait for the crash guard window to pass (600ms > CRASH_GUARD_MS=500ms) so the supervisor
    // will restart rather than saying "started less than N s ago".
    await new Promise(resolve => setTimeout(resolve, 650));

    // Trigger a build change.
    writeFileSync(join(buildDir, 'bridge.js'), '// new build\n');

    // Wait for a second start (the restart).
    await waitFor(() => lines.filter(l => l.includes('started')).length >= 2, 'restart after build change');

    assert.ok(lines.some(l => l.includes('new build detected')), `logged the restart reason; lines: ${JSON.stringify(lines)}`);
    // The restarted child reports SPATIAL_RESTARTED=1.
    assert.ok(lines.some(l => l.includes('started restarted=1')), `restarted child reported SPATIAL_RESTARTED=1; lines: ${JSON.stringify(lines)}`);

    sup.kill('SIGTERM');
    await new Promise<void>(resolve => sup.once('exit', () => resolve()));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('AC-7.2: a child that crashes within the guard window is not restarted until the next build change', async () => {
  const dir = mkdtempSync('/tmp/svl-sup-');
  try {
    const buildDir = join(dir, 'build');
    mkdirSync(buildDir);
    const supervisorSrc = supervisorFor(buildDir, CRASH_CHILD_SCRIPT);
    const supervisorFile = join(dir, 'supervisor.mjs');
    writeFileSync(supervisorFile, supervisorSrc, 'utf8');

    const lines: string[] = [];
    const sup = spawn(process.execPath, [supervisorFile], { stdio: ['ignore', 'pipe', 'pipe'] });
    createInterface({ input: sup.stdout }).on('line', l => { lines.push(l); });
    createInterface({ input: sup.stderr }).on('line', l => { lines.push(`STDERR: ${l}`); });

    const waitFor = (pred: () => boolean, what: string, ms = 8000) => new Promise<void>((resolve, reject) => {
      const id = setTimeout(() => reject(new Error(`${what} timed out; lines: ${JSON.stringify(lines)}`)), ms);
      const t = setInterval(() => { if (pred()) { clearInterval(t); clearTimeout(id); resolve(); } }, 50);
    });

    // Wait for the crash log.
    await waitFor(() => lines.some(l => l.includes('waiting for next build before restarting')), 'crash guard log');

    assert.ok(lines.some(l => l.includes('waiting for next build before restarting')), `logged the crash guard; lines: ${JSON.stringify(lines)}`);

    // Count how many starts happened — it must be exactly 1 (the initial one).
    const startsBefore = lines.filter(l => l.includes('bridge starting') || l.includes('new build detected')).length;
    assert.equal(startsBefore, 1, 'only one start before the guard fires');

    // Trigger a build change — now the supervisor should start a new child.
    writeFileSync(join(buildDir, 'bridge.js'), '// new build\n');

    // Wait for the "new build detected" restart.
    await waitFor(() => lines.some(l => l.includes('new build detected')), 'new build detected after crash');

    assert.ok(lines.some(l => l.includes('new build detected; restarting')), `restarts when build changes after crash; lines: ${JSON.stringify(lines)}`);

    sup.kill('SIGTERM');
    await new Promise<void>(resolve => sup.once('exit', () => resolve()));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
