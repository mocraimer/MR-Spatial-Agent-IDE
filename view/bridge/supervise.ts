/**
 * `npm run view`: starts the bridge as a child process and restarts it when a new build lands.
 *
 * The supervisor detects builds by polling the build directory for mtime changes (stat-based, ~1 s
 * interval). This works on any filesystem — including Windows drvfs (9P) where fs.watch receives
 * no inotify events. When the build has settled (no file changed for SETTLE_MS), it restarts the
 * child and logs one line. If the new child exits within CRASH_GUARD_MS, it logs the error and
 * waits for the next build rather than looping. Ctrl-C ends both.
 *
 * Environment overrides (for tests):
 *   SPATIAL_BRIDGE_CHILD — path to the child script to run instead of main.js
 *   SPATIAL_BUILD_WATCH_DIR — directory to watch for .js changes instead of the build root
 *   SPATIAL_SETTLE_MS — settle delay in ms (default 1000)
 *   SPATIAL_CRASH_GUARD_MS — crash guard window in ms (default 10000)
 *   SPATIAL_POLL_MS — poll interval in ms (default 1000)
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const child = process.env.SPATIAL_BRIDGE_CHILD ?? join(here, 'main.js');
/** Settle: no build file changed for this long before restarting. */
const SETTLE_MS = Number(process.env.SPATIAL_SETTLE_MS ?? '1000');
/** Crash guard: a child that exits within this window is treated as a bad build. */
const CRASH_GUARD_MS = Number(process.env.SPATIAL_CRASH_GUARD_MS ?? '10000');
/** Poll interval: how often to check mtimes (default 1000 ms). */
const POLL_MS = Number(process.env.SPATIAL_POLL_MS ?? '1000');
/** How long between log timestamps. */
const log = (line: string) => console.log(`${new Date().toISOString().slice(11, 19)} supervisor: ${line}`);

let current: ChildProcess | null = null;
let startedAt = 0;
let settleTimer: NodeJS.Timeout | null = null;
/** After a crash-after-guard restart, track that one grace restart was given. */
let crashRestartPending = false;
let stopping = false;

/** Scan `dir` recursively and return a map of path → mtime for all .js files. */
function scanMtimes(dir: string): Map<string, number> {
  const result = new Map<string, number>();
  let entries: string[];
  try {
    entries = readdirSync(dir, { recursive: true, encoding: 'utf8' }) as string[];
  } catch {
    return result;
  }
  for (const rel of entries) {
    if (!rel.endsWith('.js')) continue;
    const abs = join(dir, rel);
    try {
      result.set(abs, statSync(abs).mtimeMs);
    } catch { /* file disappeared between readdir and stat – ignore */ }
  }
  return result;
}

/** Start the poll loop. Fires scheduleRestart() when any .js mtime changes. */
function startPolling(dir: string): void {
  let prev = scanMtimes(dir);
  const id = setInterval(() => {
    if (stopping) { clearInterval(id); return; }
    const next = scanMtimes(dir);
    let changed = false;
    for (const [path, mtime] of next) {
      if (prev.get(path) !== mtime) { changed = true; break; }
    }
    if (!changed) {
      for (const path of prev.keys()) {
        if (!next.has(path)) { changed = true; break; }
      }
    }
    if (changed) {
      prev = next;
      scheduleRestart();
    }
  }, POLL_MS);
}

/** Start the bridge child. Pass `resetCrashPending=true` for new-build or initial starts. */
function start(reason: string, resetCrashPending = false): void {
  if (stopping) return;
  log(reason);
  const proc = spawn(process.execPath, [child], { env: { ...process.env, SPATIAL_RESTARTED: '1' }, stdio: 'inherit' });
  current = proc;
  startedAt = Date.now();
  if (resetCrashPending) crashRestartPending = false;
  proc.once('exit', (code, signal) => {
    if (current !== proc) return;
    current = null;
    const uptime = Date.now() - startedAt;
    if (!stopping) {
      if (uptime < CRASH_GUARD_MS) {
        log(`bridge exited after ${uptime} ms (code ${code ?? signal}); waiting for next build before restarting`);
      } else {
        log(`bridge exited (code ${code ?? signal}); restarting once`);
        // Restart once after a clean exit (uptime ≥ guard). If THAT restart also exits after
        // the guard, we do NOT restart again — the grace flag was not reset by this call.
        if (!crashRestartPending) {
          crashRestartPending = true;
          start('restarting after exit'); // resetCrashPending stays false
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
        start('new build detected; restarting', true);  // new build resets crash-restart guard
      }, remaining);
      return;
    }
    if (current !== null) {
      current.kill('SIGTERM');
      current = null;
    }
    start('new build detected; restarting', true);  // new build resets crash-restart guard
  }, SETTLE_MS);
}

// Poll the build directory for mtime changes instead of using fs.watch.
// fs.watch is inotify-based and delivers no events on Windows drvfs (9P).
const buildDir = process.env.SPATIAL_BUILD_WATCH_DIR ?? join(here, '..', '..');
startPolling(buildDir);

start('bridge starting', true);  // initial start resets crash-restart guard

function shutdown(): void {
  if (stopping) return;
  stopping = true;
  if (settleTimer) clearTimeout(settleTimer);
  if (current) { current.kill('SIGTERM'); current = null; }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
