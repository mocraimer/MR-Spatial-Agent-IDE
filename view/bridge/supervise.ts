/**
 * `npm run view`: starts the bridge as a child process and restarts it when a new build lands.
 *
 * The supervisor watches the directory it was run from (the build output) for file writes. When
 * the build has settled (no file changed for about 1 s), it restarts the child and logs one line.
 * If the new child exits within 10 s of starting, it logs the error and waits for the next build
 * rather than looping. Ctrl-C ends both.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { watch } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const child = join(here, 'main.js');
/** Settle: no build file changed for this long before restarting. */
const SETTLE_MS = 1000;
/** Crash guard: a child that exits within this window is treated as a bad build. */
const CRASH_GUARD_MS = 10_000;
/** How long between log timestamps. */
const log = (line: string) => console.log(`${new Date().toISOString().slice(11, 19)} supervisor: ${line}`);

let current: ChildProcess | null = null;
let startedAt = 0;
let settleTimer: NodeJS.Timeout | null = null;
let stopping = false;

function start(reason: string): void {
  if (stopping) return;
  log(reason);
  const proc = spawn(process.execPath, [child], { env: { ...process.env, SPATIAL_RESTARTED: '1' }, stdio: 'inherit' });
  current = proc;
  startedAt = Date.now();
  proc.once('exit', (code, signal) => {
    if (current !== proc) return;
    current = null;
    const uptime = Date.now() - startedAt;
    if (!stopping) {
      if (uptime < CRASH_GUARD_MS) log(`bridge exited after ${uptime} ms (code ${code ?? signal}); waiting for next build before restarting`);
      else log(`bridge exited (code ${code ?? signal}); waiting for next build`);
    }
  });
}

function scheduleRestart(): void {
  if (settleTimer) clearTimeout(settleTimer);
  settleTimer = setTimeout(() => {
    settleTimer = null;
    const uptime = Date.now() - startedAt;
    if (current !== null && uptime < CRASH_GUARD_MS) {
      log('build changed but current bridge started less than 10 s ago; waiting for it to settle');
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
const buildDir = join(here, '..', '..');
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
