import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import console from 'node:console';
import process from 'node:process';

// Actual new-directory package assembly and npm start, not live owner setup.
const source = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporary = mkdtempSync(join(tmpdir(), 'spatial-install-FIXTURE-'));
const installation = join(temporary, 'version');
function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  });
}
function digest(path) { return createHash('sha256').update(readFileSync(path)).digest('hex'); }
function run(command, args, cwd = source) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 180000 });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result.stdout;
}
function anchor(heading) {
  return heading.toLowerCase().replace(/[`*_]/g, '').replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s/g, '-');
}
try {
  run('bash', ['scripts/host-install.sh', installation]);
  const documents = [join(installation, 'README.md'), join(installation, 'native/README.md'), ...files(join(installation, 'docs')), ...files(join(installation, 'native/docs'))];
  for (const path of documents) {
    assert.ok(path.endsWith('.md'), 'Only public Markdown belongs in the doc package.');
    const original = join(source, relative(installation, path));
    assert.equal(digest(path), digest(original), 'Document changed during package assembly: ' + original);
    assert.equal(lstatSync(path).mode & 0o077, 0, path);
    const text = readFileSync(path, 'utf8');
    for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const target = match[1];
      if (/^[a-z]+:/i.test(target)) continue;
      const [file, fragment] = target.split('#');
      const linked = file ? resolve(dirname(path), decodeURIComponent(file)) : path;
      assert.ok(linked.startsWith(installation + '/'), 'Link escapes installed package: ' + target);
      assert.ok(existsSync(linked), 'Missing installed runbook: ' + target);
      if (fragment) {
        const headings = [...readFileSync(linked, 'utf8').matchAll(/^#+\s+(.+)$/gm)].map(heading => anchor(heading[1]));
        assert.ok(headings.includes(fragment), 'Missing installed heading: ' + target);
      }
    }
  }
  for (const directory of ['docs', 'native/docs']) {
    for (const path of files(join(source, directory)).filter(path => path.endsWith('.md') && !relative(source, path).split('/').some(part => part.startsWith('.')))) {
      assert.ok(existsSync(join(installation, relative(source, path))), 'Public runbook omitted: ' + path);
    }
  }
  for (const path of ['.local', 'vendor', '.env', 'host', 'build/host/tests', 'native/artifacts', 'native/Assets', 'node_modules/agent-system', 'node_modules/typescript', 'scripts/coordinator-api-prepare.mjs', 'scripts/coordinator-api-verify.mjs']) {
    assert.equal(existsSync(join(installation, path)), false, 'Source/private/development content must not ship: ' + path);
  }
  for (const path of files(join(installation, 'build'))) {
    assert.match(relative(installation, path), /^build\/host\/src\/[^/]+\.js$/);
    assert.equal(digest(path), digest(join(source, relative(installation, path))), 'Compiled host changed during package assembly.');
    assert.equal(lstatSync(path).mode & 0o077, 0, path);
  }
  for (const path of [installation, join(installation, 'docs'), join(installation, 'native/docs')]) assert.equal(lstatSync(path).mode & 0o077, 0, path);
  for (const script of ['host-smoke.mjs', 'host-speech-init.mjs', 'operation-state.mjs', 'runtime-discovery.mjs', 'runtime-mcp.mjs', 'runtime-pi-extension.mjs']) assert.ok(existsSync(join(installation, 'scripts', script)), script);
  const marker = join(installation, 'existing-state-fixture');
  writeFileSync(marker, 'Do not overwrite this fixture.', { mode: 0o600 });
  const refused = spawnSync('bash', ['scripts/host-install.sh', installation], { cwd: source, encoding: 'utf8' });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /Refusing an existing install directory/);
  assert.equal(readFileSync(marker, 'utf8'), 'Do not overwrite this fixture.');
  assert.equal(spawnSync('bash', ['scripts/host-install.sh', 'relative-fixture'], { cwd: source }).status, 2);
  // This script itself belongs only to the source checkout. The smoke is shipped.
  console.log(run(process.execPath, ['scripts/host-smoke.mjs'], installation).trim());
  const hashes = [...documents, ...files(join(installation, 'build')), join(installation, 'package.json'), join(installation, 'package-lock.json'), ...files(join(installation, 'scripts'))].sort().map(path => `${digest(path)}  ${relative(installation, path)}`);
  const snapshot = createHash('sha256').update(hashes.join('\n') + '\n').digest('hex');
  console.log(hashes.join('\n'));
  console.log(`PASS: actual locked offline install; shipped runbooks/links; runtime-only contents; private permissions; existing-directory refusal. Installed snapshot SHA256: ${snapshot}`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
