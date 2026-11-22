import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { coordinatorDist, coordinatorSkip } from './coordinator.js';

const product = fileURLToPath(new URL('../../../', import.meta.url));
const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
function put(root: string, name: string, content: string): void {
  const path = join(root, name); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content);
}
function stamp(root: string): string {
  const hash = createHash('sha256');
  function walk(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name !== 'build-identity.json') hash.update(relative(root, path)).update('\0').update(readFileSync(path)).update('\0');
    }
  }
  walk(root); const digest = hash.digest('hex');
  put(root, 'build-identity.json', JSON.stringify({ digest, revision: null, dirty: true })); return digest;
}
function fixture(root: string): { build: string; checkout: string } {
  const build = join(root, 'reviewed-location/compiled');
  const checkout = join(root, 'independent/product');
  mkdirSync(build, { recursive: true });
  put(build, 'spatial-api.d.ts', "export type { CoordinatorCommands } from './commands.js';\n");
  put(build, 'commands.d.ts', "import type { Result } from './core/result.js';\nexport interface CoordinatorCommands { lookup(): Result }\n");
  put(build, 'core/result.d.ts', "export interface Result { id: string }\n");
  put(build, 'spatial-api.js', "throw new Error('Preparation must never load execution code');\n");
  for (const name of ['.state/token', 'auth/provider.json', 'host/userdata.json', '.git/config', 'evidence/run.json', 'volumes/private', 'workspaces/private', 'unrelated.d.ts']) put(build, name, 'PRIVATE-SENTINEL');
  stamp(build);
  mkdirSync(join(checkout, 'scripts'), { recursive: true });
  for (const name of ['coordinator-api-artifact.mjs', 'coordinator-api-prepare.mjs', 'coordinator-api-verify.mjs']) cpSync(join(product, 'scripts', name), join(checkout, 'scripts', name));
  put(checkout, 'package.json', JSON.stringify({ name: 'isolated-api-consumer', version: '1.0.0', private: true, type: 'module', devDependencies: { 'agent-system': 'file:vendor/coordinator-api' } }));
  return { build, checkout };
}
function prepare(checkout: string, build: string): string {
  return execFileSync(process.execPath, [join(checkout, 'scripts/coordinator-api-prepare.mjs'), '--build-directory', build], { encoding: 'utf8', stdio: 'pipe' });
}
/** Every file of a folder, by relative path in order, so two folders compare by content. */
function contents(root: string): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path); else files.set(relative(root, path), readFileSync(path, 'utf8'));
    }
  };
  walk(root); return files;
}
const npm = (cwd: string, args: string[]): string => execFileSync('npm', [...args, '--ignore-scripts', '--no-audit', '--no-fund'], { cwd, encoding: 'utf8', stdio: 'pipe' });

test('declaration folder excludes private data/code and bootstraps npm ci in unrelated layouts', { timeout: 60000 }, () => {
  const root = mkdtempSync(join(tmpdir(), 'spatial-api-test-'));
  try {
    const { build, checkout } = fixture(root);
    const prepared = JSON.parse(prepare(checkout, build)) as { build: { digest: string } };
    assert.equal(prepared.build.digest, JSON.parse(readFileSync(join(build, 'build-identity.json'), 'utf8')).digest);
    const folder = join(checkout, 'vendor/coordinator-api');
    const files = contents(folder);
    assert.deepEqual([...files.keys()], ['coordinator-api-identity.json', 'dist/commands.d.ts', 'dist/core/result.d.ts', 'dist/spatial-api.d.ts', 'package.json']);
    for (const content of files.values()) assert.ok(!content.includes('PRIVATE-SENTINEL'));
    npm(checkout, ['install', '--package-lock-only']); npm(checkout, ['ci']);
    put(checkout, 'consumer.ts', "import type { CoordinatorCommands } from 'agent-system/spatial-api';\nexport const lookup = (api: CoordinatorCommands): string => api.lookup().id;\n");
    put(checkout, 'tsconfig.json', JSON.stringify({ compilerOptions: { strict: true, module: 'NodeNext', moduleResolution: 'NodeNext', target: 'ES2023', types: [], outDir: 'compiled' }, include: ['consumer.ts'] }));
    execFileSync(process.execPath, [tsc, '-p', 'tsconfig.json'], { cwd: checkout, stdio: 'pipe' });
    assert.ok(!readFileSync(join(checkout, 'compiled/consumer.js'), 'utf8').includes('agent-system'));
    assert.throws(() => execFileSync(process.execPath, ['--input-type=module', '-e', "await import('agent-system/spatial-api')"], { cwd: checkout, stdio: 'pipe' }));
    const verify = () => execFileSync(process.execPath, [join(checkout, 'scripts/coordinator-api-verify.mjs'), '--build-directory', build], { encoding: 'utf8', stdio: 'pipe' });
    assert.equal(JSON.parse(verify()).build.digest, prepared.build.digest);
    // A source checkout in a second layout recreates the artifact without a hidden path/alias.
    const relocated = join(root, 'second-layout/product');
    cpSync(checkout, relocated, { recursive: true, filter: path => !path.includes('node_modules') && !path.includes('vendor') && !path.includes('compiled') });
    const movedBuild = join(root, 'elsewhere/coordinator/dist'); cpSync(build, movedBuild, { recursive: true });
    prepare(relocated, movedBuild);
    assert.deepEqual(contents(join(relocated, 'vendor/coordinator-api')), files);
    npm(relocated, ['ci']);
    execFileSync(process.execPath, [tsc, '-p', 'tsconfig.json', '--noEmit'], { cwd: relocated, stdio: 'pipe' });
    put(build, 'commands.js', '// different selected build\n');
    assert.throws(verify); // A stale stamp cannot stand in for actual content identity.
    stamp(build); assert.throws(verify); // Nor may another valid build use the old declarations.
    prepare(checkout, build);
    npm(checkout, ['install', '--save-dev', 'agent-system@file:vendor/coordinator-api']);
    assert.notEqual(JSON.parse(verify()).build.digest, prepared.build.digest); // The refreshed folder is what the install reads.
    put(checkout, 'node_modules/agent-system/dist/core/result.d.ts', 'export interface Result { id: number }\n');
    assert.throws(verify);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('preparation rejects stale builds, linked declarations and imports outside compiled output', () => {
  const root = mkdtempSync(join(tmpdir(), 'spatial-api-reject-'));
  try {
    const { build, checkout } = fixture(root);
    put(build, 'commands.d.ts', 'export interface Changed {}'); assert.throws(() => prepare(checkout, build));
    put(build, 'auth/private.d.ts', 'export interface Secret {}');
    put(build, 'spatial-api.d.ts', "export type { Secret } from './auth/private.js';\n"); stamp(build);
    assert.throws(() => prepare(checkout, build));
    put(build, 'spatial-api.d.ts', "export type { Secret } from '../outside.js';\n"); stamp(build);
    assert.throws(() => prepare(checkout, build));
    put(root, 'outside.d.ts', 'export interface Secret {}');
    rmSync(join(build, 'spatial-api.d.ts')); symlinkSync(join(root, 'outside.d.ts'), join(build, 'spatial-api.d.ts')); stamp(build);
    assert.throws(() => prepare(checkout, build));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the committed declarations belong to the selected coordinator build', { skip: coordinatorSkip }, () => {
  execFileSync(process.execPath, [join(product, 'scripts/coordinator-api-verify.mjs'), '--build-directory', coordinatorDist], { stdio: 'pipe' });
});
