/**
 * The voice and the model/effort command on the bench: what is spoken for what, the exact text that
 * reaches a session, and where it refuses. The voice is a recording stand-in: no audio is made.
 */
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { BenchWorkspace } from '../bench/bench.js';
import { Settings } from '../bridge/settings.js';
import { Say, WAITING_MAX, CLIPS_KEPT } from '../bridge/say.js';
import type { BridgeEvent } from '../shared/messages.js';
import { setup, type Desk } from './desk.js';
import { FakeVoice, silentWav } from './fixture.js';

const LAYOUT: BenchWorkspace[] = [
  { label: 'alpha', panes: [{ name: 'a1', kind: 'agent' }, { name: 'a2', kind: 'agent' }, { name: 'sh', kind: 'shell' }, { name: 'cx', kind: 'agent', as: 'codex' }] },
  { label: 'beta', panes: [{ name: 'b1', kind: 'agent' }] },
];
const front = (s: Desk, name: string) => s.bench.client.call('pane.focus', { pane_id: s.bench.pane(name) });
const focusedIs = (s: Desk, name: string) => s.bench.waitFor(async () => s.mirror.shelf().focusedId === s.bench.pane(name), `${name} in front`);
const shows = (s: Desk, name: string, words: string) => s.bench.waitFor(async () => (await s.text(s.bench.pane(name))).includes(words), `"${words}" in ${name}`, 15_000);
const settle = () => new Promise(resolve => setTimeout(resolve, 300));
const status = async (s: Desk, name: string, state: string) => {
  await s.bench.type(name, `/status ${state}`);
  // Herdr shows a turn that ended out of sight as done, not idle.
  await s.bench.waitFor(async () => { const now = s.mirror.shelf().sessions.find(x => x.id === s.bench.pane(name))?.status; return now === state || (state === 'idle' && now === 'done'); }, `${name} ${state}`);
};
/** Waits until the voice has been asked to say `n` phrases. */
const spoken = (v: FakeVoice, n: number) => new Promise<string[]>((resolve, reject) => {
  const until = Date.now() + 8000;
  const tick = () => v.spoken.length >= n ? resolve(v.spoken) : Date.now() > until ? reject(new Error(`voice asked ${v.spoken.length} of ${n}: ${JSON.stringify(v.spoken)}`)) : void setTimeout(tick, 25);
  tick();
});

test('a spoken command is answered aloud in a short phrase; noise, ignored speech and a typed draft are not', async () => {
  const voice = new FakeVoice();
  const s = await setup(LAYOUT, { voice });
  try {
    await front(s, 'a1'); await focusedIs(s, 'a1');
    await s.say('press enter');
    assert.deepEqual(await spoken(voice, 1), [`Pressed enter in a1`]);
    await s.say('');
    await s.sayStandby('summarize the ledger change');
    await s.say('summarize the ledger change');
    await settle();
    assert.deepEqual(voice.spoken, ['Pressed enter in a1'], 'nothing for noise, for ignored speech, or for a draft typed');
    await s.say('go to nowhere at all');
    assert.deepEqual((await spoken(voice, 2))[1], 'No project or session is called "nowhere at all".');
  } finally { await s.stop(); }
});

test('a close question and its end are spoken; the voice off says nothing, on says so, and both are kept across a restart', async () => {
  const voice = new FakeVoice();
  const data = mkdtempSync('/tmp/svl-settings-');
  const s = await setup(LAYOUT, { voice, settings: new Settings(data) });
  try {
    const asked = s.bridge.requestClose('sh');
    assert.deepEqual(await spoken(voice, 1), ['Close sh? Say yes or no.']);
    await s.bridge.act({ kind: 'answer', answer: false });
    await asked;
    assert.deepEqual(await spoken(voice, 2), ['Close sh? Say yes or no.', 'sh was not closed.']);
    await front(s, 'a1'); await focusedIs(s, 'a1');
    await s.say('voice off');
    await s.say('press enter');
    await settle();
    assert.equal(voice.spoken.length, 2, 'with the voice off nothing is spoken, "voice off" itself included');
    await s.say('read replies');
    assert.equal(new Settings(data).voice, false, 'kept in the settings file');
    assert.equal(new Settings(data).readReplies, true);
    await s.say('voice on');
    assert.deepEqual((await spoken(voice, 3))[2], 'The voice is on.');
    assert.equal(new Settings(data).voice, true);
    assert.equal(new Settings(mkdtempSync('/tmp/svl-settings-')).voice, true, 'on by default');
    assert.equal(new Settings().readReplies, false, 'reading is off by default');
  } finally { await s.stop(); rmSync(data, { recursive: true, force: true }); }
});

