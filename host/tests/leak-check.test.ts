import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { type TestContext } from 'node:test';

const product = fileURLToPath(new URL('../../../', import.meta.url));
// Built from pieces so that this file is not itself a hit when it is pushed.
const SECRET_TERM = 'zebra' + 'moon';
const SHAPES = {
  'private key': '-----BEGIN ' + 'PRIVATE KEY-----\nabc\n',
  'token': 'ghp_' + 'a1b2c3d4e5'.repeat(4) + '\n',
  'email address': 'write to ' + 'someone' + '@' + 'elsewhere.test\n',
};

const run = (cwd: string, ...args: string[]): { status: number | null; stderr: string } => {
  const { status, stderr } = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { status, stderr };
};
const write = (root: string, name: string, content: string): void => {
  const path = join(root, name); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content);
};

interface Scratch { repo: string; list: string; push(branch: string): { status: number | null; stderr: string } }
/** A clone with the tracked hook on and a bare remote, so a push is the real thing. */
function scratch(t: TestContext): Scratch {
  const root = mkdtempSync(join(tmpdir(), 'leak-check-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, 'clone'); const remote = join(root, 'remote.git'); const list = join(root, 'private-terms.txt');
  execFileSync('git', ['init', '-q', '--bare', remote]);
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  for (const name of ['scripts/leak-check.mjs', '.githooks/pre-push']) cpSync(join(product, name), join(repo, name), { recursive: true });
  chmodSync(join(repo, '.githooks/pre-push'), 0o755);
  writeFileSync(list, `# made up\n${SECRET_TERM}\n\\(^\\|[^a-z]\\)quuxes\\?\\($\\|[^a-z]\\)\n`);
  const config: [string, string][] = [['user.name', 'Test'], ['user.email', 'test@example.com'], ['core.hooksPath', '.githooks'], ['leakcheck.privateList', list]];
  for (const [key, value] of config) execFileSync('git', ['config', key, value], { cwd: repo });
  execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: repo });
  write(repo, 'README.md', 'clean\n');
  execFileSync('git', ['add', '-A'], { cwd: repo }); execFileSync('git', ['commit', '-q', '-m', 'Start'], { cwd: repo });
  assert.equal(run(repo, 'push', '-q', 'origin', 'main').status, 0);
  return { repo, list, push: branch => run(repo, 'push', '-q', 'origin', branch) };
}
/** One commit on a branch of its own, so a refused push never taints the next case. */
function commit(s: Scratch, branch: string, files: Record<string, string>, message = 'Change'): void {
  execFileSync('git', ['checkout', '-q', '-b', branch, 'main'], { cwd: s.repo });
  for (const [name, content] of Object.entries(files)) write(s.repo, name, content);
  execFileSync('git', ['add', '-A'], { cwd: s.repo }); execFileSync('git', ['commit', '-q', '-m', message], { cwd: s.repo });
}
function refused(result: { status: number | null; stderr: string }, place: RegExp, kind: string): void {
  assert.notEqual(result.status, 0, 'the push must be refused');
  assert.match(result.stderr, place); assert.match(result.stderr, new RegExp(kind));
  for (const value of [SECRET_TERM, ...Object.values(SHAPES).map(shape => shape.trim().split('\n')[0]!)]) assert.ok(!result.stderr.includes(value), 'a hit never prints the value');
}

test('a push carrying a private value is refused, naming the place and the kind but not the value', t => {
  const s = scratch(t);
  commit(s, 'term-in-content', { 'notes.txt': `a line\nmentions ${SECRET_TERM} here\n` });
  refused(s.push('term-in-content'), /notes\.txt:2/, 'private-list term');
  commit(s, 'term-in-message', { 'ok.txt': 'fine\n' }, `Fix ${SECRET_TERM} support`);
  refused(s.push('term-in-message'), /commit [0-9a-f]{10} message/, 'private-list term');
  commit(s, 'term-in-name', { [`${SECRET_TERM}.txt`]: 'fine\n' });
  refused(s.push('term-in-name'), /file name no\. 1 /, 'private-list term');
  commit(s, 'term-by-pattern', { 'words.txt': 'two quuxes\n' });
  refused(s.push('term-by-pattern'), /words\.txt:1/, 'private-list term');
  for (const [kind, content] of Object.entries(SHAPES)) {
    commit(s, `shape-${kind.replace(' ', '-')}`, { 'shape.txt': content });
    refused(s.push(`shape-${kind.replace(' ', '-')}`), /shape\.txt:1/, kind);
  }
});

test('a term added and removed in later commits of the same push is still refused', t => {
  const s = scratch(t);
  commit(s, 'history', { 'a.txt': `${SECRET_TERM}\n` });
  write(s.repo, 'a.txt', 'gone\n'); execFileSync('git', ['commit', '-q', '-am', 'Remove it'], { cwd: s.repo });
  refused(s.push('history'), /a\.txt:1/, 'private-list term');
});

test('a clean push goes through, and so does a second one', t => {
  const s = scratch(t);
  commit(s, 'clean', { 'fine.txt': 'harmless change\n', 'mail.txt': 'test@example.com and noreply@anthropic.com\n' });
  assert.equal(s.push('clean').status, 0);
  write(s.repo, 'more.txt', 'more\n'); execFileSync('git', ['add', '-A'], { cwd: s.repo }); execFileSync('git', ['commit', '-q', '-m', 'More'], { cwd: s.repo });
  assert.equal(s.push('clean').status, 0);
});

