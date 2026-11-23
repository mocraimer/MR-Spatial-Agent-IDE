/**
 * Deliverable 7: `npm run view` runs a supervisor that restarts the bridge when a new build lands.
 *
 * Tests run against the REAL compiled build/view/bridge/supervise.js, overriding the child script
 * and watch directory via SPATIAL_BRIDGE_CHILD and SPATIAL_BUILD_WATCH_DIR. SPATIAL_SETTLE_MS and
 * SPATIAL_CRASH_GUARD_MS shorten the timeouts so the tests complete in seconds, not minutes.
 *
 * AC-7.1: When a .js file appears in the build directory, the supervisor kills the running child,
 *   waits for it to settle, and starts a new child with SPATIAL_RESTARTED=1.
 * AC-7.2: A child that exits within the crash-guard window is treated as a bad build; the
 *   supervisor logs the event and does NOT restart until the next build change.
 * C.1: When a build arrives while the current child is still in its guard window, the restart is
 *   rescheduled (not dropped).
 * C.2: A child that exits after >= CRASH_GUARD_MS is restarted once automatically.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const here = dirname(fileURLToPath(import.meta.url));
/** The real compiled supervisor. */
const SUPERVISE_JS = join(here, '..', 'bridge', 'supervise.js');

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

/** A child script that exits after 300 ms (simulating a bridge that outlives a short guard). */
const DELAYED_EXIT_SCRIPT = `
process.stdout.write('started restarted=' + (process.env.SPATIAL_RESTARTED ?? '') + '\\n');
setTimeout(() => { process.stdout.write('exiting\\n'); process.exit(0); }, 300);
`;

/** Writes the child script to a temp file and returns the path. */
function writeChild(dir: string, name: string, src: string): string {
  const p = join(dir, name);
  writeFileSync(p, src, 'utf8');
  return p;
}

/** Waits for a predicate on collected log lines, with timeout. */
function waitFor(lines: string[], pred: () => boolean, what: string, ms = 8000): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const id = setTimeout(() => reject(new Error(`${what} timed out; lines:\n${lines.join('\n')}`)), ms);
    const t = setInterval(() => { if (pred()) { clearInterval(t); clearTimeout(id); resolve(); } }, 50);
  });
}

/** Shared env for all supervisor test runs: short guard and settle windows. */
const TEST_ENV = {
  ...process.env,
  SPATIAL_SETTLE_MS: '100',
  SPATIAL_CRASH_GUARD_MS: '500',
};