test('"model sonnet" and "effort extra high" type the exact slash command into the session that was in front when the words began', async () => {
  const voice = new FakeVoice();
  const s = await setup(LAYOUT, { voice });
  try {
    await front(s, 'a1'); await focusedIs(s, 'a1');
    const model = await s.say('set model to sonnet');
    assert.equal(model.as, 'command');
    assert.equal(model.ok, true);
    assert.match(model.outcome, /Set model to claude-sonnet-5-5 in this session/, 'outcome says "in this session"');
    assert.match(model.outcome, /Your default for new sessions was kept/, 'outcome says default was kept');
    assert.ok(!model.outcome.includes('saved as your default'), 'outcome has no "saved as your default"');
    await shows(s, 'a1', 'a1 got: /model claude-sonnet-5-5');
    assert.deepEqual(await spoken(voice, 1), ['Set model to claude-sonnet-5-5 in this session.']);
    const effort = await s.say('effort extra high');
    assert.match(effort.outcome, /^Set effort level to xhigh/);
    await shows(s, 'a1', 'a1 got: /effort xhigh');
    // Heard while a1 was in front; focus moved since: it still goes to a1's neighbour only if that was the receiver.
    await front(s, 'a2'); await focusedIs(s, 'a2');
    const late = await s.say('model haiku', s.bench.pane('a1'));
    assert.equal(late.ok, true);
    await shows(s, 'a1', 'a1 got: /model claude-haiku-5-5');
    assert.equal((await s.text(s.bench.pane('a2'))).includes('got:'), false, 'the session now in front got nothing');
  } finally { await s.stop(); }
});

test('two commands said close together are carried out one after the other, each confirmed by its own line', async () => {
  const voice = new FakeVoice();
  const s = await setup(LAYOUT, { voice });
  try {
    await front(s, 'a1'); await focusedIs(s, 'a1');
    const [model, effort] = await Promise.all([s.say('model opus'), s.say('effort high')]);
    assert.match(model.outcome, /^Set model to claude-opus-5-5/);
    assert.match(effort.outcome, /^Set effort level to high/);
    const shown = await s.text(s.bench.pane('a1'));
    assert.ok(shown.indexOf('a1 got: /model claude-opus-5-5') >= 0 && shown.indexOf('a1 got: /effort high') > shown.indexOf('a1 got: /model claude-opus-5-5'), 'typed in the order said');
  } finally { await s.stop(); }
});

test('"model" or "effort" starting a longer sentence is a prompt, not the command', async () => {
  const s = await setup(LAYOUT, { voice: new FakeVoice() });
  try {
    await front(s, 'a1'); await focusedIs(s, 'a1');
    for (const words of ['model the database schema', 'effort estimate for the migration', 'model sonnet please']) {
      const u = await s.say(words);
      assert.equal(u.as, 'prompt', words);
      await s.say('scratch that');
    }
    assert.equal((await s.text(s.bench.pane('a1'))).includes('got:'), false);
  } finally { await s.stop(); }
});

