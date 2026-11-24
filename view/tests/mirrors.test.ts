/**
 * Window mirrors and making projects, on the bench: a real bridge, real mirror sessions in Herdr
 * panes and the real level and project tools; only the PC's windows are a stand-in
 * (`view/bench/fake-windows.ts`, behind the same protocol as the helper on Windows).
 */
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { HerdrBench, type BenchWorkspace } from '../bench/bench.js';
import { Bridge, type Transcriber } from '../bridge/bridge.js';
import { compiled } from '../bridge/config.js';
import { terminalKeys } from '../bridge/keys.js';
import { asOrder } from '../bridge/mirror-order.js';
import { DEFAULT_MIRROR, Mirror } from '../bridge/mirror.js';
import { labelFor, Mirrors } from '../bridge/mirrors.js';
import { folderName, folders, makeProject } from '../bridge/projects.js';
import { HelperWindows } from '../bridge/windows.js';
import { plain } from '../shared/ansi.js';
import type { BridgeEvent } from '../shared/messages.js';
import { benchAgents } from './fixture.js';

class Heard implements Transcriber {
  readonly queue: string[] = [];
  state() { return { ready: true as const }; }
  async transcribe(): Promise<string> { return this.queue.shift() ?? ''; }
}
const audio = new Float32Array(1600);
let seq = 0;

const LAYOUT: BenchWorkspace[] = [
  { label: 'alpha', panes: [{ name: 'a1', kind: 'agent' }, { name: 'ash', kind: 'shell' }] },
  { label: 'beta', panes: [{ name: 'b1', kind: 'agent' }] },
];

async function setup(pickerIdleMs?: number) {
  const bench = await HerdrBench.start(LAYOUT);
  const data = mkdtempSync('/tmp/svm-');
  const fakeLog = join(data, 'windows.log');
  const ctl = join(data, 'windows.ctl');
  process.env.SPATIAL_WINDOW_HELPER = `node ${compiled('bench', 'fake-windows.js')}`;
  process.env.SPATIAL_FAKE_WINDOWS_LOG = fakeLog;
  process.env.SPATIAL_FAKE_WINDOWS_CTL = ctl;
  const roots = ['r1', 'r2', 'r3'].map(r => join(data, r));
  for (const r of roots) mkdirSync(r);
  process.env.SPATIAL_PROJECT_ROOTS = roots.join(':');
  process.env.SPATIAL_NEW_PROJECT_ROOT = roots[0];
  const mirror = new Mirror(bench.client, DEFAULT_MIRROR);
  const speech = new Heard();
  const mirrors = new Mirrors(bench.client, new HelperWindows(), join(data, 'mirror.sock'));
  const bridge = new Bridge(bench.client, mirror, speech, benchAgents(bench, data), { closeAnswerMs: 2000, mirrors, pickerIdleMs });
  mirrors.serve(order => bridge.mirrorOrder(order));
  const events: BridgeEvent[] = [];
  bridge.connect(e => events.push(e));
  mirror.start();
  await bench.waitFor(async () => mirror.shelf().sessions.length === 3, 'the mirror to see every session');
  const say = async (text: string) => { speech.queue.push(text); return await bridge.utterance(`u${++seq}`, audio, mirror.shelf().focusedId); };
  const fake = () => existsSync(fakeLog) ? readFileSync(fakeLog, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as Record<string, unknown>) : [];
  const note = (id: string) => [...events].reverse().find((e): e is Extract<BridgeEvent, { type: 'window' }> => e.type === 'window' && e.id === id)?.note;
  const frames = (id: string) => events.filter(e => e.type === 'frame' && e.id === id).length;
  return {
    bench, data, mirror, mirrors, bridge, events, say, fake, note, frames, roots,
    control: (line: object) => appendFileSync(ctl, `${JSON.stringify(line)}\n`),
    stop: async () => { bridge.stop(); mirrors.close(); mirror.stop(); await bench.stop(); rmSync(data, { recursive: true, force: true }); },
  };
}
type Setup = Awaited<ReturnType<typeof setup>>;

