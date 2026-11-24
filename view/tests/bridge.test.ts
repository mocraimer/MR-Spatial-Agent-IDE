import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { HerdrBench } from '../bench/bench.js';
import type { LevelAgents } from '../bridge/agents.js';
import { Bridge, type Transcriber } from '../bridge/bridge.js';
import { compiled } from '../bridge/config.js';
import { HerdrClient } from '../bridge/herdr.js';
import { serveCloseRequests } from '../bridge/agents.js';
import { DEFAULT_MIRROR, Mirror } from '../bridge/mirror.js';
import { plain } from '../shared/ansi.js';

/** Speech that hears whatever the test queued, one utterance at a time. */
class Heard implements Transcriber {
  readonly queue: string[] = [];
  state() { return { ready: true as const }; }
  async transcribe(): Promise<string> { return this.queue.shift() ?? ''; }
}
const noAgents: LevelAgents = { seat: async () => { throw new Error('no level agents here'); }, ready: async () => undefined, pending: () => ({ starting: [], failed: [] }), onChange: () => undefined, describe: id => id };
const audio = new Float32Array(1600);

async function setup(closeAnswerMs = 400) {
  const bench = await HerdrBench.start([{ label: 'alpha', panes: [{ name: 'a1', kind: 'agent' }, { name: 'a2', kind: 'agent' }, { name: 'sh', kind: 'shell' }] }]);
  const mirror = new Mirror(bench.client, DEFAULT_MIRROR);
  const speech = new Heard();
  const bridge = new Bridge(bench.client, mirror, speech, noAgents, { closeAnswerMs });
  mirror.start();
  await bench.waitFor(async () => mirror.shelf().sessions.length === 3, 'the mirror to see three sessions');
  const open = async (name: string) => (await bench.client.snapshot()).panes.some(p => p.id === bench.pane(name));
  return { bench, mirror, speech, bridge, open, stop: async () => { mirror.stop(); await bench.stop(); } };
}

test('a close waits for the owner: no answer, a no, a second request, an unknown or vanished session all leave sessions open', async () => {
  const s = await setup();
  try {
    assert.equal(await s.bridge.requestClose('sh'), 'no-answer');
    assert.equal(await s.open('sh'), true, 'no answer leaves it open');

    const first = s.bridge.requestClose('sh');
    assert.equal(await s.bridge.requestClose('a2'), 'busy', 'one close waits at a time');
    assert.deepEqual(await s.bridge.act({ kind: 'answer', answer: false }), { ok: true, outcome: 'Answered no: 3 sh (alpha) stays open.' });
    assert.equal(await first, 'declined');
    assert.equal(await s.open('sh'), true);

    assert.equal(await s.bridge.requestClose('no such session'), 'unknown-session');
    assert.equal((await s.bridge.act({ kind: 'answer', answer: true })).ok, false, 'a yes with nothing waiting closes nothing');

    const vanishing = s.bridge.requestClose('a2');
    await s.bench.waitFor(async () => true, 'the request to be shown', 50);
    await s.bench.client.call('pane.close', { pane_id: s.bench.pane('a2') });
    await s.bridge.act({ kind: 'answer', answer: true });
    assert.equal(await vanishing, 'failed', 'a session that closed meanwhile is reported, not mistaken');

    const yes = s.bridge.requestClose('sh');
    await s.bridge.act({ kind: 'answer', answer: true });
    assert.equal(await yes, 'closed');
    assert.equal(await s.open('sh'), false);
  } finally { await s.stop(); }
});

test('the close tool reaches the bridge over its socket and reports the owner\'s answer', async () => {
  const s = await setup(300);
  const dir = mkdtempSync('/tmp/svc-');
  const socket = join(dir, 'helper.sock');
  const server = serveCloseRequests(socket, ref => s.bridge.requestClose(ref));
  try {
    await new Promise(resolve => setTimeout(resolve, 100));
    // Asynchronously: the bridge answering the tool runs in this same process.
    const run = () => new Promise<{ status: number; stdout: string }>(resolve => {
      execFile('node', [compiled('bridge', 'close-tool.js'), 'sh'], { env: { ...process.env, SPATIAL_VIEW_HELPER_SOCKET: socket } }, (error, stdout) => resolve({ status: error ? Number(error.code ?? 1) : 0, stdout }));
    });
    const unanswered = await run();
    assert.equal(unanswered.status, 1);
    assert.equal(unanswered.stdout.trim(), 'Not closed: the owner did not answer about sh.');
    assert.equal(await s.open('sh'), true);
  } finally { server.close(); rmSync(dir, { recursive: true, force: true }); await s.stop(); }
});