test('a missing private list refuses the push; no list at all still stops the generic shapes and says so', t => {
  const s = scratch(t);
  commit(s, 'clean', { 'fine.txt': 'harmless\n' });
  rmSync(s.list);
  const missing = s.push('clean');
  assert.notEqual(missing.status, 0); assert.match(missing.stderr, /private list .* cannot be read/);
  execFileSync('git', ['config', '--unset', 'leakcheck.privateList'], { cwd: s.repo });
  const none = s.push('clean');
  assert.equal(none.status, 0); assert.match(none.stderr, /private list is not set/);
  for (const [kind, content] of Object.entries(SHAPES)) {
    commit(s, `shape-${kind.replace(' ', '-')}`, { 'shape.txt': content });
    const result = s.push(`shape-${kind.replace(' ', '-')}`);
    refused(result, /shape\.txt:1/, kind); assert.match(result.stderr, /private list is not set/);
  }
});

test('tree mode checks the tracked files and their names', t => {
  const s = scratch(t);
  const check = (): { status: number | null; stderr: string } => {
    const { status, stderr } = spawnSync(process.execPath, ['scripts/leak-check.mjs', 'tree'], { cwd: s.repo, encoding: 'utf8' });
    return { status, stderr };
  };
  assert.equal(check().status, 0);
  write(s.repo, 'later.txt', `${SECRET_TERM}\n`); execFileSync('git', ['add', '-A'], { cwd: s.repo });
  refused(check(), /later\.txt:1/, 'private-list term');
});

test('a value that only a merge commit adds is refused', t => {
  const s = scratch(t);
  commit(s, 'side', { 'side.txt': 'fine\n' });
  execFileSync('git', ['checkout', '-q', '-b', 'merged', 'main'], { cwd: s.repo });
  write(s.repo, 'main-side.txt', 'also fine\n'); execFileSync('git', ['add', '-A'], { cwd: s.repo }); execFileSync('git', ['commit', '-q', '-m', 'Main side'], { cwd: s.repo });
  execFileSync('git', ['merge', '-q', '--no-commit', '--no-ff', 'side'], { cwd: s.repo });
  write(s.repo, 'resolved.txt', `${SECRET_TERM}\n`); execFileSync('git', ['add', '-A'], { cwd: s.repo }); execFileSync('git', ['commit', '-q', '-m', 'Merge side'], { cwd: s.repo });
  refused(s.push('merged'), /resolved\.txt:1/, 'private-list term');
});

test('a late NUL byte in one file does not hide a private term in another', t => {
  const s = scratch(t);
  write(s.repo, 'a-binaryish.txt', `${'x'.repeat(9000)}\0tail\n`); write(s.repo, 'b.txt', `${SECRET_TERM}\n`);
  execFileSync('git', ['add', '-A'], { cwd: s.repo });
  const { status, stderr } = spawnSync(process.execPath, ['scripts/leak-check.mjs', 'tree'], { cwd: s.repo, encoding: 'utf8' });
  assert.notEqual(status, 0); assert.match(stderr, /b\.txt:1/);
});

test('a new branch is measured against what the remote advertises, not a stale remote-tracking ref', t => {
  const s = scratch(t);
  commit(s, 'private-history', { 'priv.txt': `${SECRET_TERM}\n` });
  // A tracking ref that claims the remote already has the private commit, as one left from another remote would.
  execFileSync('git', ['update-ref', 'refs/remotes/origin/stale', 'HEAD'], { cwd: s.repo });
  refused(s.push('private-history'), /priv\.txt:1/, 'private-list term');
});

test('added lines that look like diff markers are still scanned, next to removed ones', t => {
  const s = scratch(t);
  write(s.repo, 'tricky.txt', 'keep\n-- old dash\n++ old plus\n--- three\nend');
  execFileSync('git', ['add', '-A'], { cwd: s.repo }); execFileSync('git', ['commit', '-q', '-m', 'Base'], { cwd: s.repo });
  assert.equal(run(s.repo, 'push', '-q', 'origin', 'main').status, 0);
  execFileSync('git', ['checkout', '-q', '-b', 'tricky'], { cwd: s.repo });
  write(s.repo, 'tricky.txt', `keep\n++ new plus\n+++ ${SECRET_TERM}\n--- three\nend\nmore`);
  execFileSync('git', ['commit', '-q', '-am', 'Change'], { cwd: s.repo });
  refused(s.push('tricky'), /tricky\.txt:3/, 'private-list term');
});

test('a first push to an empty remote scans the whole history', t => {
  const s = scratch(t);
  const empty = join(dirname(s.repo), 'empty.git');
  execFileSync('git', ['init', '-q', '--bare', empty]);
  execFileSync('git', ['remote', 'add', 'second', empty], { cwd: s.repo });
  execFileSync('git', ['checkout', '-q', '-b', 'old-term', 'main'], { cwd: s.repo });
  write(s.repo, 'old.txt', `${SECRET_TERM}\n`); execFileSync('git', ['add', '-A'], { cwd: s.repo }); execFileSync('git', ['commit', '-q', '-m', 'Old'], { cwd: s.repo });
  write(s.repo, 'old.txt', 'gone\n'); execFileSync('git', ['commit', '-q', '-am', 'Newer'], { cwd: s.repo });
  refused(run(s.repo, 'push', '-q', 'second', 'old-term'), /old\.txt:1/, 'private-list term');
});