async function into(s: Setup, label: string): Promise<string> {
  const w = (await s.bench.client.snapshot()).workspaces.find(x => x.label === label)?.id as string;
  await s.bridge.act({ kind: 'go', projectId: w });
  await s.bench.waitFor(async () => s.mirror.shelf().focusedId !== null && s.mirror.shelf().sessions.find(x => x.id === s.mirror.shelf().focusedId)?.workspaceId === w, `going into ${label}`);
  return w;
}

/** Mirrors one of the stand-in windows into the project in front, by the list. */
async function mirrorByList(s: Setup, n: number): Promise<string> {
  const before = new Set(s.mirror.shelf().sessions.map(x => x.id));
  assert.equal((await s.bridge.act({ kind: 'picker', list: 'windows' })).ok, true);
  const r = await s.bridge.act({ kind: 'pick', n });
  assert.equal(r.ok, true, r.outcome);
  let id = '';
  await s.bench.waitFor(async () => { id = s.mirror.shelf().sessions.find(x => !before.has(x.id))?.id ?? ''; return id !== '' && s.note(id) === null; }, 'the mirror to attach', 20_000);
  return id;
}

test('the window list shows the PC\'s windows; a pick makes a mirror session in this project, in front, with a live picture', async () => {
  const s = await setup();
  try {
    const alpha = await into(s, 'alpha');
    const opened = await s.bridge.act({ kind: 'picker', list: 'windows' });
    assert.match(opened.outcome, /3 PC windows/);
    const shown = [...s.events].reverse().find((e): e is Extract<BridgeEvent, { type: 'picker' }> => e.type === 'picker');
    assert.deepEqual(shown?.picker?.items.map(i => [i.n, i.detail]), [[1, 'chrome'], [2, 'notepad'], [3, 'Code']]);
    await s.bridge.act({ kind: 'picker-cancel' });
    assert.equal(s.mirror.shelf().sessions.length, 4, 'cancel makes nothing (3 sessions and the project agent)');

    const id = await mirrorByList(s, 2);
    const session = s.mirror.shelf().sessions.find(x => x.id === id);
    assert.equal(session?.workspaceId, alpha, 'it joins the project the owner is in');
    assert.equal(session?.window, true);
    assert.equal(session?.name, 'window: Untitled - Notepad');
    assert.equal(s.mirror.shelf().focusedId, id, 'a picked window comes to the front');
    // AC-10.1: tab.list must include the mirror's label so the Herdr tab bar names it.
    const tabsR = await s.bench.client.call('tab.list', { workspace_id: alpha });
    const tabLabels = (tabsR.tabs as Array<{ label: string }>).map(t => t.label);
    assert.ok(tabLabels.includes('window: Untitled - Notepad'), `tab.list includes mirror label; got: ${JSON.stringify(tabLabels)}`);
    const before = s.frames(id);
    await new Promise(r => setTimeout(r, 1200));
    assert.ok(s.frames(id) > before, 'pictures keep coming while it is in front');
  } finally { await s.stop(); }
});

test('desk keys typed into the mirror go to its window; with a terminal in front they reach Herdr, not the window; clicks go to the window', async () => {
  const s = await setup();
  try {
    await into(s, 'alpha');
    const id = await mirrorByList(s, 2);
    // What Herdr does with keys typed at the desk: they go to the focused pane.
    await s.bench.client.call('pane.send_input', { pane_id: id, text: 'hi', keys: ['enter'] });
    await s.bench.waitFor(async () => s.fake().some(e => JSON.stringify(e.events).includes('"text":"hi"')), 'the text to reach the window');
    assert.ok(s.fake().some(e => e.hwnd === 102 && JSON.stringify(e.events).includes('"key":"enter"')), 'Enter reaches the window as a key');

    const shell = s.mirror.shelf().sessions.find(x => x.name === 'ash')?.id as string;
    await s.bridge.act({ kind: 'focus', sessionId: shell });
    const inputsBefore = s.fake().filter(e => e.events).length;
    await s.bench.client.call('pane.send_input', { pane_id: shell, text: 'echo typed-at-desk', keys: ['enter'] });
    await s.bench.waitFor(async () => plain(await s.bench.client.read(shell, 20)).includes('typed-at-desk'), 'the shell to get the keys');
    assert.equal(s.fake().filter(e => e.events).length, inputsBefore, 'nothing reached the window while the terminal was in front');

    await s.bridge.act({ kind: 'focus', sessionId: id });
    const r = await s.bridge.act({ kind: 'window-input', sessionId: id, events: [{ type: 'click', x: 0.25, y: 0.75 }] });
    assert.equal(r.ok, true, r.outcome);
    assert.ok(s.fake().some(e => JSON.stringify(e.events) === JSON.stringify([{ type: 'click', x: 0.25, y: 0.75 }])));
  } finally { await s.stop(); }
});