test('it refuses a shell, another agent, a working or waiting session, a draft, a closed receiver and no receiver: nothing is typed, and the reason is said', async () => {
  const voice = new FakeVoice();
  const s = await setup(LAYOUT, { voice });
  try {
    const sent = async () => (await Promise.all(['a1', 'a2', 'sh', 'cx', 'b1'].map(async n => (await s.text(s.bench.pane(n))).includes('got:')))).some(Boolean);
    const refused = async (words: string, receiver: string | null, why: RegExp) => {
      const u = await s.say(words, receiver);
      assert.deepEqual([u.as, u.ok], ['command', false], words);
      assert.match(u.outcome, why);
    };
    await refused('model opus', s.bench.pane('sh'), /^Not changed: sh is a shell/);
    await refused('model opus', s.bench.pane('cx'), /^Not changed: cx is not a Claude Code session/);
    await status(s, 'a1', 'working');
    await refused('effort low', s.bench.pane('a1'), /^Not changed: a1 is working/);
    await status(s, 'a1', 'idle');
    // A draft waits in b1: the slash command would be joined to it.
    await front(s, 'b1'); await focusedIs(s, 'b1');
    await s.say('look at the ledger');
    await refused('model sonnet', s.bench.pane('b1'), /^Not changed: a draft waits in b1/);
    await refused('model sonnet', 'no-such-pane', /closed/);
    await refused('model sonnet', null, /No session is in front/);
    await s.bench.type('a2', '/block');
    await s.bench.waitFor(async () => s.mirror.shelf().sessions.find(x => x.id === s.bench.pane('a2'))?.status === 'blocked', 'a2 blocked');
    await refused('effort low', s.bench.pane('a2'), /^Not changed: a2 is waiting on a question/);
    assert.equal(await sent(), false, 'nothing was typed anywhere');
    assert.deepEqual(voice.spoken.slice(0, 2).map(t => t.split(' ')[2]), ['sh', 'cx'], 'each refusal is said');
  } finally { await s.stop(); }
});

test('a session that prints nothing is not claimed to have changed: the answer says it was sent and not confirmed', async () => {
  const voice = new FakeVoice();
  const s = await setup(LAYOUT, { voice, confirmMs: 600 });
  try {
    await s.bench.type('a1', '/confirm off');
    await front(s, 'a1'); await focusedIs(s, 'a1');
    const u = await s.say('effort high');
    assert.equal(u.ok, true);
    assert.equal(u.outcome, 'Sent /effort high to a1. It did not show that it took effect.');
    await shows(s, 'a1', 'a1 got: /effort high');
    assert.doesNotMatch(u.outcome, /^Set /);
    assert.equal((await spoken(voice, 1))[0], 'Sent /effort high to a1.');
  } finally { await s.stop(); }
});

test('a repeated command is confirmed by its own new line, not by the old one', async () => {
  const s = await setup(LAYOUT, { voice: new FakeVoice(), confirmMs: 600 });
  try {
    await front(s, 'a1'); await focusedIs(s, 'a1');
    assert.match((await s.say('model opus')).outcome, /^Set model to claude-opus-5-5/);
    await s.bench.type('a1', '/confirm off');
    const again = await s.say('model opus');
    assert.match(again.outcome, /did not show that it took effect/, 'the earlier confirmation is not taken for this one');
  } finally { await s.stop(); }
});

test('with listening off the command is asked first and typed only after a yes; a no, a lapse or other speech types nothing', async () => {
  const voice = new FakeVoice();
  const s = await setup(LAYOUT, { voice, standbyAnswerMs: 500 });
  try {
    await front(s, 'a1'); await focusedIs(s, 'a1');
    const asked = await s.sayStandby('model sonnet');
    assert.equal(asked.outcome, 'Do “Set the model to sonnet in a1”? Say “yes” or “no”.');
    assert.equal((await spoken(voice, 1))[0], 'Do "Set the model to sonnet in a1"? Say "yes" or "no".');
    await settle();
    assert.equal((await s.text(s.bench.pane('a1'))).includes('got:'), false, 'nothing before the yes');
    const yes = await s.sayStandby('yes');
    assert.match(yes.outcome, /^Answered yes: Set the model to sonnet in a1\. Set model to claude-sonnet-5-5/);
    await shows(s, 'a1', 'a1 got: /model claude-sonnet-5-5');
    assert.equal((await spoken(voice, 2))[1], 'Set model to claude-sonnet-5-5 in this session.', 'the answer is what the session said, not the yes');
    await s.sayStandby('effort low');
    assert.match((await s.sayStandby('no')).outcome, /^Answered no/);
    await s.sayStandby('effort low');
    await s.sayStandby('summarize the ledger change');
    await s.sayStandby('yes');
    await s.sayStandby('effort low');
    await new Promise(resolve => setTimeout(resolve, 800));
    assert.equal((await s.text(s.bench.pane('a1'))).includes('/effort'), false, 'no, other speech, and a lapse all typed nothing');
    // Listening on: at once, no question.
    assert.equal((await s.say('effort low')).ok, true);
    await shows(s, 'a1', 'a1 got: /effort low');
  } finally { await s.stop(); }
});

