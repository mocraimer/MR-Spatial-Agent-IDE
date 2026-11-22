/**
 * Levels and level agents on the bench: the overview's helper and each project's agent are found
 * once, started beside speech, never sent words they cannot take, and come back after Herdr
 * restarts. The programs in the seats are stand-ins; the code that finds and starts them is real.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { HerdrBench, type BenchWorkspace } from '../bench/bench.js';
import { OVERVIEW, serveCloseRequests } from '../bridge/agents.js';
import { Bridge, type Transcriber } from '../bridge/bridge.js';
import { compiled } from '../bridge/config.js';
import { DEFAULT_MIRROR, Mirror } from '../bridge/mirror.js';
import { plain } from '../shared/ansi.js';
import { currentProject } from '../shared/messages.js';
import { benchAgents, type StandinAgentOptions } from './fixture.js';

class Heard implements Transcriber {
  readonly queue: string[] = [];
  state() { return { ready: true as const }; }
  async transcribe(): Promise<string> { return this.queue.shift() ?? ''; }
}
const audio = new Float32Array(1600);
let seq = 0;

const LAYOUT: BenchWorkspace[] = [
  { label: 'alpha', panes: [{ name: 'a1', kind: 'agent' }, { name: 'a2', kind: 'agent' }] },
  { label: 'beta', panes: [{ name: 'b1', kind: 'agent' }, { name: 'bsh', kind: 'shell' }] },
];

async function setup(layout = LAYOUT, standin: StandinAgentOptions = {}, closeAnswerMs = 400) {
  const bench = await HerdrBench.start(layout);
  const data = mkdtempSync('/tmp/svl-');
  const mirror = new Mirror(bench.client, DEFAULT_MIRROR);
  const speech = new Heard();
  const agents = benchAgents(bench, data, standin);
  const bridge = new Bridge(bench.client, mirror, speech, agents, closeAnswerMs);
  mirror.start();
  await bench.waitFor(async () => mirror.shelf().sessions.length === layout.flatMap(w => w.panes).length, 'the mirror to see every session');
  const snap = () => bench.client.snapshot();
  const say = async (text: string, receiver: string | null = mirror.shelf().focusedId) => { speech.queue.push(text); return await bridge.utterance(`u${++seq}`, audio, receiver); };
  /** Level-agent seats per workspace label. */
  const seats = async () => {
    const s = await snap();
    return s.panes.filter(p => p.label === 'helper' || p.label === 'project agent').map(p => [s.workspaces.find(w => w.id === p.workspaceId)?.label, p.label]);
  };
  const text = async (id: string) => plain(await bench.client.read(id, 80));
  const received = async () => {
    const out: string[] = [];
    for (const p of (await snap()).panes) if ((await text(p.id)).includes('received:')) out.push(p.id);
    return out;
  };
  const focused = async () => (await snap()).focusedPaneId;
  return {
    bench, data, mirror, speech, agents, bridge, say, seats, text, received, focused, snap,
    stop: async () => { mirror.stop(); await bench.stop(); rmSync(data, { recursive: true, force: true }); },
  };
}

const ws = (s: Awaited<ReturnType<typeof setup>>, label: string) => s.bench.workspaces.get(label) as string;

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

function tool(s: Awaited<ReturnType<typeof setup>>, paneId: string, workspaceId: string, args: string[], extra: Record<string, string> = {}): Promise<{ status: number; out: string }> {
  return new Promise(resolve => {
    execFile('node', [compiled('bridge', 'level-tool.js'), ...args], {
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', HERDR_SOCKET_PATH: s.bench.socketPath, HERDR_WORKSPACE_ID: workspaceId, HERDR_PANE_ID: paneId, ...extra },
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
    await s.bridge.act({ kind: 'confirm-close', answer: true });
    assert.equal((await yes).status, 0);
    assert.equal((await s.snap()).panes.some(p => p.id === made?.id), false);
  } finally { await new Promise(resolve => server.close(resolve)); await s.stop(); }
});
