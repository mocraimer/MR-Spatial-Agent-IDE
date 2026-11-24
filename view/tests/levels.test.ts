/**
 * Levels and level agents on the bench: the overview's helper and each project's agent are found
 * once, started beside speech, never sent words they cannot take, and come back after Herdr
 * restarts. The programs in the seats are stand-ins; the code that finds and starts them is real.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { BenchWorkspace } from '../bench/bench.js';
import { AGENT_NAME_RULE, agentName } from '../bridge/agent-name.js';
import { claudeAgents, HerdrLevelAgents, OVERVIEW, serveCloseRequests } from '../bridge/agents.js';
import { compiled } from '../bridge/config.js';
import type { HerdrClient } from '../bridge/herdr.js';
import { Settings } from '../bridge/settings.js';
import { currentProject } from '../shared/messages.js';
import { setup as deskSetup, type Desk } from './desk.js';
import type { StandinAgentOptions } from './fixture.js';

const LAYOUT: BenchWorkspace[] = [
  { label: 'alpha', panes: [{ name: 'a1', kind: 'agent' }, { name: 'a2', kind: 'agent' }] },
  { label: 'beta', panes: [{ name: 'b1', kind: 'agent' }, { name: 'bsh', kind: 'shell' }] },
];

/** Direct sending is on here: these tests are about which session a prompt reaches, and a draft would only add a "go". */
const direct = (on = true) => { const settings = new Settings(); settings.setDirect(on); return settings; };
const setup = (layout = LAYOUT, standin: StandinAgentOptions = {}, closeAnswerMs = 400, path: string[] = []) => deskSetup(layout, { standin, closeAnswerMs, path, settings: direct() });

const ws = (s: Desk, label: string) => s.bench.workspaces.get(label) as string;

test('the helper is one, whatever state Herdr is in: none yet, a workspace of its name, closed by hand, after a restart', async () => {
  // A Herdr with a workspace labelled "helper" holding sessions of no project, and no helper agent.
  const s = await setup([...LAYOUT, { label: 'helper', panes: [{ name: 'post', kind: 'agent' }] }]);
  try {
    const helperCount = async () => (await s.snap()).workspaces.filter(w => w.label === 'helper').length;
    const first = await s.agents.seat(OVERVIEW);
    await s.agents.ready(first.paneId);
    assert.equal(await helperCount(), 1, 'the existing helper workspace is used, not a second one');
    assert.deepEqual(await s.seats(), [['helper', 'helper']]);
    assert.equal((await s.snap()).panes.some(p => p.id === s.bench.pane('post')), true, 'the sessions kept there stay as they are');

    // An order to the helper reaches it; a second seat is never made.
    const u = await s.say('helper, count the files');
    assert.equal(u.ok, true, u.outcome);
    await s.bench.waitFor(async () => (await s.text(first.paneId)).includes('received: count the files'), 'the order at the helper');

    // Closed by hand: the next order makes its seat again, in the same workspace, and starts it.
    await s.bench.client.call('pane.close', { pane_id: first.paneId });
    await s.bench.waitFor(async () => !(await s.snap()).panes.some(p => p.id === first.paneId), 'the helper to close');
    await s.say('helper, how many sessions');
    const remade = await s.agents.seat(OVERVIEW);
    await s.bench.waitFor(async () => (await s.text(remade.paneId)).includes('received: how many sessions'), 'the order at the new helper', 20_000);
    assert.equal(await helperCount(), 1);
    assert.deepEqual(await s.seats(), [['helper', 'helper']]);

    // Herdr stopped and started: the seat comes back by its label, the agent is started in it again.
    await s.bench.stopServer();
    await s.bench.startServer();
    await s.bench.waitFor(async () => s.mirror.shelf().herdr.state === 'up' && s.mirror.shelf().sessions.length > 0, 'the mirror to reconnect', 20_000);
    const again = await s.agents.seat(OVERVIEW);
    assert.equal(again.paneId, remade.paneId, 'the same seat');
    await s.agents.ready(again.paneId);
    assert.equal(await helperCount(), 1);
    assert.deepEqual(await s.seats(), [['helper', 'helper']]);
  } finally { await s.stop(); }
});

