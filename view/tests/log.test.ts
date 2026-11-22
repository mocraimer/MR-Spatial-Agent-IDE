/**
 * The view's log: what failed, for which session or project and why, in the terminal and in a
 * file that outlasts it, bounded in size. Each case is brought about on the bench.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { compiled } from '../bridge/config.js';
import { fileLog, LOG_FILE } from '../bridge/log.js';
import { benchAgents, rig, type Rig } from './fixture.js';
import type { StandinAgentOptions } from './fixture.js';

const LAYOUT = [{ label: 'alpha', panes: [{ name: 'a1', kind: 'agent' as const }, { name: 'sh', kind: 'shell' as const }] }];

const file = (r: Rig) => (existsSync(join(r.data, LOG_FILE)) ? readFileSync(join(r.data, LOG_FILE), 'utf8') : '');
/** A line in both the terminal and the file, found by its words. */
function bothHold(r: Rig, ...words: RegExp[]): void {
  for (const where of [{ name: 'terminal', text: r.logs.join('\n') }, { name: 'log file', text: file(r) }]) {
    for (const w of words) assert.match(where.text, w, `${where.name} holds ${w}`);
  }
  const line = r.logs.find(l => words.every(w => w.test(l)));
  assert.ok(line, `one terminal line holds all of ${words.join(' ')}`);
  assert.ok(file(r).split('\n').some(l => l.endsWith(` ${line}`)), 'the same line is in the file');
}
const wait = (r: Rig, what: string, check: () => boolean) => r.bench.waitFor(async () => check(), what, 20_000);

async function goTo(r: Rig, project: string): Promise<string> {
  const id = r.bench.workspaces.get(project) as string;
  await wait(r, 'the shelf to list the project', () => r.view.bridge.shelf().projects.some(p => p.id === id));
  const seat = await r.view.bridge.act({ kind: 'go', projectId: id });
  assert.equal(seat.ok, true, seat.outcome);
  return id;
}

test('an agent start that fails, and one that asks something, are logged with the project and the reason', async () => {
  const standin: StandinAgentOptions = { fail: 'no such program' };
  const r = await rig(LAYOUT, (bench, data) => ({ agents: benchAgents(bench, data, standin) }));
  try {
    await goTo(r, 'alpha');
    await wait(r, 'the failure to be logged', () => r.logs.some(l => /did not start/.test(l)));
    bothHold(r, /the project agent of alpha/, /did not start/, /no such program/, /Go to it again to retry/);

    delete standin.fail;
    standin.ask = true;
    await goTo(r, 'alpha');
    await wait(r, 'the question to be logged', () => r.logs.some(l => /asks something/.test(l)));
    bothHold(r, /the project agent of alpha/, /asks something as it starts/);
  } finally { await r.stop(); }
});

test('a start that works is logged as starting and as started', async () => {
  const r = await rig(LAYOUT);
  try {
    await goTo(r, 'alpha');
    await wait(r, 'the start to be logged', () => r.logs.some(l => /\) started$/.test(l)));
    bothHold(r, /the project agent of alpha \(w1:p\d+\) is starting/);
    bothHold(r, /the project agent of alpha \(w1:p\d+\) started/);
  } finally { await r.stop(); }
});

test('a Herdr error on an action is logged with the action and Herdr\'s words', async () => {
  const r = await rig(LAYOUT);
  try {
    const sh = r.bench.pane('sh');
    await wait(r, 'the shelf', () => r.view.bridge.shelf().sessions.some(s => s.id === sh));
    await r.bench.stopServer();
    const refused = await r.view.bridge.act({ kind: 'focus', sessionId: sh });
    assert.equal(refused.ok, false);
    bothHold(r, /Herdr refused the focus action/, /not reachable|closed the connection|did not answer/);
  } finally { await r.stop(); }
});

test('a close asked for and its answer, yes or no, are logged by session name', async () => {
  const r = await rig(LAYOUT);
  try {
    await wait(r, 'the shelf', () => r.view.bridge.shelf().sessions.length === 2);
    const no = r.view.bridge.requestClose('sh');
    await r.view.bridge.act({ kind: 'answer', answer: false });
    assert.equal(await no, 'declined');
    bothHold(r, /close of 2 sh \(alpha\)/, /asked of the owner/);
    bothHold(r, /close of 2 sh \(alpha\).*the owner said no; it stays open/);
    const yes = r.view.bridge.requestClose('sh');
    await r.view.bridge.act({ kind: 'answer', answer: true });
    assert.equal(await yes, 'closed');
    bothHold(r, /closed 2 sh \(alpha\).*on the owner's yes/);
  } finally { await r.stop(); }
});

test('a session the project agent could not start is logged, through the bridge', async () => {
  const r = await rig(LAYOUT);
  try {
    const alpha = r.bench.workspaces.get('alpha') as string;
    const me = r.bench.pane('a1');
    const out = await new Promise<string>(resolve => {
      execFile('node', [compiled('bridge', 'level-tool.js'), 'start', 'no-such-agent-kind', 'doomed'], {
        env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', HERDR_SOCKET_PATH: r.bench.socketPath, HERDR_WORKSPACE_ID: alpha, HERDR_PANE_ID: me, VIEW_DATA: r.data },
      }, (_error, stdout, stderr) => resolve(stdout + stderr));
    });
    assert.match(out, /did not start/);
    bothHold(r, /a project agent in /, /no-such-agent-kind agent did not start/);
  } finally { await r.stop(); }
});

test('the log file stays under its size, with one older file beside it, and says once when it cannot be written', () => {
  const dir = mkdtempSync('/tmp/svlog-');
  try {
    const printed: string[] = [];
    const log = fileLog(dir, line => printed.push(line), 2000);
    for (let i = 0; i < 200; i += 1) log(`line number ${i} with some words in it`);
    assert.equal(printed.length, 200, 'every line shows in the terminal');
    assert.ok(statSync(join(dir, LOG_FILE)).size <= 2000, 'the file is bounded');
    assert.ok(existsSync(join(dir, `${LOG_FILE}.1`)), 'the earlier lines sit in the older file');
    assert.match(readFileSync(join(dir, LOG_FILE), 'utf8'), /line number 199 with some words in it\n$/, 'the newest line is last');

    const blocked = fileLog(join(dir, LOG_FILE, 'not-a-directory'), line => printed.push(line));
    blocked('first'); blocked('second');
    assert.equal(printed.filter(l => /cannot be written/.test(l)).length, 1, 'said once');
    assert.ok(printed.includes('second'), 'the terminal still has every line');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
