// Rehearses a stranger's first hour: clone, install, build, check and start the view on a machine
// state with nothing of the owner's (an empty home, an empty npm cache, no .local, no coordinator
// checkout, no SPATIAL_* variable, only node, npm, git and herdr on PATH). It follows the README's
// Quick start and Checks in order and prints each step's exit code, the skipped tests, and the
// view's first lines.
//
//   node scripts/rehearse-clean-clone.mjs [<repository URL or path>]    default: this repository
//
// The view runs against a Herdr this script starts itself, on a free port, so it never touches a
// running Herdr or view. Pairing codes are masked in the output.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import console from 'node:console';
import { setTimeout } from 'node:timers';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source = process.argv[2] ?? resolve(here, '..');
const mask = text => text.replace(/\b\d{6,}\b/g, '######');
const which = name => {
  try { return execFileSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).trim(); } catch {
    console.error(`rehearsal: ${name} is not on PATH; install it (the README lists what the checks need) and run again.`);
    process.exit(2);
  }
};
const tools = ['node', 'npm', 'npx', 'git', 'herdr'].map(tool => [tool, which(tool)]);

const scratch = mkdtempSync(join(tmpdir(), 'rehearsal-'));
const clone = join(scratch, 'work', 'spatial');
const bin = join(scratch, 'bin');
mkdirSync(bin); mkdirSync(join(scratch, 'home'));
for (const [tool, path] of tools) symlinkSync(path, join(bin, tool));
const env = {
  HOME: join(scratch, 'home'), PATH: [bin, '/usr/bin', '/bin'].join(delimiter), LANG: 'C.UTF-8',
  npm_config_cache: join(scratch, 'npm-cache'), npm_config_update_notifier: 'false',
};
const results = [];
function step(name, command, args, options = {}) {
  const run = spawnSync(command, args, { cwd: clone, env, encoding: 'utf8', maxBuffer: 1 << 28, ...options });
  console.log(`step ${name}: exit ${run.status}`);
  results.push({ name, status: run.status });
  return run;
}

let failed = false;
try {
  const cloned = spawnSync('git', ['clone', '--quiet', source, clone], { env, encoding: 'utf8' });
  console.log(`step clone: exit ${cloned.status}`);
  if (cloned.status !== 0) throw new Error(cloned.stderr);
  step('npm ci', 'npm', ['ci', '--no-audit', '--no-fund']);
  step('npm run build', 'npm', ['run', 'build']);
  step('npm run view:setup', 'npm', ['run', 'view:setup']);

  const { HerdrBench } = await import(pathToFileURL(join(clone, 'build/view/bench/bench.js')).href);
  const bench = await HerdrBench.start([{ label: 'rehearsal', panes: [{ name: 'shell', kind: 'shell' }] }]);
  const port = await new Promise(done => { const probe = createServer().listen(0, () => { const { port } = probe.address(); probe.close(() => done(port)); }); });
  const view = spawn('npm', ['run', 'view'], { cwd: clone, env: { ...env, HERDR_SOCKET_PATH: bench.socketPath, VIEW_PORT: String(port) }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  view.stdout.on('data', chunk => { output += chunk; }); view.stderr.on('data', chunk => { output += chunk; });
  const deadline = Date.now() + 30_000;
  while (!/view bridge on /.test(output) && view.exitCode === null && Date.now() < deadline) await new Promise(done => setTimeout(done, 200));
  const started = /view bridge on https?:\/\/\S+/.test(output);
  console.log(`step npm run view: ${started ? 'started and printed an address' : `did not start (exit ${view.exitCode})`}`);
  results.push({ name: 'npm run view', status: started ? 0 : 1 });
  console.log(mask(output).split('\n').filter(Boolean).slice(0, 4).map(line => `  | ${line}`).join('\n'));
  try { process.kill(-view.pid, 'SIGINT'); } catch { /* already gone */ }
  await bench.stop();

  step('npm run typecheck', 'npm', ['run', 'typecheck']);
  step('npm run lint', 'npm', ['run', 'lint']);
  const test = step('npm test', 'npm', ['test']);
  const skipped = [...test.stdout.matchAll(/^\s*(?:not )?ok \d+ - (.+?) # SKIP\b\s*(.*)$/gm)];
  console.log(`skipped tests and suites: ${skipped.length}`);
  for (const [, name, reason] of skipped) console.log(`  - ${name.slice(0, 90)}: ${reason || 'skipped'}`.slice(0, 200));
  console.log(test.stdout.split('\n').filter(line => /^# (tests|pass|fail|skipped) /.test(line)).join('\n'));
  failed = results.some(result => result.status !== 0);
} catch (error) {
  console.error(error.message);
  failed = true;
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
console.log(failed ? 'rehearsal FAILED' : 'rehearsal passed');
process.exitCode = failed ? 1 : 0;