test('an utterance sent twice is carried out once; "show" naming no session is a prompt; "back" survives a failed focus', async () => {
  const s = await setup();
  try {
    await s.bench.client.call('pane.focus', { pane_id: s.bench.pane('a1') });
    await s.bench.waitFor(async () => s.mirror.shelf().focusedId === s.bench.pane('a1'), 'a1 in front');
    s.speech.queue.push('only once please');
    const [one, two] = await Promise.all([s.bridge.utterance('u1', audio, s.bench.pane('a1')), s.bridge.utterance('u1', audio, s.bench.pane('a1'))]);
    assert.deepEqual(one, two);
    const typed = async () => plain(await s.bench.client.read(s.bench.pane('a1'), 60)).split('only once please').length - 1;
    await s.bench.waitFor(async () => (await typed()) > 0, 'the words typed');
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(await typed(), 1, 'typed once');
    s.speech.queue.push('go');
    assert.equal((await s.bridge.utterance('u1b', audio, s.bench.pane('a1'))).ok, true);
    await s.bench.waitFor(async () => plain(await s.bench.client.read(s.bench.pane('a1'), 40)).includes('received: only once please'), 'the prompt');
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(plain(await s.bench.client.read(s.bench.pane('a1'), 60)).split('received: only once please').length - 1, 1, 'delivered once');

    s.speech.queue.push('show me the failing test');
    const u = await s.bridge.utterance('u2', audio, s.bench.pane('a1'));
    assert.deepEqual([u.as, u.ok, u.outcome], ['prompt', true, 'Draft in a1. Say “go” to send it, or “scratch that” to clear it.']);

    await s.bench.type('a2', '/block');
    await s.bench.waitFor(async () => s.mirror.shelf().sessions.some(x => x.id === s.bench.pane('a2') && x.status === 'blocked'), 'a2 waiting');
    assert.equal((await s.bridge.act({ kind: 'next-waiting' })).ok, true);
    await s.bench.stopServer();
    assert.equal((await s.bridge.act({ kind: 'back' })).ok, false, 'back fails while Herdr is gone');
    await s.bench.startServer();
    // Herdr came back as a fresh server: the session "back" points to is gone, and it says so.
    await s.bench.waitFor(async () => s.mirror.shelf().herdr.state === 'up', 'Herdr back');
    assert.match((await s.bridge.act({ kind: 'back' })).outcome, /has closed|Back to/, 'the jump was kept for a second try');
  } finally { await s.stop(); }
});

test('a spoken key goes to the session that was in front when the speech began, also after focus has moved', async () => {
  const s = await setup();
  try {
    await s.bench.client.call('pane.focus', { pane_id: s.bench.pane('a2') });
    await s.bench.waitFor(async () => s.mirror.shelf().focusedId === s.bench.pane('a2'), 'a2 in front');
    // The owner began "press three" with sh in front; a2 came forward before it was heard.
    s.speech.queue.push('Press three.');
    const u = await s.bridge.utterance('k1', audio, s.bench.pane('sh'));
    assert.deepEqual([u.as, u.ok, u.outcome], ['command', true, 'Pressed 3 in sh']);
    await s.bench.waitFor(async () => /\$ 3$/.test(plain(await s.bench.client.read(s.bench.pane('sh'), 10)).trimEnd()), 'the key at the shell prompt');
    assert.equal(/3$/.test(plain(await s.bench.client.read(s.bench.pane('a2'), 10)).trimEnd()), false, 'the session now in front got nothing');
    // The button and the keyboard act on what is in front now.
    assert.equal((await s.bridge.act({ kind: 'key', key: '3' })).outcome, 'Pressed 3 in a2');
  } finally { await s.stop(); }
});

test('a shelf read never goes backwards: actions and the poll loop read Herdr one after another', async () => {
  const bench = await HerdrBench.start([{ label: 'alpha', panes: [{ name: 'a1', kind: 'agent' }, { name: 'a2', kind: 'agent' }] }]);
  const mirror = new Mirror(new HerdrClient(bench.socketPath), { ...DEFAULT_MIRROR, tickMs: 1 });
  const seen: (string | null)[] = [];
  mirror.listen({ shelf: shelf => seen.push(shelf.focusedId), text: () => undefined });
  mirror.start();
  try {
    for (const name of ['a1', 'a2', 'a1', 'a2', 'a1']) {
      await bench.client.call('pane.focus', { pane_id: bench.pane(name) });
      await mirror.tick();
      assert.equal(mirror.shelf().focusedId, bench.pane(name), `after focusing ${name} and reading, the shelf shows ${name}`);
    }
  } finally { mirror.stop(); await bench.stop(); }
  assert.ok(seen.length > 0);
});

