/**
 * `npm run view`: starts the bridge as a child process and restarts it when a new build lands.
 *
 * The supervisor watches the directory it was run from (the build output) for file writes. When
 * the build has settled (no file changed for about 1 s), it restarts the child and logs one line.
 * If the new child exits within 10 s of starting, it logs the error and waits for the next build
 * rather than looping. Ctrl-C ends both.
 *
 * Environment overrides (for tests):
 *   SPATIAL_BRIDGE_CHILD — path to the child script to run instead of main.js
 *   SPATIAL_BUILD_WATCH_DIR — directory to watch for .js changes instead of the build root
 *   SPATIAL_SETTLE_MS — settle delay in ms (default 1000)
 *   SPATIAL_CRASH_GUARD_MS — crash guard window in ms (default 10000)
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { watch } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const child = process.env.SPATIAL_BRIDGE_CHILD ?? join(here, 'main.js');
/** Settle: no build file changed for this long before restarting. */
const SETTLE_MS = Number(process.env.SPATIAL_SETTLE_MS ?? '1000');
/** Crash guard: a child that exits within this window is treated as a bad build. */
const CRASH_GUARD_MS = Number(process.env.SPATIAL_CRASH_GUARD_MS ?? '10000');
/** How long between log timestamps. */
const log = (line: string) => console.log(`${new Date().toISOString().slice(11, 19)} supervisor: ${line}`);

let current: ChildProcess | null = null;
let startedAt = 0;
let settleTimer: NodeJS.Timeout | null = null;
/** After a crash-after-guard restart, track that one grace restart was given. */
let crashRestartPending = false;
let stopping = false;

function start(reason: string): void {
  if (stopping) return;
  log(reason);
  const proc = spawn(process.execPath, [child], { env: { ...process.env, SPATIAL_RESTARTED: '1' }, stdio: 'inherit' });
  current = proc;
  startedAt = Date.now();
  crashRestartPending = false;
  proc.once('exit', (code, signal) => {
    if (current !== proc) return;
    current = null;
    const uptime = Date.now() - startedAt;
    if (!stopping) {
      if (uptime < CRASH_GUARD_MS) {
        log(`bridge exited after ${uptime} ms (code ${code ?? signal}); waiting for next build before restarting`);
      } else {
        log(`bridge exited (code ${code ?? signal}); restarting once`);
        // Restart once after a clean exit (uptime ≥ guard). If THAT restart crashes within
        // the guard, the loop above applies and waits for the next build.
        if (!crashRestartPending) {
          crashRestartPending = true;
          start('restarting after exit');
        }
      }
    }
  });
}

function scheduleRestart(): void {
  if (settleTimer) clearTimeout(settleTimer);
  settleTimer = setTimeout(() => {
    settleTimer = null;
    const uptime = Date.now() - startedAt;
    if (current !== null && uptime < CRASH_GUARD_MS) {
      // Build landed while the current child is still within its guard window.
      // Reschedule: wait until the guard window ends, then restart.
      const remaining = CRASH_GUARD_MS - uptime;
      log(`build changed but current bridge started ${uptime} ms ago; retrying in ${remaining} ms`);
      settleTimer = setTimeout(() => {
        settleTimer = null;
        if (current !== null) { current.kill('SIGTERM'); current = null; }
        start('new build detected; restarting');
      }, remaining);
      return;
    }
    if (current !== null) {
      current.kill('SIGTERM');
      current = null;
    }
    start('new build detected; restarting');
  }, SETTLE_MS);
}

// Watch the directory where this file lives (build/view/bridge) and its parent (build/view).
// tsc writes into build/view/ so watch build/ recursively to catch all output files.
const buildDir = process.env.SPATIAL_BUILD_WATCH_DIR ?? join(here, '..', '..');
watch(buildDir, { recursive: true }, (_event, filename) => {
  if (filename && /\.js$/.test(filename)) scheduleRestart();
});

start('bridge starting');

function shutdown(): void {
  if (stopping) return;
  stopping = true;
  if (settleTimer) clearTimeout(settleTimer);
  if (current) { current.kill('SIGTERM'); current = null; }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