test('going into a project puts its one agent in front, every time, and sends nothing to any session', async () => {
  const s = await setup();
  try {
    await s.bench.client.call('pane.focus', { pane_id: s.bench.pane('a1') });
    // Two goes close together still make one seat.
    const [r1, r2] = await Promise.all([s.bridge.act({ kind: 'go', projectId: ws(s, 'beta') }), s.bridge.act({ kind: 'go', projectId: ws(s, 'beta') })]);
    assert.equal(r1.ok && r2.ok, true, `${r1.outcome} / ${r2.outcome}`);
    assert.deepEqual(await s.seats(), [['beta', 'project agent']]);
    const seat = (await s.snap()).panes.find(p => p.label === 'project agent')?.id as string;
    assert.equal(await s.focused(), seat, 'the project agent is in front');
    await s.agents.ready(seat);
    assert.equal(currentProject(s.bridge.shelf()), ws(s, 'beta'));

    // A task brought forward, elsewhere and back: going in brings the agent again, not the task.
    await s.bridge.act({ kind: 'focus', sessionId: s.bench.pane('b1') });
    await s.bridge.act({ kind: 'go', projectId: ws(s, 'alpha') });
    await s.bridge.act({ kind: 'go', projectId: ws(s, 'beta') });
    assert.equal(await s.focused(), seat);
    assert.deepEqual((await s.seats()).sort(), [['alpha', 'project agent'], ['beta', 'project agent']]);
    for (const id of (await s.snap()).panes.filter(p => p.label === 'project agent').map(p => p.id)) await s.agents.ready(id);

    // Spoken: "go to" a project and "overview".
    assert.equal((await s.say('go to alpha')).ok, true);
    const front = await s.focused();
    assert.equal((await s.snap()).panes.find(p => p.id === front)?.label, 'project agent');
    assert.equal(currentProject(s.bridge.shelf()), ws(s, 'alpha'));
    assert.equal((await s.say('overview')).ok, true);
    await s.bench.waitFor(async () => currentProject(s.bridge.shelf()) === null, 'the overview in front');

    assert.deepEqual(await s.received(), [], 'going in and out sent nothing to any session, agents included');
  } finally { await s.stop(); }
});

test('a starting agent holds up no other utterance, and words it cannot take go nowhere', async () => {
  const s = await setup(LAYOUT, { delayMs: 3000 });
  try {
    await s.bench.client.call('pane.focus', { pane_id: s.bench.pane('a1') });
    const t0 = Date.now();
    const order = await s.say('helper, count the files');
    assert.equal(order.ok, true, order.outcome);
    assert.match(order.outcome, /starting/);
    // Meanwhile a prompt to a task and a command are carried out at once.
    const prompt = await s.say('summarize the change');
    assert.equal(prompt.outcome, 'Sent to a1');
    const go = await s.say('go to beta');
    assert.equal(go.ok, true, go.outcome);
    assert.ok(Date.now() - t0 < 2500, `${Date.now() - t0} ms: nothing waited for the 3 s start`);
    // The agent in front is still starting: a prompt to it is not typed into its shell.
    const seat = await s.focused() as string;
    const early = await s.say('what is waiting here');
    assert.equal(early.ok, false);
    assert.match(early.outcome, /still starting/);
    const key = await s.bridge.act({ kind: 'key', key: 'enter' });
    assert.equal(key.ok, false, key.outcome);
    await s.agents.ready(seat);
    assert.equal((await s.text(seat)).includes('what is waiting here'), false, 'the words never reached its shell');
    // The held order reaches the helper once it is ready.
    const helper = (await s.agents.seat(OVERVIEW)).paneId;
    await s.bench.waitFor(async () => (await s.text(helper)).includes('received: count the files'), 'the held order at the helper', 15_000);
    // A "go to" that matches nothing goes nowhere.
    const before = await s.received();
    const nowhere = await s.say('go to nowhere at all');
    assert.equal(nowhere.ok, false);
    assert.match(nowhere.outcome, /Nothing was sent/);
    assert.deepEqual(await s.received(), before);
  } finally { await s.stop(); }
});

test('a failed start says so and how to retry; going in again retries', async () => {
  const standin: StandinAgentOptions = { fail: 'no such program' };
  const s = await setup(LAYOUT, standin);
  try {
    await s.bridge.act({ kind: 'go', projectId: ws(s, 'alpha') });
    const seat = await s.focused() as string;
    await s.agents.ready(seat).catch(() => undefined);
    const failed = s.bridge.shelf().failed.find(f => f.id === seat);
    assert.match(failed?.reason ?? '', /did not start.*Go to it again/);
    const words = await s.say('what is waiting here');
    assert.equal(words.ok, false);
    assert.match(words.outcome, /not running/);
    // Keys, by hand or spoken, are not typed into the empty shell either.
    const key = await s.bridge.act({ kind: 'key', key: 'enter' });
    assert.equal(key.ok, false, key.outcome);
    assert.equal((await s.say('press yes')).ok, false);
    assert.equal((await s.text(seat)).includes('what is waiting'), false);
    delete standin.fail;
    await s.bridge.act({ kind: 'go', projectId: ws(s, 'alpha') });
    await s.agents.ready(seat);
    assert.equal(s.bridge.shelf().failed.length, 0);
    assert.deepEqual(await s.seats(), [['alpha', 'project agent']], 'the retry used the same seat');
  } finally { await s.stop(); }
});