test('a close names exactly one session: a shared name or a project label is refused, the yes names number and project', async () => {
  const bench = await HerdrBench.start([
    { label: 'alpha', panes: [{ name: 'a1', kind: 'agent' }, { name: 'logs', kind: 'shell' }] },
    { label: 'beta', panes: [{ name: 'logs-b', kind: 'shell' }] },
  ]);
  const mirror = new Mirror(bench.client, DEFAULT_MIRROR);
  const bridge = new Bridge(bench.client, mirror, new Heard(), noAgents, { closeAnswerMs: 300 });
  const confirms: (string | null)[] = [];
  bridge.connect(event => { if (event.type === 'confirm') confirms.push(event.pending?.name ?? null); });
  mirror.start();
  try {
    await bench.waitFor(async () => mirror.shelf().sessions.length === 3, 'three sessions');
    await bench.client.call('pane.rename', { pane_id: bench.pane('logs-b'), label: 'logs' });
    await bench.waitFor(async () => mirror.shelf().sessions.filter(s => s.name === 'logs').length === 2, 'two sessions named logs');
    assert.equal(await bridge.requestClose('logs'), 'ambiguous');
    assert.equal(await bridge.requestClose('alpha'), 'unknown-session', 'a project label closes nothing');
    const pending = bridge.requestClose(bench.pane('logs'));
    await bench.waitFor(async () => confirms.at(-1) !== null, 'the confirmation');
    assert.equal(confirms.at(-1), '2 logs (alpha)');
    await bridge.act({ kind: 'answer', answer: false });
    assert.equal(await pending, 'declined');
    assert.equal(mirror.shelf().sessions.length, 3, 'nothing closed');
  } finally { mirror.stop(); await bench.stop(); }
});

test('a Herdr call may wait longer than the default when it asks to: a slow answer within its own timeout arrives', async () => {
  const dir = mkdtempSync('/tmp/svs-');
  const socket = join(dir, 'slow.sock');
  const { createServer } = await import('node:net');
  const server = createServer(c => { c.on('data', () => setTimeout(() => c.end(`${JSON.stringify({ id: 'x', result: { type: 'ok' } })}\n`), 6000)); });
  await new Promise<void>(resolve => server.listen(socket, resolve));
  try {
    const client = new HerdrClient(socket);
    await assert.rejects(client.call('agent.start', {}), /did not answer agent.start within 5000 ms/);
    assert.deepEqual(await client.call('agent.start', {}, 8000), { type: 'ok' });
  } finally { server.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('Fix-#3: announceVoice broadcasts the voice state including standingIn to connected pages', async () => {
  // Pages connect before Kokoro has finished loading. While loading, the voice is "standing in"
  // for Windows (standingIn=true). Once Kokoro fires its onReady callback, the bridge calls
  // announceVoice() so connected pages learn the state changed.
  //
  // This test verifies that announceVoice() is a public method (required for view.ts to call it
  // from the Kokoro callback) and that it broadcasts a voice event with the correct standingIn flag.
  const s = await setup();
  try {
    // A fake voice that starts standing in (simulating Kokoro still loading).
    let standing = true;
    const fakeVoice = {
      async speak() { return; },
      stop() { return; },
      standingIn: () => standing,
    };
    // Inject the fake voice via the bridge's internal voice field.
    (s.bridge as unknown as Record<string, unknown>).voice = fakeVoice;
    (s.bridge as unknown as Record<string, unknown>).say = null;

    const voiceEvents: Array<{ standingIn: boolean | undefined }> = [];
    const disconnect = s.bridge.connect(ev => {
      if (ev.type === 'voice') voiceEvents.push({ standingIn: ev.standingIn });
    });
    try {
      // Simulate Kokoro onReady: standing in transitions to false, then announceVoice() is called.
      standing = false;
      s.bridge.announceVoice();

      assert.ok(voiceEvents.length >= 1, `voice event must have been broadcast; got ${voiceEvents.length}`);
      assert.equal(voiceEvents[voiceEvents.length - 1]?.standingIn, false, 'standingIn=false after Kokoro ready');
    } finally {
      disconnect();
    }
  } finally { await s.stop(); }
});
