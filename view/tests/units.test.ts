import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { resolve } from '../bridge/bridge.js';
import { compiled, REPO } from '../bridge/config.js';
import { CLOSE_TOOL } from '../bridge/agents.js';
import { classify } from '../bridge/heard.js';
import { arrange, CHIP_ARC, columnFit } from '../page/layout.js';
import { Mic } from '../page/mic.js';
import { COMMANDS } from '../shared/actions.js';
import type { Session, Shelf } from '../shared/messages.js';

function guard(tool: string, input: Record<string, unknown>): number {
  return spawnSync('node', [compiled('bridge', 'guard.js')], { input: JSON.stringify({ tool_name: tool, tool_input: input }) }).status ?? -1;
}

test('the helper\'s guard refuses every direct close and lets the close tool and ordinary work through', () => {
  const refused: [string, Record<string, unknown>][] = [
    ['Bash', { command: 'herdr pane close w1:p2' }],
    ['Bash', { command: 'herdr tab close w1:t2' }],
    ['Bash', { command: 'herdr workspace close w3' }],
    ['Bash', { command: 'herdr workspace close w3 --group' }],
    ['Bash', { command: `node ${CLOSE_TOOL} logs; herdr pane close w1:p2` }],
    ['Bash', { command: 'python3 -c "import socket; s.send(b\'{\\"method\\":\\"pane.close\\"}\')"' }],
    ['Bash', { command: 'socat - UNIX-CONNECT:$HOME/.config/herdr/herdr.sock' }],
    ['Bash', { command: 'herdr server stop' }],
    ['Bash', { command: 'kill -9 4242' }],
    ['Bash', { command: 'herdr pane send-text w1:p2 "exit"' }],
    ['Write', { file_path: '/tmp/x.js', content: 'call("pane.close", { pane_id })' }],
  ];
  for (const [tool, input] of refused) assert.equal(guard(tool, input), 2, `refused: ${JSON.stringify(input)}`);
  const allowed: [string, Record<string, unknown>][] = [
    ['Bash', { command: `node ${CLOSE_TOOL} w1:p2` }],
    ['Bash', { command: 'herdr tab create --workspace w1 --no-focus' }],
    ['Bash', { command: 'herdr pane rename w1:p2 logs' }],
    ['Bash', { command: 'ls | wc -l' }],
    ['Read', { file_path: '/tmp/notes.md' }],
  ];
  for (const [tool, input] of allowed) assert.equal(guard(tool, input), 0, `allowed: ${JSON.stringify(input)}`);
});

test('an utterance is a command only when the whole of it is one', () => {
  const id = (text: string, confirming = false) => { const h = classify(text, confirming); return h.as === 'command' ? h.command.id : h.as; };
  assert.equal(id('Next waiting.'), 'next');
  assert.equal(id('Back up the database first.'), 'prompt');
  assert.equal(id('Press to'), 'two', 'a spoken number is compared as a digit');
  assert.equal(id('Press 1.'), 'one');
  assert.deepEqual(classify('Show tree.', false), { as: 'show', target: 3 });
  assert.deepEqual(classify('show storefront web', false), { as: 'show', target: 'storefront web' });
  assert.deepEqual(classify('Helper, rename the shell to logs.', false), { as: 'helper', order: 'rename the shell to logs.' });
  assert.deepEqual(classify('Go to storefront web.', false), { as: 'go', target: 'storefront web' });
  assert.deepEqual(classify('go to project infra', false), { as: 'go', target: 'infra' });
  assert.equal(id('Overview.'), 'overview');
  assert.equal(id('Go to the overview'), 'overview');
  assert.equal(id('yes'), 'prompt', 'a yes with no close waiting is an answer to the agent');
  assert.equal(id('Yes.', true), 'confirm');
  assert.equal(id('  '), 'nothing');
});