test('a minimized, restored or closed window says so on its session; a closed window\'s session stays until the owner closes it', async () => {
  const s = await setup();
  try {
    await into(s, 'alpha');
    const id = await mirrorByList(s, 1);
    s.control({ minimize: 101 });
    await s.bench.waitFor(async () => /minimized/i.test(s.note(id) ?? ''), 'the minimized note');
    s.control({ restore: 101 });
    await s.bench.waitFor(async () => s.note(id) === null, 'the picture back');
    s.control({ gone: 101 });
    await s.bench.waitFor(async () => /closed on the PC/.test(s.note(id) ?? ''), 'the closed note');
    await new Promise(r => setTimeout(r, 1500));
    assert.ok(s.mirror.shelf().sessions.some(x => x.id === id), 'the session stays open');

    // Closing goes through the owner's yes, like any session; then its capture and process end.
    const answered = s.bridge.requestClose(id);
    await s.bench.waitFor(async () => s.events.some(e => e.type === 'confirm' && e.pending?.sessionId === id), 'the close to be asked');
    await s.bridge.act({ kind: 'answer', answer: true });
    assert.equal(await answered, 'closed');
    await s.bench.waitFor(async () => s.fake().some(e => e.stop === 101), 'the capture to stop');
    await s.bench.waitFor(async () => !execFileSync('ps', ['-eo', 'args'], { encoding: 'utf8' }).includes(`mirror-session.js 101`), 'the mirror process to end');
  } finally { await s.stop(); }
});

test('after Herdr restarts, a mirror session whose process did not come back says so and can be closed', async () => {
  const s = await setup();
  try {
    await into(s, 'alpha');
    const id = await mirrorByList(s, 3);
    const label = s.mirror.shelf().sessions.find(x => x.id === id)?.name;
    await s.bench.stopServer();
    await s.bench.startServer();
    await s.bench.waitFor(async () => s.mirror.shelf().sessions.some(x => x.name === label), 'the pane to come back', 20_000);
    const back = s.mirror.shelf().sessions.find(x => x.name === label);
    assert.equal(back?.window, true, 'it is still a window mirror, by its label');
    await s.bench.waitFor(async () => /not running/.test(s.note(back?.id ?? '') ?? ''), 'the not-running note', 25_000);
  } finally { await s.stop(); }
});