test('a prompt keeps the receiver it had when speech began, across a "go to"', async () => {
  const s = await setup();
  try {
    await s.bench.client.call('pane.focus', { pane_id: s.bench.pane('a1') });
    const receiver = s.bench.pane('a1');
    await s.bridge.act({ kind: 'go', projectId: ws(s, 'beta') });
    const u = await s.say('summarize the change', receiver);
    assert.equal(u.outcome, 'Sent to a1');
    await s.bench.waitFor(async () => (await s.text(receiver)).includes('received: summarize the change'), 'the prompt at a1');
  } finally { await s.stop(); }
});

function tool(s: Desk, paneId: string, workspaceId: string, args: string[], extra: Record<string, string> = {}): Promise<{ status: number; out: string }> {
  return new Promise(resolve => {
    execFile('node', [compiled('bridge', 'level-tool.js'), ...args], {
      // VIEW_DATA keeps the tool's fallbacks (the bridge's socket, its log) inside the test's own directory, never the owner's.
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', VIEW_DATA: s.data, HERDR_SOCKET_PATH: s.bench.socketPath, HERDR_WORKSPACE_ID: workspaceId, HERDR_PANE_ID: paneId, ...extra },
    }, (error, stdout, stderr) => resolve({ status: error ? Number(error.code ?? 1) : 0, out: stdout + stderr }));
  });
}

test('the project agent\'s tool keeps to its project, never moves the front, and closes only on the owner\'s yes', async () => {
  const s = await setup(LAYOUT, {}, 3000);
  let waiting = false;
  s.bridge.connect(event => { if (event.type === 'confirm') waiting = event.pending !== null; });
  const socket = join(s.data, 'helper.sock');
  const server = serveCloseRequests(socket, ref => s.bridge.requestClose(ref));
  try {
    await s.bench.client.call('pane.focus', { pane_id: s.bench.pane('b1') });
    const me = s.bench.pane('a2');
    const alpha = ws(s, 'alpha');
    const list = await tool(s, me, alpha, ['sessions']);
    assert.equal(list.status, 0, list.out);
    assert.match(list.out, new RegExp(s.bench.pane('a1')));
    assert.doesNotMatch(list.out, new RegExp(s.bench.pane('b1')), 'no session of another project');

    const other = await tool(s, me, alpha, ['prompt', s.bench.pane('b1'), 'hello']);
    assert.notEqual(other.status, 0, 'a session of another project is refused');
    assert.equal((await s.text(s.bench.pane('b1'))).includes('hello'), false);
    assert.notEqual((await tool(s, me, alpha, ['read', s.bench.pane('b1')])).status, 0);

    const prompt = await tool(s, me, alpha, ['prompt', s.bench.pane('a1'), 'run the tests']);
    assert.equal(prompt.status, 0, prompt.out);
    await s.bench.waitFor(async () => (await s.text(s.bench.pane('a1'))).includes('received: run the tests'), 'the prompt at a1');

    const started = await tool(s, me, alpha, ['start', 'shell', 'logs']);
    assert.equal(started.status, 0, started.out);
    const snap = await s.snap();
    const made = snap.panes.find(p => p.label === 'logs');
    assert.equal(made?.workspaceId, alpha, 'started in its own project');
    assert.equal(snap.focusedPaneId, s.bench.pane('b1'), 'what is in front did not move');

    // Ending a shell is closing it: refused; a close asks the owner, also when the pane lost its socket variable.
    const exit = await tool(s, me, alpha, ['prompt', made?.id as string, 'exit']);
    assert.notEqual(exit.status, 0, exit.out);
    const noAnswer = await tool(s, me, alpha, ['close', made?.id as string], { VIEW_DATA: s.data });
    assert.notEqual(noAnswer.status, 0);
    assert.match(noAnswer.out, /did not answer/);
    assert.equal((await s.snap()).panes.some(p => p.id === made?.id), true, 'no answer leaves it open');
    const yes = tool(s, me, alpha, ['close', made?.id as string], { VIEW_DATA: s.data });
    await s.bench.waitFor(async () => waiting, 'the close to be put to the owner');
    await s.bridge.act({ kind: 'answer', answer: true });
    assert.equal((await yes).status, 0);
    assert.equal((await s.snap()).panes.some(p => p.id === made?.id), false);
  } finally { await new Promise(resolve => server.close(resolve)); await s.stop(); }
});

test('every agent name the view makes meets Herdr\'s rule, for any label or pane id, and no two are alike', () => {
  const labels = ['project agent', 'helper', 'Flaky Test', 'Ünïcode — dash/slash', 'a'.repeat(80), '', '   ', '12 monkeys', 'x'];
  const ids = ['w1:p2', 'wW:p2', 'ww:p2', 'WW:P2', 'w12:p345', 'w1:p2'.repeat(10), ''];
  const names = new Set<string>();
  for (const label of labels) for (const id of ids) {
    const name = agentName(label, id);
    assert.match(name, AGENT_NAME_RULE, `${JSON.stringify(label)} + ${JSON.stringify(id)} -> ${name}`);
    names.add(name);
  }
  assert.equal(names.size, labels.length * ids.length, 'distinct inputs give distinct names');
  assert.notEqual(agentName('project agent', 'wW:p2'), agentName('project agent', 'ww:p2'), 'ids that differ only in capitals');
});