test('inside a project: its sessions beside the front, every other project a chip, the overview chip first; numbers across all projects', () => {
  const session = (id: string, workspaceId: string, role: Session['role'] = 'task') => ({ id, workspaceId, role, agent: 'claude', status: 'idle' as const, name: id });
  const shelf: Shelf = {
    herdr: { state: 'up' },
    projects: ['w1', 'w2', 'w3', 'ov'].map(id => ({ id, label: id === 'ov' ? 'helper' : `project ${id}` })),
    sessions: [session('w3:p1', 'w3'), session('w1:p1', 'w1'), session('w1:p2', 'w1'), session('w2:p1', 'w2'), session('w2:p2', 'w2', 'project-agent'), session('w2:p3', 'w2'), session('ov:p1', 'ov', 'overview-agent')],
    focusedId: 'w2:p1',
    overviewId: 'ov', starting: [], failed: [],
  };
  const { front, place, columns, chips } = arrange(shelf, [{ session: session('w2:p9', 'w2'), projectId: 'w2', project: 'project w2' }, { session: session('w1:p9', 'w1'), projectId: 'w1', project: 'project w1' }]);
  assert.equal(front?.id, 'w2:p1');
  assert.deepEqual(place, { overview: false, projectId: 'w2', project: 'project w2' });
  assert.deepEqual(columns.map(c => [Math.sign(c.angle), c.tiles.map(t => [t.session.id, t.n])]), [[-1, [['w2:p1', 3], ['w2:p2', 4]]], [1, [['w2:p3', 5], ['w2:p9', 0]]]],
    'only this project\'s sessions; numbers follow project order across all projects; a closed one of this project stays a moment, without a number');
  assert.deepEqual(chips.map(c => [c.project, c.overview, c.sessions.map(s => s.id)]), [['Overview', true, ['ov:p1']], ['project w1', false, ['w1:p1', 'w1:p2']], ['project w3', false, ['w3:p1']]]);
  assert.ok(columnFit(2).width > 0.3, 'tiles inside a project are wider than the 0.30 m tile of the one-shelf view');

  const atOverview = arrange({ ...shelf, focusedId: 'ov:p1' });
  assert.deepEqual(atOverview.place, { overview: true });
  assert.deepEqual(atOverview.columns.flatMap(c => c.tiles.map(t => t.session.id)), ['ov:p1'], 'at the overview, the shelf holds the sessions of no project');
  assert.deepEqual(atOverview.chips.map(c => c.project), ['project w1', 'project w2', 'project w3'], 'every project is a node; the overview\'s own workspace is not one');
});

test('chips and nodes stay within 90 degrees either side, at 7 projects and at 14', () => {
  for (const count of [7, 14]) {
    const projects = Array.from({ length: count }, (_, i) => ({ id: `w${i}`, label: `a rather long project name number ${i}` }));
    const sessions = projects.map(p => ({ id: `${p.id}:p1`, workspaceId: p.id, role: 'task' as const, agent: 'claude', status: 'idle' as const, name: 'x' }));
    for (const focusedId of [null, 'w0:p1']) {
      const { chips } = arrange({ herdr: { state: 'up' }, projects, sessions, focusedId, overviewId: null, starting: [], failed: [] });
      const widest = Math.max(...chips.map(c => Math.abs(c.angle) + (c.width / 2) / CHIP_ARC * 180 / Math.PI));
      assert.ok(widest < 90, `${count} projects, ${focusedId ? 'inside one' : 'at the overview'}: the farthest chip edge is at ${widest.toFixed(1)} degrees`);
    }
  }
});

test('the guard refuses a tool call it cannot read', () => {
  for (const input of ['', 'not json', 'null', '42']) {
    const status = spawnSync('node', [compiled('bridge', 'guard.js')], { input }).status;
    assert.equal(status, 2, `refused: ${JSON.stringify(input)}`);
  }
});

