/**
 * Spoken words wait as drafts. Each path by which speech can put text into a session is driven on
 * the bench: a prompt to an agent, to a shell, an order to the helper (also while it starts). With
 * direct sending off, no text from speech is followed by Enter until the owner says "go"; with it
 * on, a prompt is sent as soon as it is heard. A stand-in prints "received:" only when Enter
 * reaches it, so each session's pane says what it was sent and what only waits in its input.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { BenchWorkspace } from '../bench/bench.js';
import { typeable } from '../bridge/drafts.js';
import { OVERVIEW } from '../bridge/agents.js';
import { Settings, SETTINGS_FILE } from '../bridge/settings.js';
import { setup, type Desk } from './desk.js';

const LAYOUT: BenchWorkspace[] = [
  { label: 'alpha', panes: [{ name: 'a1', kind: 'agent' }, { name: 'a2', kind: 'agent' }, { name: 'sh', kind: 'shell' }] },
  { label: 'beta', panes: [{ name: 'b1', kind: 'agent' }] },
];

const front = (s: Desk, name: string) => s.bench.client.call('pane.focus', { pane_id: s.bench.pane(name) });
const shows = (s: Desk, id: string, words: string) => s.bench.waitFor(async () => (await s.text(id)).includes(words), `"${words}" in ${id}`, 15_000);
const count = async (s: Desk, id: string, words: string) => (await s.text(id)).split(words).length - 1;
const settle = () => new Promise(resolve => setTimeout(resolve, 400));
const drafts = (s: Desk) => s.bridge.shelf().drafts.slice().sort();

test('a prompt to an agent is typed and waits; "go" sends the draft in front once, and only that one', async () => {
  const s = await setup(LAYOUT);
  try {
    const [a1, a2, b1] = [s.bench.pane('a1'), s.bench.pane('a2'), s.bench.pane('b1')];
    await front(s, 'a1');
    const typed = await s.say('summarize the ledger change');
    assert.deepEqual([typed.as, typed.ok], ['prompt', true]);
    assert.match(typed.outcome, /^Draft in a1\. Say “go” to send it/);
    await shows(s, a1, 'summarize the ledger change');
    await settle();
    assert.deepEqual(await s.received(), [], 'typed, and nothing sent to any session');
    assert.deepEqual(drafts(s), [a1]);

    // With no draft in front, "go" sends nothing and says so; a draft elsewhere is not touched.
    await front(s, 'a2');
    await s.bench.waitFor(async () => s.mirror.shelf().focusedId === a2, 'a2 in front');
    const none = await s.say('go');
    assert.deepEqual([none.as, none.ok], ['command', false]);
    assert.match(none.outcome, /No draft waits in the session in front\. Nothing was sent\./);
    await settle();
    assert.deepEqual(await s.received(), []);

    // A prompt for a2 while a1's draft waits goes to a2; "go" sends a2's only.
    assert.equal((await s.say('check the payout report')).ok, true);
    await shows(s, a2, 'check the payout report');
    assert.deepEqual(drafts(s), [a1, a2].sort());
    assert.equal((await s.say('go')).ok, true);
    await shows(s, a2, 'received: check the payout report');
    await settle();
    assert.deepEqual(await s.received(), [a2], 'a2 got its draft; a1 and every other session got nothing');
    assert.deepEqual(drafts(s), [a1]);

    // Once: a second "go", and two at the same moment, send nothing more.
    assert.equal((await s.say('go')).ok, false);
    await front(s, 'a1');
    await s.bench.waitFor(async () => s.mirror.shelf().focusedId === a1, 'a1 in front');
    const both = await Promise.all([s.bridge.act({ kind: 'send' }), s.bridge.act({ kind: 'send' })]);
    assert.deepEqual(both.map(r => r.ok).sort(), [false, true], 'one of two goes at once sent it');
    await shows(s, a1, 'received: summarize the ledger change');
    await settle();
    assert.equal(await count(s, a1, 'received: summarize the ledger change'), 1, 'sent once');
    assert.deepEqual(drafts(s), []);
    assert.equal((await s.text(b1)).includes('received:'), false);
  } finally { await s.stop(); }
});

test('a prompt to a shell waits too: typed, run only on "go"', async () => {
  const s = await setup(LAYOUT);
  try {
    const sh = s.bench.pane('sh');
    await front(s, 'sh');
    await s.bench.waitFor(async () => s.mirror.shelf().focusedId === sh, 'the shell in front');
    assert.equal((await s.say('echo DRAFTMARK$((40+2))')).ok, true);
    await shows(s, sh, 'echo DRAFTMARK$((40+2))');
    await settle();
    assert.equal(/^DRAFTMARK42$/m.test(await s.text(sh)), false, 'typed, not run');
    assert.equal((await s.say('submit')).ok, true, '"submit" is a spoken form of go');
    await s.bench.waitFor(async () => /^DRAFTMARK42$/m.test(await s.text(sh)), 'the command run');
  } finally { await s.stop(); }
});

test('more words are added to a draft; "scratch that" clears it, sends nothing, and a new prompt starts a new draft', async () => {
  const s = await setup(LAYOUT);
  try {
    const a1 = s.bench.pane('a1');
    await front(s, 'a1');
    assert.equal((await s.say('first part of a long prompt')).ok, true);
    assert.equal((await s.say('and the second part')).ok, true);
    await shows(s, a1, 'first part of a long prompt and the second part');
    assert.deepEqual(await s.received(), [], 'adding sent nothing');
    const scratched = await s.say('scratch that');
    assert.deepEqual([scratched.ok, drafts(s)], [true, []]);
    await settle();
    assert.deepEqual(await s.received(), [], 'clearing sent nothing');
    assert.equal((await s.say('scratch that')).ok, false, 'nothing left to clear');
    assert.equal((await s.say('a new start')).ok, true);
    await shows(s, a1, 'a new start');
    assert.equal((await s.say('go')).ok, true);
    await shows(s, a1, 'received: a new start');
    assert.equal((await s.text(a1)).includes('received: first part'), false, 'the cleared words were not sent with it');
  } finally { await s.stop(); }
});

test('an order to the helper waits as a draft in the helper\'s input, also while it starts, and is sent from the overview', async () => {
  const s = await setup(LAYOUT, { standin: { delayMs: 1500 } });
  try {
    const a1 = s.bench.pane('a1');
    await front(s, 'a1');
    const order = await s.say('helper, count the files in the folder');
    assert.deepEqual([order.as, order.ok], ['helper', true]);
    assert.match(order.outcome, /starting/);
    const helper = (await s.agents.seat(OVERVIEW)).paneId;
    await s.agents.ready(helper);
    await shows(s, helper, 'count the files in the folder');
    await settle();
    assert.deepEqual(await s.received(), [], 'typed into the helper, not sent');
    assert.deepEqual(drafts(s), [helper]);

    // Ready now: a second order is added to the first.
    const more = await s.say('helper, and then the logs');
    assert.match(more.outcome, /^Draft in the helper's input/);
    await shows(s, helper, 'count the files in the folder and then the logs');

    // "go" in a project does not send the helper's draft; at the overview, where it is in front, it does.
    assert.equal((await s.say('go')).ok, false);
    await settle();
    assert.deepEqual(await s.received(), []);
    assert.equal((await s.bridge.act({ kind: 'overview' })).ok, true);
    await s.bench.waitFor(async () => s.mirror.shelf().focusedId === helper, 'the helper in front');
    assert.equal((await s.say('go')).ok, true);
    await shows(s, helper, 'received: count the files in the folder and then the logs');
    assert.deepEqual(await s.received(), [helper]);
    assert.equal((await s.text(a1)).includes('received:'), false);
  } finally { await s.stop(); }
});

test('direct sending is off at first, is switched by action and by voice, sends as soon as heard while on, and survives a restart', async () => {
  const dir = mkdtempSync('/tmp/svs-');
  try {
    assert.equal(new Settings(dir).direct, false, 'off on first use');
    const settings = new Settings(dir);
    const s = await setup(LAYOUT, { settings });
    try {
      const a1 = s.bench.pane('a1');
      await front(s, 'a1');
      const on = await s.say('send at once');
      assert.deepEqual([on.as, on.ok], ['command', true]);
      assert.equal(settings.direct, true);
      assert.equal(new Settings(dir).direct, true, 'kept in the data directory: a restart reads it');
      assert.equal(JSON.parse(readFileSync(join(dir, SETTINGS_FILE), 'utf8')).direct, true);
      const sent = await s.say('summarize the ledger change');
      assert.equal(sent.outcome, 'Sent to a1');
      await shows(s, a1, 'received: summarize the ledger change');
      assert.deepEqual(drafts(s), []);

      const off = await s.bridge.act({ kind: 'direct', on: false });
      assert.equal(off.ok, true);
      assert.equal(new Settings(dir).direct, false);
      assert.equal((await s.say('send at once')).ok, true);
      assert.equal((await s.say('wait for go')).ok, true);
      assert.equal(new Settings(dir).direct, false);
      assert.match((await s.say('another prompt')).outcome, /^Draft in a1/);
    } finally { await s.stop(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('words never press a key: control characters are not typed, a waiting agent is not typed into, and a closed session loses its draft', async () => {
  assert.equal(typeable('hello\r\nworld\u001b[A\u0003 evil\u0004'), 'hello world [A evil', 'every control character, Enter and Ctrl-C included, is a space');
  assert.equal(typeable('\r\n\t'), '');
  const s = await setup(LAYOUT);
  try {
    const [a1, a2, sh] = [s.bench.pane('a1'), s.bench.pane('a2'), s.bench.pane('sh')];
    await front(s, 'a1');
    const odd = await s.say('line one\rline two\n\u0003 line three');
    assert.equal(odd.ok, true, odd.outcome);
    await shows(s, a1, 'line one line two [?]'.replace(' [?]', ''));
    await settle();
    assert.deepEqual(await s.received(), [], 'no carriage return or newline in the words sent anything');

    // An agent that waits on a question would take typed words as keys: refused.
    await s.bench.type('a2', '/block');
    await s.bench.waitFor(async () => s.mirror.shelf().sessions.some(x => x.id === a2 && x.status === 'blocked'), 'a2 waiting');
    await front(s, 'a2');
    await s.bench.waitFor(async () => s.mirror.shelf().focusedId === a2, 'a2 in front');
    const refused = await s.say('yes please do it');
    assert.equal(refused.ok, false);
    assert.match(refused.outcome, /waiting on a question: answer it with a key first/);
    await settle();
    assert.equal((await s.text(a2)).includes('yes please do it'), false);

    // The session that holds a draft closes: the draft is forgotten, and "go" elsewhere sends nothing.
    await front(s, 'sh');
    await s.bench.waitFor(async () => s.mirror.shelf().focusedId === sh, 'the shell in front');
    assert.equal((await s.say('echo gone')).ok, true);
    await shows(s, sh, 'echo gone');
    assert.deepEqual(drafts(s), [a1, sh].sort());
    await s.bench.client.call('pane.close', { pane_id: sh });
    await s.bench.waitFor(async () => !s.mirror.shelf().sessions.some(x => x.id === sh), 'the shell closed');
    assert.deepEqual(drafts(s), [a1]);
    // Said while the shell was in front, "go" meets a session that has closed: it does nothing.
    const late = await s.say('go', sh);
    assert.equal(late.ok, false);
    assert.deepEqual(await s.received(), []);
  } finally { await s.stop(); }
});

test('two prompts at the same moment are both typed, with a space between; a "scratch that" that fails leaves the draft to be cleared again', async () => {
  const s = await setup(LAYOUT);
  try {
    const a1 = s.bench.pane('a1');
    await front(s, 'a1');
    await s.bench.waitFor(async () => s.mirror.shelf().focusedId === a1, 'a1 in front');
    await Promise.all([s.bridge.act({ kind: 'direct', on: false }), s.say('alpha words'), s.say('beta words')]);
    await shows(s, a1, 'alpha words');
    await s.bench.waitFor(async () => /(alpha words beta words|beta words alpha words)/.test(await s.text(a1)), 'both typed with a space between');
    await s.bench.stopServer();
    const failed = await s.bridge.act({ kind: 'scratch' });
    assert.equal(failed.ok, false);
    assert.deepEqual(drafts(s), [a1], 'the clear did not happen, so the draft is still there to clear');
  } finally { await s.stop(); }
});