test('an agent\'s order opens a page on the PC and mirrors it into that project without changing what is in front; the level tool keeps to its own project', async () => {
  const s = await setup();
  try {
    const alpha = await into(s, 'alpha');
    const front = s.mirror.shelf().focusedId;
    const beta = (await s.bench.client.snapshot()).workspaces.find(x => x.label === 'beta')?.id as string;
    const answer = await s.bridge.mirrorOrder({ open: 'http://localhost:3000', workspace: beta });
    assert.match(answer, /Mirrored "http:\/\/localhost:3000 - Google Chrome" into beta/);
    assert.ok(s.fake().some(e => e.open === 'http://localhost:3000'));
    await s.mirror.tick();
    assert.ok(s.mirror.shelf().sessions.some(x => x.window && x.workspaceId === beta), 'a mirror session in beta');
    assert.equal(s.mirror.shelf().focusedId, front, 'what is in front did not change');
    await assert.rejects(s.bridge.mirrorOrder({ mirror: 'notepad', workspace: 'w-nope' }), /No project/);
    await assert.rejects(s.bridge.mirrorOrder({ mirror: 'nothing like this', workspace: alpha }), /No open PC window/);

    // The level tool, run as the project agent in alpha: its order names alpha, whatever it is asked.
    const agentPane = s.mirror.shelf().sessions.find(x => x.role === 'project-agent' && x.workspaceId === alpha)?.id as string;
    const env = { ...process.env, HERDR_WORKSPACE_ID: alpha, HERDR_PANE_ID: agentPane, HERDR_SOCKET_PATH: s.bench.socketPath, SPATIAL_VIEW_MIRROR_SOCKET: join(s.data, 'mirror.sock') };
    const out = await new Promise<string>((resolve, reject) => execFile('node', [compiled('bridge', 'level-tool.js'), 'mirror', 'notepad'], { env }, (e, stdout, stderr) => e ? reject(new Error(stderr)) : resolve(stdout)));
    assert.match(out, /into alpha/);
    // A viewer opens only a fixed program; a "file" name cannot smuggle in another command.
    const run = (args: string[]) => new Promise<{ ok: boolean; text: string }>(resolve => execFile('node', [compiled('bridge', 'level-tool.js'), ...args], { env }, (e, stdout, stderr) => resolve({ ok: !e, text: stdout + stderr })));
    assert.equal((await run(['view', 'pr', '12; rm -rf /'])).ok, false, 'a pull request is a number');
    const viewed = await run(['view', 'file', "x'; touch /tmp/svm-pwned; echo '"]);
    assert.equal(viewed.ok, true, viewed.text);
    const viewer = (await s.bench.client.snapshot()).panes.find(p => p.label?.startsWith('view ') && p.workspaceId === alpha)?.id as string;
    await s.bench.waitFor(async () => plain(await s.bench.client.read(viewer, 20)).includes('bat'), 'the viewer command to show');
    await new Promise(r => setTimeout(r, 1000));
    assert.equal(existsSync('/tmp/svm-pwned'), false, 'the quoted path ran no other command');
    assert.deepEqual(asOrder('localhost:3000', 'w9'), { open: 'http://localhost:3000', workspace: 'w9' });
    assert.deepEqual(asOrder('Untitled - Notepad', 'w9'), { mirror: 'Untitled - Notepad', workspace: 'w9' });
  } finally { await s.stop(); }
});

test('new projects: a folder with git and a workspace starting there; an existing name is refused; the list shows git folders not yet a project, newest first', async () => {
  const s = await setup();
  try {
    const [r1, r2, r3] = s.roots as [string, string, string];
    const made = await makeProject(s.bench.client, r1, 'My Recipes!');
    assert.equal(made.folder, join(r1, 'my-recipes'));
    assert.ok(existsSync(join(made.folder, '.git')));
    const ws = (await s.bench.client.snapshot()).workspaces.find(w => w.id === made.workspaceId);
    assert.equal(ws?.label, 'My Recipes!');
    assert.equal((await s.bench.client.snapshot()).panes.find(p => p.id === made.paneId)?.cwd, made.folder, 'its first session starts in the folder');
    writeFileSync(join(made.folder, 'keep.txt'), 'x');
    await assert.rejects(makeProject(s.bench.client, r1, 'my recipes'), /already exists/);
    assert.ok(existsSync(join(made.folder, 'keep.txt')), 'the existing folder is untouched');
    assert.equal(folderName('  Big   Data: 2 '), 'big-data-2');

    const git = (dir: string, age: number) => { mkdirSync(dir, { recursive: true }); execFileSync('git', ['init', '-q'], { cwd: dir }); const t = Date.now() / 1000 - age; utimesSync(dir, t, t); utimesSync(join(dir, '.git'), t, t); };
    git(join(r2, 'old'), 3000); git(join(r3, 'new'), 10); git(join(r2, 'used'), 5); mkdirSync(join(r2, 'plain'));
    mkdirSync(join(r2, '.hidden', '.git'), { recursive: true });
    const list = folders(s.roots, [join(r2, 'used', 'src'), made.folder]);
    assert.deepEqual(list.map(f => f.name), ['new', 'old'], 'git only, not hidden, not a project yet, newest first');
    assert.deepEqual(folders(s.roots, [], 'ol').map(f => f.name), ['old']);
  } finally { await s.stop(); }
});