test('a voice that fails, is missing or answers badly is told once, logged without the words, and works again on the next phrase', async () => {
  const voice = new FakeVoice();
  const log: string[] = [];
  const s = await setup(LAYOUT, { voice, log: l => log.push(l) });
  const notices: string[] = [];
  const trouble: boolean[] = [];
  s.bridge.connect(e => { if (e.type === 'notice') notices.push(e.text); if (e.type === 'voice') trouble.push(e.trouble); });
  try {
    await front(s, 'a1'); await focusedIs(s, 'a1');
    voice.mode = 'fail';
    await s.say('press enter'); await s.say('press enter');
    await spoken(voice, 2); await settle();
    assert.equal(notices.filter(n => n.startsWith('The voice did not work')).length, 1, 'one notice for a run of failures');
    assert.ok(log.some(l => l === 'the voice failed: the voice made no audio'));
    assert.doesNotMatch(log.join('\n'), /Pressed enter/, 'the log holds none of the words');
    voice.mode = 'unavailable';
    await s.say('press enter');
    await settle();
    assert.equal(voice.spoken.length, 2, 'a voice that cannot work is not asked');
    voice.mode = 'ok';
    const events: BridgeEvent[] = [];
    s.bridge.connect(e => events.push(e));
    await s.say('press enter');
    await spoken(voice, 3); await settle();
    assert.ok(events.some(e => e.type === 'say'), 'it works again with no restart');
    assert.deepEqual(trouble, [false, true, false], 'the page is told when the voice fails, and again when it works: the shelf shows a chip meanwhile');
  } finally { await s.stop(); }
});

test('the voice keeps to its bounds: a burst of phrases leaves few waiting and few kept, and a stop drops them all', async () => {
  const events: BridgeEvent[] = [];
  const asked: string[] = [];
  let release: () => void = () => undefined;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const voice = { problem: () => null, speak: async (t: string) => { asked.push(t); await gate; return silentWav(0.05); } };
  const say = new Say(voice, e => events.push(e), () => undefined, () => undefined);
  for (let i = 0; i < 50; i += 1) say.say(`phrase ${i}`);
  release();
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.ok(asked.length <= 1 + WAITING_MAX, `asked ${asked.length} of 50`);
  assert.deepEqual(asked.slice(1), ['phrase 47', 'phrase 48', 'phrase 49'].slice(-(asked.length - 1)), 'the newest wait, the oldest are dropped');
  for (let i = 0; i < 40; i += 1) { say.say(`more ${i}`); await new Promise(resolve => setTimeout(resolve, 5)); }
  await new Promise(resolve => setTimeout(resolve, 100));
  const ids = events.filter(e => e.type === 'say').map(e => (e as { id: string }).id);
  assert.ok(ids.filter(id => say.clip(id)).length <= CLIPS_KEPT, 'only the latest clips are kept');
  say.stop();
  assert.equal(ids.filter(id => say.clip(id)).length, 0, 'a stop drops the kept audio');
  assert.equal(events.at(-1)?.type, 'say-stop');
});

test('a phrase being made when the voice is stopped is thrown away, not played after the stop', async () => {
  const events: BridgeEvent[] = [];
  let release: () => void = () => undefined;
  const slow = new Promise<void>(resolve => { release = resolve; });
  const say = new Say({ problem: () => null, speak: async () => { await slow; return silentWav(0.05); } }, e => events.push(e), () => undefined, () => undefined);
  say.say('late');
  say.stop();
  release();
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.deepEqual(events.map(e => e.type), ['say-stop']);
});

/** A Claude Code session in the bench: Herdr is told the session id its transcript is kept under. */
async function withSession(s: Desk, name: string, id: string, lines: string[], root: string): Promise<void> {
  await s.bench.client.call('pane.report_agent_session', { pane_id: s.bench.pane(name), agent: 'claude', source: 'herdr:claude', agent_session_id: id });
  mkdirSync(join(root, '-bench'), { recursive: true });
  writeFileSync(join(root, '-bench', `${id}.jsonl`), `${lines.join('\n')}\n`);
}
const reply = (text: string) => JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });

test('"read that" reads the last reply of the session in front, in whole sentences with the code left out; every refusal is said in words', async () => {
  const voice = new FakeVoice();
  const root = mkdtempSync('/tmp/svl-reply-');
  const s = await setup(LAYOUT, { voice, transcripts: root });
  try {
    await withSession(s, 'a1', '3ef33647-fde2-4a68-8e47-4eb1af3f9da6', [reply('Old one.'), reply('The tests pass. Run `npm test` again if you like.\n\n```sh\nnpm test\n```\n\nSee https://example.com/x.')], root);
    await front(s, 'a1'); await focusedIs(s, 'a1');
    const u = await s.say('read that');
    assert.deepEqual([u.as, u.ok], ['command', true]);
    assert.deepEqual(await spoken(voice, 1), ['The tests pass. Run npm test again if you like. See a link.']);
    // No transcript for the session in front, a shell, another agent, no session.
    await front(s, 'a2'); await focusedIs(s, 'a2');
    assert.match((await s.say('read that')).outcome, /^Herdr has no transcript for that session/);
    await s.bench.client.call('pane.report_agent_session', { pane_id: s.bench.pane('a2'), agent: 'claude', source: 'herdr:claude', agent_session_id: '11111111-2222-3333-4444-555555555555' });
    assert.equal((await s.say('read that')).outcome, 'No transcript was found for that session.');
    await front(s, 'sh'); await focusedIs(s, 'sh');
    assert.match((await s.say('read that')).outcome, /^sh is not a Claude Code session/);
    await front(s, 'cx'); await focusedIs(s, 'cx');
    assert.match((await s.say('read that')).outcome, /^cx is not a Claude Code session/);
    assert.deepEqual(voice.spoken.length >= 5, true, 'each refusal was said too');
    // A transcript that is there but cannot be opened is said as such, not as a missing one.
    await front(s, 'b1'); await focusedIs(s, 'b1');
    await withSession(s, 'b1', 'acc397dd-b703-4cbc-b006-03de05f5dc38', [reply('Hidden.')], root);
    chmodSync(join(root, '-bench', 'acc397dd-b703-4cbc-b006-03de05f5dc38.jsonl'), 0o000);
    try { assert.equal((await s.say('read that')).outcome, 'Its transcript could not be read.'); } finally { chmodSync(join(root, '-bench', 'acc397dd-b703-4cbc-b006-03de05f5dc38.jsonl'), 0o600); }
    // The voice off: nothing to read with.
    await s.say('voice off');
    await front(s, 'a1'); await focusedIs(s, 'a1');
    assert.equal((await s.say('read that')).outcome, 'The voice is off. Say “voice on” first.');
  } finally { await s.stop(); rmSync(root, { recursive: true, force: true }); }
});

test('with reading on, the reply of a turn that ends in the session in front is read once; one in another session, or one already read, is not; off, nothing', async () => {
  const voice = new FakeVoice();
  const root = mkdtempSync('/tmp/svl-reply-');
  // Herdr's agent state is the stand-ins' own; the session ids come from a stand-in seam here (the Herdr lookup is tested above).
  const ids = new Map<string, string>();
  const s = await setup(LAYOUT, { voice, transcripts: root, sessionOf: async pane => ids.get(pane) ?? null });
  const keep = (name: string, id: string, lines: string[]) => { ids.set(s.bench.pane(name), id); mkdirSync(join(root, '-bench'), { recursive: true }); writeFileSync(join(root, '-bench', `${id}.jsonl`), `${lines.join('\n')}\n`); };
  try {
    keep('a1', '3ef33647-fde2-4a68-8e47-4eb1af3f9da6', [reply('First reply in a1.')]);
    keep('a2', 'acc397dd-b703-4cbc-b006-03de05f5dc38', [reply('Reply in a2.')]);
    await front(s, 'a1'); await focusedIs(s, 'a1');
    // Off by default: a finished turn is not read.
    await status(s, 'a1', 'working'); await status(s, 'a1', 'idle');
    await new Promise(resolve => setTimeout(resolve, 900));
    assert.equal(voice.spoken.length, 0, 'reading is off by default');
    await s.say('read replies');
    await spoken(voice, 1);
    voice.spoken.length = 0;
    await status(s, 'a1', 'working'); await status(s, 'a1', 'idle');
    assert.deepEqual(await spoken(voice, 1), ['First reply in a1.']);
    // The same reply again (a state that flickers): not read twice.
    await status(s, 'a1', 'working'); await status(s, 'a1', 'idle');
    await new Promise(resolve => setTimeout(resolve, 900));
    assert.equal(voice.spoken.length, 1, 'one reply is read once');
    // A new reply is read; another session's turn is not.
    writeFileSync(join(root, '-bench', '3ef33647-fde2-4a68-8e47-4eb1af3f9da6.jsonl'), `${reply('First reply in a1.')}\n${reply('Second reply in a1.')}\n`);
    await status(s, 'a2', 'working'); await status(s, 'a2', 'idle');
    await status(s, 'a1', 'working'); await status(s, 'a1', 'idle');
    assert.deepEqual(await spoken(voice, 2), ['First reply in a1.', 'Second reply in a1.']);
    await new Promise(resolve => setTimeout(resolve, 600));
    assert.equal(voice.spoken.length, 2, 'a2 was not in front');
    // Reading off again.
    await s.say('stop reading replies');
    writeFileSync(join(root, '-bench', '3ef33647-fde2-4a68-8e47-4eb1af3f9da6.jsonl'), `${reply('Third reply in a1.')}\n`);
    await status(s, 'a1', 'working'); await status(s, 'a1', 'idle');
    await new Promise(resolve => setTimeout(resolve, 900));
    assert.equal(voice.spoken.some(t => t.includes('Third')), false);
  } finally { await s.stop(); rmSync(root, { recursive: true, force: true }); }
});

