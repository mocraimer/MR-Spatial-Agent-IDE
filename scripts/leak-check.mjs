// Refuses private values before they leave the machine, and lets CI check the public copy.
//
//   node scripts/leak-check.mjs tree                       tracked files of the working tree, and their names
//   node scripts/leak-check.mjs range <git rev-list args>  commit messages, file names and added lines
//   node scripts/leak-check.mjs pre-push <remote>          git's pre-push hook (reads the refs from stdin)
//
// It always looks for private-key blocks, token-shaped strings and email addresses outside the
// allow list. If `git config leakcheck.privateList` names a file, it also looks for every
// pattern in it: one basic regular expression per line (grep's own syntax), matched ignoring
// case; blank lines and lines starting with # are skipped. The list stays outside the repository.
// Binary files (a NUL in their first 8000 bytes) are not scanned, only their names. A hit is reported by place and kind, never by value; a file name that is a hit is shown by its
// number in the listing the report names. Exit 0 clean, 1 hits, 2 cannot check.
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import process from 'node:process';

const SHAPES = [
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,}|sk-(?:ant-)?[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|xox[abprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35})/],
];
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
const ALLOWED_EMAIL = [/@example\.(?:com|org|invalid)$/i, /@users\.noreply\.github\.com$/i, /^noreply@anthropic\.com$/i];
const MAX_REPORTED = 40;

class Refusal extends Error {}
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 1 << 30 });
const lines = text => text.split(/\r?\n/);

function privatePatterns() {
  let configured;
  try { configured = git('config', '--get', 'leakcheck.privateList').trim(); } catch { configured = ''; }
  if (!configured) {
    process.stderr.write('leak-check: the private list is not set (git config leakcheck.privateList <file>); checking generic shapes only.\n');
    return [];
  }
  const path = configured.replace(/^~(?=\/|$)/, homedir());
  let text;
  try { text = readFileSync(path, 'utf8'); } catch { throw new Refusal(`the private list ${configured} cannot be read; fix leakcheck.privateList or restore the file.`); }
  return lines(text).filter(line => line.trim() && !line.startsWith('#'));
}

/** Every place to look is one line of text and a label for where it came from. */
function treeUnits() {
  const units = [];
  git('ls-files', '-z').split('\0').filter(Boolean).forEach((name, index) => {
    units.push({ where: `file name no. ${index + 1} of git ls-files`, text: name });
    let content;
    try { content = readFileSync(name); } catch { return; }
    if (content.subarray(0, 8000).includes(0)) return;
    lines(content.toString('utf8')).forEach((text, line) => units.push({ where: `${name}:${line + 1}`, text }));
  });
  return units;
}

function rangeUnits(revs) {
  const units = [];
  for (const record of git('log', '-z', '--format=%H%n%B', ...revs).split('\0').filter(Boolean)) {
    const [sha, ...message] = lines(record);
    for (const text of message) units.push({ where: `commit ${sha.slice(0, 10)} message`, text });
  }
  let sha = '', file = '', names = 0, old = 0, added = 0, number = 0;
  const diff = git('log', '-p', '-U0', '--no-color', '--no-ext-diff', '--no-renames', '--diff-merges=first-parent', '--format=@@commit %H', ...revs);
  for (const line of lines(diff)) {
    if (old > 0 && line.startsWith('-')) old--;
    else if (added > 0 && line.startsWith('+')) { added--; units.push({ where: `commit ${sha.slice(0, 10)} ${file}:${number++}`, text: line.slice(1) }); }
    else if (line.startsWith('@@commit ')) { sha = line.slice(9); names = 0; }
    else if (line.startsWith('diff --git ')) {
      file = line.slice(line.lastIndexOf(' b/') + 3);
      units.push({ where: `commit ${sha.slice(0, 10)} file name no. ${++names} of git show --name-only`, text: file });
    } else {
      const hunk = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (hunk) { old = Number(hunk[1] ?? 1); number = Number(hunk[2]); added = Number(hunk[3] ?? 1); }
    }
  }
  return units;
}

function findHits(units, patterns) {
  const hits = [];
  units.forEach(({ where, text }) => {
    for (const [kind, shape] of SHAPES) if (shape.test(text)) hits.push({ where, kind });
    if ([...text.matchAll(EMAIL)].some(([address]) => !ALLOWED_EMAIL.some(allowed => allowed.test(address)))) hits.push({ where, kind: 'email address' });
  });
  if (patterns.length) {
    // One grep over all the text; only its line numbers are read, so no matched value is ever held.
    const found = spawnSync('grep', ['-a', '-n', '-i', ...patterns.flatMap(pattern => ['-e', pattern])], { input: units.map(unit => unit.text.replaceAll('\n', ' ')).join('\n'), encoding: 'utf8', maxBuffer: 1 << 30 });
    if (found.status === 2 || found.error) throw new Refusal('the private list holds a pattern grep cannot read; fix the list.');
    for (const match of found.stdout.matchAll(/^(\d+):/gm)) hits.push({ where: units[Number(match[1]) - 1].where, kind: 'private-list term' });
  }
  return hits;
}

function report(hits) {
  const seen = [...new Set(hits.map(hit => `${hit.where}: ${hit.kind}`))];
  if (!seen.length) return 0;
  process.stderr.write(`leak-check: refused, ${seen.length} hit${seen.length === 1 ? '' : 's'} (places and kinds only; open the place to see the value; for a commit message, amend the commit or rewrite the branch before pushing):\n`);
  for (const line of seen.slice(0, MAX_REPORTED)) process.stderr.write(`  ${line}\n`);
  if (seen.length > MAX_REPORTED) process.stderr.write(`  ...and ${seen.length - MAX_REPORTED} more\n`);
  return 1;
}

const known = sha => { try { execFileSync('git', ['cat-file', '-e', `${sha}^{commit}`], { stdio: 'ignore' }); return true; } catch { return false; } };

/**
 * One rev list per pushed ref: what the remote lacks. A new ref is measured against what the remote
 * advertises, not against local remote-tracking refs, which can be stale or left from another remote.
 * Anything that cannot be measured is scanned whole.
 */
function prePushRevs(remote, input) {
  let advertised = [];
  try { advertised = git('ls-remote', '--refs', remote).split('\n').map(line => line.split('\t')[0]).filter(sha => sha && known(sha)); } catch { /* scan whole */ }
  const revs = [];
  for (const line of lines(input).filter(Boolean)) {
    const [, local, , remoteSha] = line.split(' ');
    if (/^0+$/.test(local)) continue;
    if (!/^0+$/.test(remoteSha) && known(remoteSha)) revs.push([`${remoteSha}..${local}`]);
    else revs.push([local, ...(advertised.length ? ['--not', ...advertised] : [])]);
  }
  return revs;
}

function main([mode, ...rest]) {
  const patterns = privatePatterns();
  if (mode === 'tree') return report(findHits(treeUnits(), patterns));
  if (mode === 'range' && rest.length) return report(findHits(rangeUnits(rest), patterns));
  if (mode === 'pre-push') {
    const units = prePushRevs(rest[0] ?? '', readFileSync(0, 'utf8')).flatMap(rangeUnits);
    return report(findHits(units, patterns));
  }
  throw new Refusal('usage: leak-check.mjs tree | range <rev-list args> | pre-push <remote> <url>');
}

try { process.exitCode = main(process.argv.slice(2)); } catch (error) {
  process.stderr.write(`leak-check: ${error instanceof Refusal ? error.message : `cannot check: ${error.message}`}\n`);
  process.exitCode = 2;
}
