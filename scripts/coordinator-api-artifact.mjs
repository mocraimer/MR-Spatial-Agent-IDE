import { createHash } from 'node:crypto';
import { cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

export const packageName = 'agent-system';
export const artifactRelativePath = 'vendor/coordinator-api';
const metadataName = 'coordinator-api-identity.json';
const json = path => JSON.parse(readFileSync(path, 'utf8'));
function inside(root, path) {
  const part = relative(root, path);
  if (!part || part.startsWith('..') || isAbsolute(part)) throw new Error('Coordinator declaration escapes its compiled build.');
  const directories = part.split(/[\\/]/).slice(0, -1);
  if (directories.some(name => name.startsWith('.') || ['auth', 'credentials', 'secrets', 'evidence', 'volumes', 'workspaces', 'host'].includes(name))) throw new Error('Private data directories cannot enter the coordinator API artifact.');
  return part;
}
function regular(path) {
  if (!lstatSync(path).isFile()) throw new Error('Coordinator artifact inputs must be regular files, not links.');
}
/** Matches the coordinator stamp-build algorithm; no command/store modules are loaded. */
export function readBuildIdentity(buildDirectory) {
  const root = resolve(buildDirectory);
  if (!lstatSync(root).isDirectory()) throw new Error('Select a compiled coordinator build directory, not a link.');
  const hash = createHash('sha256');
  function walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else {
        regular(path);
        if (entry.name !== 'build-identity.json') hash.update(relative(root, path)).update('\0').update(readFileSync(path)).update('\0');
      }
    }
  }
  regular(join(root, 'build-identity.json'));
  const identity = json(join(root, 'build-identity.json'));
  walk(root);
  if (!/^[a-f0-9]{64}$/.test(identity.digest) || identity.digest !== hash.digest('hex')) throw new Error('Coordinator build is stale or changed: rebuild it before preparing API types.');
  return { digest: identity.digest, revision: identity.revision ?? null, dirty: identity.dirty === true };
}
/** Copy only declarations reachable from the public barrel, never coordinator implementations. */
function declarations(root) {
  const pending = ['spatial-api.d.ts'];
  const files = new Map();
  while (pending.length) {
    const name = pending.pop();
    if (files.has(name)) continue;
    const path = resolve(root, name);
    inside(root, path);
    // Reject symlinked parent directories as well as linked files.
    for (let parent = dirname(path); parent !== root; parent = dirname(parent)) {
      if (!lstatSync(parent).isDirectory()) throw new Error('Linked declaration directory is not permitted.');
    }
    regular(path);
    const content = readFileSync(path);
    files.set(name, content);
    // tsc emits from 'x', import('x') and import 'x' module references in declarations.
    const references = content.toString('utf8').matchAll(/\b(?:from\s*|import\s*(?:\(\s*)?)["']([^"']+)["']/g);
    for (const [, specifier] of references) {
      if (!specifier.startsWith('.')) continue;
      if (!specifier.endsWith('.js')) throw new Error(`Unsupported compiled declaration reference: ${specifier}`);
      const target = resolve(dirname(path), `${specifier.slice(0, -3)}.d.ts`);
      pending.push(inside(root, target));
    }
  }
  return new Map([...files].sort(([a], [b]) => a.localeCompare(b)));
}
function declarationDigest(files) {
  const hash = createHash('sha256');
  for (const [name, content] of files) hash.update(name).update('\0').update(content).update('\0');
  return hash.digest('hex');
}
export function prepareCoordinatorApi(buildDirectory, productDirectory) {
  const root = resolve(buildDirectory);
  const build = readBuildIdentity(root);
  const files = declarations(root);
  const metadata = { schemaVersion: 1, build, declarationsDigest: declarationDigest(files) };
  const staging = mkdtempSync(join(tmpdir(), 'spatial-coordinator-api-'));
  try {
    const contents = join(staging, 'package'); mkdirSync(contents);
    for (const [name, content] of files) {
      const path = join(contents, 'dist', name); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content);
    }
    writeFileSync(join(contents, metadataName), JSON.stringify(metadata, null, 2) + '\n');
    writeFileSync(join(contents, 'package.json'), JSON.stringify({
      name: packageName, version: '0.1.0', private: true, type: 'module',
      description: 'Build-time coordinator declarations; not an execution package',
      exports: { './spatial-api': { types: './dist/spatial-api.d.ts' }, './coordinator-api-identity': `./${metadataName}` },
    }, null, 2) + '\n');
    if (readBuildIdentity(root).digest !== build.digest) throw new Error('Coordinator changed during API preparation; retry after its build finishes.');
    const destination = join(resolve(productDirectory), artifactRelativePath);
    mkdirSync(dirname(destination), { recursive: true });
    rmSync(`${destination}.tmp`, { recursive: true, force: true });
    cpSync(contents, `${destination}.tmp`, { recursive: true });
    rmSync(destination, { recursive: true, force: true }); renameSync(`${destination}.tmp`, destination);
    return { artifact: destination, ...metadata };
  } finally { rmSync(staging, { recursive: true, force: true }); }
}
export function verifyCoordinatorApi(buildDirectory, packageDirectory) {
  const metadata = json(join(packageDirectory, metadataName));
  if (metadata.schemaVersion !== 1 || metadata.build?.digest !== readBuildIdentity(buildDirectory).digest) throw new Error('Installed coordinator API types do not match the selected build. Prepare its artifact and refresh the product lock/install.');
  if (declarationDigest(declarations(join(packageDirectory, 'dist'))) !== metadata.declarationsDigest) throw new Error('Installed coordinator declarations changed. Reinstall the locked API artifact.');
  return metadata;
}