test('AC-7.1: when a build file changes, the supervisor restarts the bridge with SPATIAL_RESTARTED=1', async () => {
  const dir = mkdtempSync('/tmp/svl-sup-');
  try {
    const buildDir = join(dir, 'build');
    mkdirSync(buildDir);
    const childPath = writeChild(dir, 'long_child.mjs', LONG_CHILD_SCRIPT);

    const lines: string[] = [];
    const sup = spawn(process.execPath, [SUPERVISE_JS], {
      env: { ...TEST_ENV, SPATIAL_BRIDGE_CHILD: childPath, SPATIAL_BUILD_WATCH_DIR: buildDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    createInterface({ input: sup.stdout }).on('line', l => lines.push(l));
    createInterface({ input: sup.stderr }).on('line', l => lines.push(`STDERR: ${l}`));

    // Wait for the first child to start.
    await waitFor(lines, () => lines.some(l => l.includes('started')), 'first child start');

    // Wait for the crash guard window to pass (600 ms > CRASH_GUARD_MS=500 ms).
    await new Promise(resolve => setTimeout(resolve, 650));

    // Trigger a build change.
    writeFileSync(join(buildDir, 'bridge.js'), '// new build\n');

    // Wait for a second start (the restart). Settle is 100 ms.
    await waitFor(lines, () => lines.filter(l => l.includes('started')).length >= 2, 'restart after build change');

    assert.ok(lines.some(l => l.includes('new build detected')), `logged restart reason; lines:\n${lines.join('\n')}`);
    assert.ok(lines.some(l => l.includes('started restarted=1')), `restarted child reports SPATIAL_RESTARTED=1; lines:\n${lines.join('\n')}`);

    sup.kill('SIGTERM');
    await new Promise<void>(resolve => sup.once('exit', () => resolve()));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('AC-7.2: a child that crashes within the guard window is not restarted until the next build change', async () => {
  const dir = mkdtempSync('/tmp/svl-sup-');
  try {
    const buildDir = join(dir, 'build');
    mkdirSync(buildDir);
    const childPath = writeChild(dir, 'crash_child.mjs', CRASH_CHILD_SCRIPT);

    const lines: string[] = [];
    const sup = spawn(process.execPath, [SUPERVISE_JS], {
      env: { ...TEST_ENV, SPATIAL_BRIDGE_CHILD: childPath, SPATIAL_BUILD_WATCH_DIR: buildDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    createInterface({ input: sup.stdout }).on('line', l => lines.push(l));
    createInterface({ input: sup.stderr }).on('line', l => lines.push(`STDERR: ${l}`));

    // Wait for the crash guard log.
    await waitFor(lines, () => lines.some(l => l.includes('waiting for next build before restarting')), 'crash guard log');

    assert.ok(lines.some(l => l.includes('waiting for next build before restarting')), `logged crash guard; lines:\n${lines.join('\n')}`);

    // Count starts: must be exactly 1.
    const startsBefore = lines.filter(l => l.includes('bridge starting') || l.includes('new build detected')).length;
    assert.equal(startsBefore, 1, 'only one start before the guard fires');

    // Trigger a build change — the supervisor should now start a new child.
    writeFileSync(join(buildDir, 'bridge.js'), '// new build\n');

    await waitFor(lines, () => lines.some(l => l.includes('new build detected')), 'new build detected after crash');
    assert.ok(lines.some(l => l.includes('new build detected; restarting')), `restarts on next build; lines:\n${lines.join('\n')}`);

    sup.kill('SIGTERM');
    await new Promise<void>(resolve => sup.once('exit', () => resolve()));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('C.1: when a build arrives within the guard window, the restart is rescheduled, not dropped', async () => {
  // Start the supervisor with a long-running child. Immediately write a build file (within the
  // 500 ms guard window). The supervisor must log "retrying in N ms" rather than dropping the
  // restart. After the guard expires, it must start a new child.
  const dir = mkdtempSync('/tmp/svl-sup-');
  try {
    const buildDir = join(dir, 'build');
    mkdirSync(buildDir);
    const childPath = writeChild(dir, 'long_child.mjs', LONG_CHILD_SCRIPT);

    const lines: string[] = [];
    const sup = spawn(process.execPath, [SUPERVISE_JS], {
      env: { ...TEST_ENV, SPATIAL_BRIDGE_CHILD: childPath, SPATIAL_BUILD_WATCH_DIR: buildDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    createInterface({ input: sup.stdout }).on('line', l => lines.push(l));
    createInterface({ input: sup.stderr }).on('line', l => lines.push(`STDERR: ${l}`));

    // Wait for the first child to start.
    await waitFor(lines, () => lines.some(l => l.includes('started')), 'first child start');

    // Write a build file immediately (child started < 500 ms ago → within guard).
    writeFileSync(join(buildDir, 'bridge.js'), '// build while in guard\n');

    // The supervisor must log "retrying in N ms" (C.1 fix) and eventually restart.
    await waitFor(lines, () => lines.some(l => l.includes('retrying in')), 'C.1 reschedule log', 5000);
    assert.ok(lines.some(l => l.includes('retrying in')), `C.1 reschedule logged; lines:\n${lines.join('\n')}`);

    // After guard expires + settle, a second child must start.
    await waitFor(lines, () => lines.filter(l => l.includes('started')).length >= 2, 'restart after rescheduled guard', 5000);
    assert.ok(lines.filter(l => l.includes('started')).length >= 2, `C.1: second child started; lines:\n${lines.join('\n')}`);

    sup.kill('SIGTERM');
    await new Promise<void>(resolve => sup.once('exit', () => resolve()));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('C.2: a child that exits after the guard window is restarted once automatically', async () => {
  // The child exits after 300 ms. Guard is 200 ms (using SPATIAL_CRASH_GUARD_MS=200).
  // The child outlives the guard, so the supervisor should restart it once automatically.
  const dir = mkdtempSync('/tmp/svl-sup-');
  try {
    const buildDir = join(dir, 'build');
    mkdirSync(buildDir);
    const childPath = writeChild(dir, 'delayed_exit.mjs', DELAYED_EXIT_SCRIPT);

    const lines: string[] = [];
    const sup = spawn(process.execPath, [SUPERVISE_JS], {
      env: {
        ...process.env,
        SPATIAL_BRIDGE_CHILD: childPath,
        SPATIAL_BUILD_WATCH_DIR: buildDir,
        SPATIAL_SETTLE_MS: '100',
        SPATIAL_CRASH_GUARD_MS: '200',  // Guard shorter than the 300 ms exit delay.
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    createInterface({ input: sup.stdout }).on('line', l => lines.push(l));
    createInterface({ input: sup.stderr }).on('line', l => lines.push(`STDERR: ${l}`));

    // The supervisor should log "restarting once" and start a second child.
    await waitFor(lines, () => lines.some(l => l.includes('restarting')), 'C.2 auto-restart log', 5000);
    assert.ok(lines.some(l => l.includes('restarting')), `C.2 auto-restart logged; lines:\n${lines.join('\n')}`);

    // A second child must start.
    await waitFor(lines, () => lines.filter(l => l.includes('started')).length >= 2, 'C.2 second child started', 5000);
    assert.ok(lines.filter(l => l.includes('started')).length >= 2, `C.2 second child started; lines:\n${lines.join('\n')}`);

    sup.kill('SIGTERM');
    await new Promise<void>(resolve => sup.once('exit', () => resolve()));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