test('reading turned off while a finished turn waits to be read: that reply is not read', async () => {
  const voice = new FakeVoice();
  const root = mkdtempSync('/tmp/svl-reply-');
  const ids = new Map<string, string>();
  const s = await setup(LAYOUT, { voice, transcripts: root, sessionOf: async pane => ids.get(pane) ?? null });
  try {
    ids.set(s.bench.pane('a1'), '3ef33647-fde2-4a68-8e47-4eb1af3f9da6');
    mkdirSync(join(root, '-bench'), { recursive: true });
    writeFileSync(join(root, '-bench', '3ef33647-fde2-4a68-8e47-4eb1af3f9da6.jsonl'), `${reply('A reply that must stay unread.')}\n`);
    await front(s, 'a1'); await focusedIs(s, 'a1');
    await s.say('read replies');
    await spoken(voice, 1);
    voice.spoken.length = 0;
    await s.bench.type('a1', '/status working');
    await s.bench.waitFor(async () => s.mirror.shelf().sessions.find(x => x.id === s.bench.pane('a1'))?.status === 'working', 'a1 working');
    // The turn ends and, inside the wait before its reply is read, the owner turns reading off.
    await s.bench.type('a1', '/status idle');
    await s.bench.waitFor(async () => s.mirror.shelf().sessions.find(x => x.id === s.bench.pane('a1'))?.status === 'idle', 'a1 idle');
    await s.say('stop reading replies');
    await new Promise(resolve => setTimeout(resolve, 900));
    assert.equal(voice.spoken.length, 0, 'nothing was read after the stop');
  } finally { await s.stop(); rmSync(root, { recursive: true, force: true }); }
});

test('what is read aloud never reaches the log, a notice or a session', async () => {
  const voice = new FakeVoice();
  const root = mkdtempSync('/tmp/svl-reply-');
  const log: string[] = [];
  const s = await setup(LAYOUT, { voice, transcripts: root, log: l => log.push(l) });
  const events: BridgeEvent[] = [];
  s.bridge.connect(e => events.push(e));
  try {
    await withSession(s, 'a1', '3ef33647-fde2-4a68-8e47-4eb1af3f9da6', [reply('The zebra marker sentence is secret.')], root);
    await front(s, 'a1'); await focusedIs(s, 'a1');
    await s.say('read that');
    assert.deepEqual(await spoken(voice, 1), ['The zebra marker sentence is secret.']);
    await settle();
    assert.doesNotMatch(log.join('\n'), /zebra/);
    assert.doesNotMatch(JSON.stringify(events.filter(e => e.type !== 'text')), /zebra/, 'not in any event the page is sent, the shelf included');
    assert.equal((await s.text(s.bench.pane('a1'))).includes('zebra'), false, 'not typed into the session');
  } finally { await s.stop(); rmSync(root, { recursive: true, force: true }); }
});