test('a spoken session reference resolves by tile number, name or project', () => {
  const shelf: Shelf = {
    herdr: { state: 'up' },
    projects: [{ id: 'w2', label: 'storefront-web' }, { id: 'w1', label: 'billing' }],
    sessions: [
      { id: 'w1:p1', workspaceId: 'w1', role: 'task', agent: 'claude', status: 'idle', name: 'ledger' },
      { id: 'w2:p1', workspaceId: 'w2', role: 'task', agent: null, status: 'unknown', name: 'logs' },
    ],
    focusedId: null, overviewId: null, starting: [], failed: [],
  };
  assert.equal(resolve(shelf, 1)?.id, 'w2:p1', 'numbers follow project order, not pane order');
  assert.equal(resolve(shelf, 'Ledger')?.id, 'w1:p1');
  assert.equal(resolve(shelf, 'storefront web')?.id, 'w2:p1');
  assert.equal(resolve(shelf, 'w1:p1')?.id, 'w1:p1');
  assert.equal(resolve(shelf, 3), null);
  assert.equal(resolve(shelf, 'nothing like it'), null);
});

test('the user guide names the spoken form of every command', () => {
  const guide = readFileSync(join(REPO, 'docs', 'USER-GUIDE.md'), 'utf8');
  assert.ok(COMMANDS.length >= 25, 'the registry is not empty');
  const missing = COMMANDS.filter(c => !guide.includes(`"${c.say[0] as string}"`)).map(c => c.say[0]);
  assert.deepEqual(missing, []);
});

test('the microphone: a stop while it is opening leaves it closed, and a start after that opens it', async () => {
  const opens: { resolve: () => void; closed: boolean }[] = [];
  const mic = new Mic(async () => {
    const open = { resolve: () => undefined as void, closed: false };
    opens.push(open);
    await new Promise<void>(resolve => { open.resolve = resolve; });
    return { close() { open.closed = true; } };
  }, () => 'w1:p1', () => undefined, () => undefined);
  mic.setMode('switch');
  const first = mic.switchOn();
  mic.stop();
  const second = mic.switchOn();
  opens[0]?.resolve();
  opens[1]?.resolve();
  await Promise.all([first, second]);
  assert.equal(opens.length, 2, 'the start after the stop began its own open');
  assert.equal(opens[0]?.closed, true, 'the open from before the stop was closed');
  assert.equal(mic.open, true, 'the start after the stop opened the microphone');
  mic.stop();
  assert.equal(opens[1]?.closed, true);
});

test('the microphone: hold to talk sends what was said, captured for the session in front when the press began', async () => {
  let receiver = 'w1:p1';
  const sent: { receiver: string | null; length: number }[] = [];
  const mic = new Mic(async () => ({ close() { /* nothing */ } }), () => receiver, c => sent.push({ receiver: c.receiver, length: c.audio.length }), () => undefined);
  await mic.holdStart();
  mic.feed(new Float32Array(8000));
  receiver = 'w2:p1';
  mic.feed(new Float32Array(8000));
  mic.holdEnd();
  assert.deepEqual(sent, [{ receiver: 'w1:p1', length: 16000 }]);
  assert.equal(mic.open, false);
});

test('the microphone: audio from a stream closed by a stop does not enter the next recording', async () => {
  const pushes: ((s: Float32Array) => void)[] = [];
  const sent: number[] = [];
  const mic = new Mic(async push => { pushes.push(push); return { close() { /* nothing */ } }; }, () => 'w1:p1', c => sent.push(c.audio.length), () => undefined);
  await mic.holdStart();
  mic.holdEnd();
  await mic.holdStart();
  pushes[0]?.(new Float32Array(1024));
  pushes[1]?.(new Float32Array(8000));
  mic.holdEnd();
  assert.deepEqual(sent, [8000], 'only the current stream\'s audio is sent');
});

test('page code redraws through the scene\'s frames: a Quest stops the window\'s frames in immersive mode', () => {
  const page = join(REPO, 'view', 'page');
  const offenders = readdirSync(page).filter(f => f.endsWith('.ts')).flatMap(f => {
    const lines = readFileSync(join(page, f), 'utf8').split('\n');
    return lines.flatMap((line, i) => /requestAnimationFrame\(/.test(line) && !/session\.requestAnimationFrame|\(desktop\)/.test(line) ? [`${f}:${i + 1}`] : []);
  });
  assert.deepEqual(offenders, [], 'schedule redraws with render() (drawn in Scene\'s frame callback), never window.requestAnimationFrame: it does not run in an immersive session on a Quest');
});
