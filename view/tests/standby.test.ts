/**
 * Standby: listening is off but the microphone is open, so speech arrives marked standby. Only
 * commands are acted on, each after the owner's "yes"; a prompt or an order is shown as ignored and
 * reaches no session; and a "yes" answers exactly one question. Driven on the bench with scripted
 * speech; the page's microphone is tested in the browser.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BenchWorkspace } from '../bench/bench.js';
import { COMMANDS } from '../shared/actions.js';
import { setup, type Desk } from './desk.js';

const LAYOUT: BenchWorkspace[] = [
  { label: 'alpha', panes: [{ name: 'a1', kind: 'agent' }, { name: 'a2', kind: 'agent' }, { name: 'sh', kind: 'shell' }] },
  { label: 'beta', panes: [{ name: 'b1', kind: 'agent' }] },
];
const front = (s: Desk, name: string) => s.bench.client.call('pane.focus', { pane_id: s.bench.pane(name) });
const focusedIs = (s: Desk, name: string) => s.bench.waitFor(async () => s.mirror.shelf().focusedId === s.bench.pane(name), `${name} in front`);
const shows = (s: Desk, name: string, words: string) => s.bench.waitFor(async () => (await s.text(s.bench.pane(name))).includes(words), `"${words}" in ${name}`, 15_000);
const settle = () => new Promise(resolve => setTimeout(resolve, 400));
const lines = (log: string[]) => log.join('\n');

test('with listening off, a prompt or an order is ignored and reaches no session, not even as typed words', async () => {
  const log: string[] = [];
  const s = await setup(LAYOUT, { log: l => log.push(l) });
  try {
    await front(s, 'a1');
    await focusedIs(s, 'a1');
    const prompt = await s.sayStandby('summarize the ledger change');
    assert.deepEqual([prompt.as, prompt.ok], ['ignored', false]);
    assert.match(prompt.outcome, /Listening is off: that was heard and sent nowhere/);
    const order = await s.sayStandby('helper, count the files in the folder');
    assert.equal(order.as, 'ignored');
    assert.equal((await s.sayStandby('yes')).as, 'ignored', 'a yes with nothing waiting is not a command');
    assert.equal((await s.sayStandby('show me the failing test')).as, 'ignored', '"show" naming nothing is a prompt');
    // With direct sending on, too: standby sends nothing.
    await s.bridge.act({ kind: 'direct', on: true });
    assert.equal((await s.sayStandby('summarize the ledger change')).as, 'ignored');
    await settle();
    assert.deepEqual(await s.received(), [], 'nothing was sent anywhere');
    for (const id of s.mirror.shelf().sessions.map(x => x.id)) assert.equal((await s.text(id)).includes('ledger'), false, `no typed words in ${id}`);
    assert.deepEqual(s.bridge.shelf().drafts, []);
    assert.equal((await s.seats()).length, 0, 'the helper was not even started');
    assert.doesNotMatch(lines(log), /ledger|count the files/, 'the log holds none of the words heard');
  } finally { await s.stop(); }
});

test('with listening off, a command that only changes the view runs at once; any other asks "yes" first and is done only after it', async () => {
  const log: string[] = [];
  const s = await setup(LAYOUT, { log: l => log.push(l) });
  try {
    const seen = s.watch();
    await front(s, 'a1');
    await focusedIs(s, 'a1');
    // View-only: at once, no question.
    for (const phrase of ['scroll up', 'scroll down', 'scroll bottom', 'recenter', 'bigger text', 'smaller text']) {
      const u = await s.sayStandby(phrase);
      assert.deepEqual([u.as, u.ok], ['command', true], phrase);
      assert.equal(seen.ask, null, `${phrase} asks nothing`);
    }
    assert.deepEqual(seen.pageActions, ['scroll-up', 'scroll-down', 'scroll-bottom', 'recenter', 'text-bigger', 'text-smaller']);

    // A navigation: asked, nothing moves, then a yes moves it.
    const asked = await s.sayStandby('go to beta');
    assert.match(asked.outcome, /^Do “Go to beta”\? Say “yes” or “no”\.$/);
    assert.equal(seen.ask, 'Go to beta');
    await settle();
    assert.equal(await s.focused(), s.bench.pane('a1'), 'asked, not done');
    const yes = await s.sayStandby('yes');
    assert.match(yes.outcome, /^Answered yes: Go to beta\. /);
    assert.equal(seen.ask, null);
    await s.bench.waitFor(async () => s.mirror.shelf().projects.some(p => p.label === 'beta') && (await s.focused()) !== s.bench.pane('a1'), 'beta in front');
    await front(s, 'a1');
    await focusedIs(s, 'a1');

    // A key goes to the session the owner was looking at when speaking, and is asked first.
    assert.equal((await s.say('a draft to send')).ok, true, 'typed while listening, earlier');
    await shows(s, 'a1', 'a draft to send');
    const goAsked = await s.sayStandby('go');
    assert.match(goAsked.outcome, /^Do “Send the draft in a1”\?/);
    await settle();
    assert.deepEqual(await s.received(), [], 'asked, not sent');
    assert.match((await s.sayStandby('yes')).outcome, /^Answered yes: Send the draft in a1\./);
    await shows(s, 'a1', 'received: a draft to send');

    // A no drops it; so does anything else said, and so does a silence.
    assert.equal((await s.say('another draft')).ok, true);
    await s.sayStandby('scratch that');
    assert.equal(seen.ask, 'Clear the draft in a1');
    assert.match((await s.sayStandby('no')).outcome, /^Answered no: “Clear the draft in a1” was not done\./);
    assert.deepEqual(s.bridge.shelf().drafts, [s.bench.pane('a1')], 'a no cleared nothing');
    await s.sayStandby('scratch that');
    assert.equal((await s.sayStandby('bigger text')).ok, true);
    assert.equal(seen.ask, null, 'anything but a yes or no drops it');
    assert.equal((await s.sayStandby('yes')).as, 'ignored', 'so a yes after it answers nothing');
    assert.deepEqual(s.bridge.shelf().drafts, [s.bench.pane('a1')]);
    await s.sayStandby('scratch that');
    assert.equal((await s.sayStandby('some other words')).as, 'ignored');
    assert.equal(seen.ask, null);
    await s.sayStandby('scratch that');
    assert.match((await s.sayStandby('yes')).outcome, /^Answered yes: Clear the draft in a1/);
    assert.deepEqual(s.bridge.shelf().drafts, []);
    assert.equal(seen.both, false, 'a close and a command never wait together');

    // The log names what was asked, confirmed and dropped, by the command, never by the words.
    assert.match(lines(log), /standby command "Go to beta" asked of the owner/);
    assert.match(lines(log), /standby command "Go to beta" confirmed by the owner/);
    assert.match(lines(log), /standby command "Clear the draft in a1" dropped: the owner said no/);
    assert.match(lines(log), /standby command "Clear the draft in a1" dropped: something else was said instead/);
  } finally { await s.stop(); }
});

test('a question that gets no answer lapses, and nothing is done', async () => {
  const log: string[] = [];
  const s = await setup(LAYOUT, { standbyAnswerMs: 300, log: l => log.push(l) });
  try {
    const seen = s.watch();
    await front(s, 'a1');
    await focusedIs(s, 'a1');
    await s.sayStandby('go to beta');
    assert.equal(seen.ask, 'Go to beta');
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.equal(seen.ask, null);
    assert.match(lines(log), /standby command "Go to beta" dropped: no answer in time/);
    assert.equal((await s.sayStandby('yes')).as, 'ignored', 'a late yes answers nothing');
    assert.equal(await s.focused(), s.bench.pane('a1'));
  } finally { await s.stop(); }
});

test('every command in the registry is heard in standby, and asks before it acts unless it only changes the view', async () => {
  const s = await setup(LAYOUT);
  try {
    const seen = s.watch();
    await front(s, 'a1');
    await focusedIs(s, 'a1');
    for (const c of COMMANDS.filter(c => !c.whenConfirming)) {
      const u = await s.sayStandby(c.say[0] as string);
      assert.equal(u.as, 'command', c.id);
      if (c.viewOnly) assert.equal(seen.ask, null, `${c.id} runs at once`);
      else {
        assert.notEqual(seen.ask, null, `${c.id} asks`);
        await s.sayStandby('no');
      }
      assert.equal(seen.ask, null);
    }
    await settle();
    assert.deepEqual(await s.received(), []);
    assert.equal(await s.focused(), s.bench.pane('a1'), 'no command was done');
  } finally { await s.stop(); }
});

test('a yes answers exactly one question: a close and a standby command never wait together, in either order', async () => {
  const s = await setup(LAYOUT, { closeAnswerMs: 5000 });
  try {
    const seen = s.watch();
    await front(s, 'a1');
    await focusedIs(s, 'a1');

    // A close waits; a command heard in standby is refused, and the yes answers the close only.
    const close = s.bridge.requestClose('sh');
    await s.bench.waitFor(async () => seen.confirm !== null, 'the close put to the owner');
    const refused = await s.sayStandby('go to beta');
    assert.equal(refused.ok, false);
    assert.match(refused.outcome, /A close is waiting for your yes or no first\. Nothing was done\./);
    assert.equal(seen.ask, null);
    const yesClose = await s.sayStandby('yes');
    assert.match(yesClose.outcome, /^Answered yes to closing \d+ sh \(alpha\)\./, 'the strip says it answered the close');
    assert.equal(await close, 'closed');
    await settle();
    assert.equal(await s.focused(), s.bench.pane('a1'), 'the refused command was not done by that yes');

    // A command waits; a close asked meanwhile is refused as busy, and the yes answers the command only.
    await s.sayStandby('go to beta');
    assert.equal(seen.ask, 'Go to beta');
    assert.equal(await s.bridge.requestClose('a2'), 'busy');
    assert.equal(seen.confirm, null);
    const yesCommand = await s.sayStandby('yes');
    assert.match(yesCommand.outcome, /^Answered yes: Go to beta\./, 'the strip says it answered the command');
    assert.equal((await s.snap()).panes.some(p => p.id === s.bench.pane('a2')), true, 'a2 was not closed by that yes');
    assert.equal(seen.both, false);
  } finally { await s.stop(); }
});

/** A small seeded random generator, so a failing sequence can be run again. */
function random(seed: number): () => number {
  let x = seed;
  return () => { x = (x * 1664525 + 1013904223) % 4294967296; return x / 4294967296; };
}