test('a project agent started in a pane whose id has capitals is started under a name Herdr accepts', async () => {
  // Herdr refused "project-agent-wW-p2". The bench's Herdr only makes lower-case ids, so a stand-in
  // for Herdr's socket answers with the owner's kind of id and holds the rule Herdr states.
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const herdr = {
    snapshot: async () => ({ workspaces: [{ id: 'wW', label: 'Alpha Project' }], panes: [{ id: 'wW:p1', workspaceId: 'wW', tabId: 'wW:t1', agent: null, status: 'unknown', label: null, title: null, cwd: '/tmp' }], focusedPaneId: 'wW:p1' }),
    call: async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      if (method === 'tab.create') return { root_pane: { pane_id: 'wW:p2' } };
      if (method === 'agent.start' && !AGENT_NAME_RULE.test(String(params.name))) throw Object.assign(new Error('agent name must start with a lowercase letter'), { code: 'invalid_agent_name' });
      return {};
    },
  } as unknown as HerdrClient;
  const data = mkdtempSync('/tmp/svn-');
  try {
    const agents = new HerdrLevelAgents(herdr, claudeAgents(data), join(data, 'helper.sock'));
    const seat = await agents.seat({ project: 'wW' });
    await agents.ready(seat.paneId);
    assert.equal(seat.paneId, 'wW:p2');
    assert.equal(calls.filter(c => c.method === 'agent.start').length, 1);
    assert.deepEqual(agents.pending(), { starting: [], failed: [] });
  } finally { rmSync(data, { recursive: true, force: true }); }
});

test('the level tool starts an agent under a name Herdr accepts, whatever the owner calls it', async () => {
  // A program named claude on the bench's PATH stands in for Claude Code; Herdr starts it for real.
  const bin = mkdtempSync('/tmp/svb-bin-');
  writeFileSync(join(bin, 'claude'), `#!/bin/sh\nexec node ${compiled('bench', 'standin.js')} --name started --agent claude\n`);
  chmodSync(join(bin, 'claude'), 0o755);
  const s = await setup(LAYOUT, {}, 400, [bin]);
  try {
    const alpha = ws(s, 'alpha');
    const me = s.bench.pane('a2');
    for (const name of ['Flaky Test Runner With A Very Long Name Indeed', 'logs']) {
      const started = await tool(s, me, alpha, ['start', 'claude', name]);
      assert.equal(started.status, 0, started.out);
      const made = (await s.snap()).panes.find(p => p.label === name);
      assert.ok(made, `a session named ${name}`);
      await s.bench.waitFor(async () => (await s.snap()).panes.some(p => p.id === made.id && p.agent !== null), `the agent in ${name}`);
    }
    const bare = await tool(s, me, alpha, ['start', 'claude']);
    assert.equal(bare.status, 0, `an agent with no name of its own: ${bare.out}`);
  } finally { await s.stop(); rmSync(bin, { recursive: true, force: true }); }
});

test('AC-10.1: level-tool view opens a tab whose pane carries the right label for each viewer kind', async () => {
  // "view changes" → 'changes'; "view diff" → 'diff'; "view pr N" → 'pr N';
  // "view file path/name.ts" → 'view name.ts'; "view md path/doc.md" → 'view doc.md'.
  const s = await setup();
  try {
    const me = s.bench.pane('a1');
    const alpha = ws(s, 'alpha');
    const cases: Array<[string[], string]> = [
      [['view', 'changes'], 'changes'],
      [['view', 'diff'], 'diff'],
      [['view', 'pr', '42'], 'pr 42'],
      [['view', 'file', 'src/foo.ts'], 'view foo.ts'],
      [['view', 'md', 'docs/guide.md'], 'view guide.md'],
    ];
    for (const [args, expectedLabel] of cases) {
      const r = await tool(s, me, alpha, args);
      assert.equal(r.status, 0, `${args.join(' ')}: ${r.out}`);
      const pane = (await s.snap()).panes.find(p => p.label === expectedLabel);
      assert.ok(pane, `${args.join(' ')}: pane labelled "${expectedLabel}" found`);
      assert.equal(pane?.workspaceId, alpha, `${args.join(' ')}: opened in its own project`);
      // Clean up so the workspace does not fill with panes.
      await s.bench.client.call('pane.close', { pane_id: pane?.id as string });
    }
  } finally { await s.stop(); }
});