test('the New project list by voice: a number picks a folder and goes in; words narrow it and reach no session; "make" names a new folder', async () => {
  const s = await setup();
  try {
    const [, r2] = s.roots as [string, string];
    for (const n of ['shop', 'shed']) { mkdirSync(join(r2, n)); execFileSync('git', ['init', '-q'], { cwd: join(r2, n) }); }
    await into(s, 'alpha');
    const front = s.mirror.shelf().focusedId as string;
    assert.match((await s.say('new project')).outcome, /2 folders/);
    const filtered = await s.say('shop');
    assert.equal(filtered.as, 'command');
    assert.match(filtered.outcome, /matches "shop" \(1\)/);
    assert.ok(!plain(await s.bench.client.read(front, 40)).includes('received: shop'), 'the words were not sent to the agent in front');
    const picked = await s.say('one');
    assert.match(picked.outcome, /Made project shop/);
    const shopWs = (await s.bench.client.snapshot()).workspaces.find(w => w.label === 'shop')?.id;
    assert.ok(shopWs);
    await s.bench.waitFor(async () => s.mirror.shelf().sessions.find(x => x.id === s.mirror.shelf().focusedId)?.workspaceId === shopWs, 'going into the new project');

    await s.say('new project');
    const made = await s.say('make garden tools');
    assert.match(made.outcome, /Made project garden tools/);
    assert.ok(existsSync(join(s.roots[0] as string, 'garden-tools', '.git')));
    await s.say('new project');
    const again = await s.say('make garden tools');
    assert.equal(again.ok, false);
    assert.match(again.outcome, /already exists/);
    await s.bridge.act({ kind: 'picker-cancel' });
  } finally { await s.stop(); }
});

test('terminal keys become window input: text, Enter, arrows, Ctrl-letters', () => {
  assert.deepEqual(terminalKeys(Buffer.from('ab\r\x1b[A\x03\x7f\t\x1b[1;5C\x1b')), [
    { type: 'text', text: 'ab' }, { type: 'key', key: 'enter' }, { type: 'key', key: 'up' }, { type: 'key', key: 'c', mods: ['ctrl'] },
    { type: 'key', key: 'backspace' }, { type: 'key', key: 'tab' }, { type: 'key', key: 'right', mods: ['ctrl'] }, { type: 'key', key: 'escape' },
  ]);
  assert.deepEqual(terminalKeys(Buffer.from('héllo 👋')), [{ type: 'text', text: 'héllo 👋' }], 'letters beyond ASCII stay text');
  assert.equal(labelFor('x'.repeat(100)).length, 'window: '.length + 60);
});

test('a list left unused closes by itself and says so; a new project whose git setup fails leaves no folder behind', async () => {
  const s = await setup(300);
  try {
    await into(s, 'alpha');
    await s.bridge.act({ kind: 'picker', list: 'windows' });
    await s.bench.waitFor(async () => s.events.some(e => e.type === 'notice' && /closed after a while/.test(e.text)), 'the list to close by itself');
    assert.equal([...s.events].reverse().find(e => e.type === 'picker')?.type === 'picker' && ([...s.events].reverse().find(e => e.type === 'picker') as { picker: unknown }).picker, null);

    const path = process.env.PATH;
    process.env.PATH = '/nonexistent';
    try { await assert.rejects(makeProject(s.bench.client, s.roots[0] as string, 'no git here'), /nothing was made/); } finally { process.env.PATH = path; }
    assert.equal(existsSync(join(s.roots[0] as string, 'no-git-here')), false, 'the half-made folder is gone');
  } finally { await s.stop(); }
});