test('in any order of questions and answers, at most one question waits, and every yes does exactly what was asked', async () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const layout: BenchWorkspace[] = [
      { label: 'alpha', panes: [{ name: 'a1', kind: 'agent' }, ...[1, 2, 3, 4, 5, 6, 7, 8].map(n => ({ name: `c${n}`, kind: 'shell' as const }))] },
      { label: 'beta', panes: [{ name: 'b1', kind: 'agent' }] },
    ];
    const s = await setup(layout, { standbyAnswerMs: 700, closeAnswerMs: 700 });
    try {
      const seen = s.watch();
      const next = random(seed);
      await front(s, 'a1');
      await focusedIs(s, 'a1');
      type Waiting = 'none' | 'close' | 'command';
      let model: Waiting = 'none';
      let closes = 0;
      let moves = 0;
      const open = async () => (await s.snap()).panes.filter(p => /^c\d$/.test(String(p.label))).length;
      const pending: Promise<string>[] = [];
      const lapse = () => new Promise(resolve => setTimeout(resolve, 900));
      let closable = 1;
      for (let step = 0; step < 24; step += 1) {
        const pick = Math.floor(next() * 6);
        const before: string = `seed ${seed} step ${step} pick ${pick} model ${model}`;
        if (pick === 0) { // a command heard in standby
          const u = await s.sayStandby('go to beta');
          if (model === 'none') { assert.equal(u.ok, true, before); model = 'command'; } else if (model === 'close') assert.equal(u.ok, false, before);
          else assert.equal(u.ok, true, `${before}: a new command replaces nothing; the earlier one is dropped by this utterance, then this one is asked`);
        } else if (pick === 1) { // a yes
          const u = await s.sayStandby('yes');
          if (model === 'command') { moves += 1; assert.match(u.outcome, /^Answered yes: Go to beta/, before); } else if (model === 'close') { closes += 1; assert.match(u.outcome, /^Answered yes to closing/, before); } else assert.equal(u.as, 'ignored', before);
          model = 'none';
        } else if (pick === 2) { // a no
          const u = await s.sayStandby('no');
          if (model === 'command') assert.match(u.outcome, /^Answered no: “Go to beta”/, before);
          else if (model === 'close') assert.match(u.outcome, /^Answered no: .* stays open/, before);
          else assert.equal(u.as, 'ignored', before);
          model = 'none';
        } else if (pick === 3) { // the helper asks to close a session
          const ref = `c${closable}`;
          if (model === 'none') {
            pending.push(s.bridge.requestClose(ref));
            model = 'close';
            await s.bench.waitFor(async () => seen.confirm !== null, before, 3000);
          } else assert.equal(await s.bridge.requestClose(ref), 'busy', before);
        } else if (pick === 4) { // some other words
          await s.sayStandby('some other words');
          if (model === 'command') model = 'none';
        } else { // time passes: whatever waits lapses
          await lapse();
          model = 'none';
        }
        // After a yes that closed, the next close names another session.
        if (closes >= closable) closable = closes + 1;
        await s.bench.waitFor(async () => (seen.confirm !== null) === (model === 'close') && (seen.ask !== null) === (model === 'command'), `${before}: the page shows what the model says waits`, 3000);
        assert.equal(seen.both, false, `${before}: two questions waited together`);
        // The focus is only moved by a yes to the command: put it back, as the owner does at the desk.
        if (moves > 0) { await front(s, 'a1'); await focusedIs(s, 'a1'); moves = 0; }
      }
      await lapse();
      const results = await Promise.all(pending);
      assert.equal(results.filter(r => r === 'closed').length, 8 - await open(), `seed ${seed}: sessions closed equal closes the owner said yes to`);
      assert.equal(results.filter(r => r === 'closed').length, closes, `seed ${seed}: every yes to a close closed one, and nothing else did`);
    } finally { await s.stop(); }
  }
});
