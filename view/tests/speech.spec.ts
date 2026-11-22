import { expect, test, type Page } from '@playwright/test';
import { dataDirectory } from '../bridge/config.js';
import { LocalSpeech, modelDirectory, SPEECH_MODEL } from '../bridge/speech.js';
import { normalize } from '../bridge/heard.js';
import { COMMANDS } from '../shared/actions.js';
import { plain } from '../shared/ansi.js';
import { slug } from '../bench/phrases.js';
import { aim, emulateQuest, enterMixedReality, pair, press, regionPoint, rig, say, viewState, type Rig, seatOf, shownLight } from './fixture.js';

// Real speech: the local model on audio synthesized by bench/make-speech.ts, fed through the
// page's microphone path. Only the microphone device itself is replaced.
test.use({ ignoreHTTPSErrors: true, viewport: { width: 1400, height: 900 } });
test.describe.configure({ mode: 'serial' });

let r: Rig;
const heard: { said: string; heard: string }[] = [];
test.afterEach(async () => { await r?.stop(); });
test.afterAll(() => {
  const digits = (t: string) => normalize(t).replace(/\b(one|two|three)\b/g, w => String(['one', 'two', 'three'].indexOf(w) + 1));
  const wrong = heard.filter(h => digits(h.heard) !== digits(h.said));
  console.log(`speech model ${SPEECH_MODEL}: ${heard.length} phrases, ${wrong.length} heard differently${wrong.map(w => `\n  said "${w.said}" heard "${w.heard}"`).join('')}`);
});

async function start(page: Page): Promise<void> {
  const speech = new LocalSpeech(modelDirectory(dataDirectory()));
  await speech.load();
  test.skip(!speech.state().ready, 'speech model not set up: npm run view:setup');
  r = await rig([
    { label: 'alpha', panes: [{ name: 'agent1', kind: 'agent' }, { name: 'keys', kind: 'shell' }] },
    { label: 'beta', panes: [{ name: 'waiter', kind: 'agent' }] },
  ], { speech });
  await emulateQuest(page);
  await pair(page, r);
  await page.evaluate(() => window.viewTest.fakeMic());
  await enterMixedReality(page);
}

async function utter(page: Page, phrase: string, beforeRelease?: () => Promise<void>) {
  await say(page, slug(phrase), beforeRelease);
  const last = (await viewState(page)).last;
  if (!last) throw new Error('no utterance shown');
  heard.push({ said: phrase, heard: last.heard });
  return last;
}

const paneText = async (id: string) => plain(await r.bench.client.read(id, 60));

test('hold to talk: keys, showing, next waiting and back, prompts and helper orders, each spoken', async ({ page }) => {
  test.setTimeout(180_000);
  await start(page);
  expect((await viewState(page)).mic, 'listening is off when the page opens').toMatchObject({ open: false, mode: 'hold' });

  // Keys go to the receiver as keys, never as words.
  await r.bench.client.call('pane.focus', { pane_id: r.bench.pane('keys') });
  await r.bench.type('keys', 'cat -v');
  // A spoken key goes to the session shown in front when the speech begins: wait until it is shown.
  await expect.poll(async () => (await viewState(page)).receiver).toBe(r.bench.pane('keys'));
  for (const phrase of ['press yes', 'press no', 'press one', 'press two', 'press three', 'press tab', 'press up', 'press down', 'press escape', 'press enter']) {
    const u = await utter(page, phrase);
    expect(u, phrase).toMatchObject({ as: 'command', ok: true });
    expect(u.outcome).toContain('in keys');
  }
  await expect.poll(() => paneText(r.bench.pane('keys'))).toMatch(/yn123\s+\^\[\[A\^\[\[B\^\[/);
  expect(await paneText(r.bench.pane('keys')), 'a command is not also typed as words').not.toContain('press');
  await utter(page, 'interrupt');
  await expect.poll(() => paneText(r.bench.pane('keys'))).toMatch(/\^C\s*\n?.*\$ ?$/);

  // Showing by number, then next waiting and back.
  expect((await utter(page, 'show three')).outcome).toBe('Showing waiter');
  await expect.poll(async () => (await viewState(page)).front).toBe(r.bench.pane('waiter'));
  await utter(page, 'show two');
  await expect.poll(async () => (await viewState(page)).front).toBe(r.bench.pane('keys'));
  await r.bench.type('waiter', '/block');
  await expect.poll(async () => shownLight(await viewState(page), r.bench.pane('waiter'))).toBe('blocked');
  await utter(page, 'next waiting');
  await expect.poll(async () => (await viewState(page)).front).toBe(r.bench.pane('waiter'));
  await utter(page, 'back');
  await expect.poll(async () => (await viewState(page)).front).toBe(r.bench.pane('keys'));

  // A prompt goes to the receiver; one that only starts like a command is still a prompt.
  await r.bench.client.call('pane.focus', { pane_id: r.bench.pane('agent1') });
  await expect.poll(async () => (await viewState(page)).receiver).toBe(r.bench.pane('agent1'));
  for (const phrase of ['summarize the ledger change', 'back up the database before you migrate']) {
    const u = await utter(page, phrase);
    expect(u, phrase).toMatchObject({ as: 'prompt', ok: true, outcome: 'Sent to agent1' });
    await expect.poll(async () => normalize(await paneText(r.bench.pane('agent1')))).toContain(`received ${normalize(phrase)}`);
  }

  // An order to the helper (started for it, the order held until it is ready), and the overview.
  const order = await utter(page, 'helper, count the files in the current folder');
  expect(order).toMatchObject({ as: 'helper', ok: true });
  expect((await viewState(page)).front, 'an order to the helper does not change what is in front').toBe(r.bench.pane('agent1'));
  await expect.poll(async () => { const seat = await seatOf(r.bench, 'helper'); return seat ? normalize(await paneText(seat)) : ''; }, { timeout: 20_000 }).toContain('received count the files in the current folder');
  await utter(page, 'overview');
  await expect.poll(async () => (await viewState(page)).front).toBe(await seatOf(r.bench, 'helper'));
  expect((await viewState(page)).place).toEqual({ overview: true });
  // Going into a project by voice: its agent comes to the front.
  await utter(page, 'go to beta');
  await expect.poll(async () => (await viewState(page)).front, { timeout: 20_000 }).toBe(await seatOf(r.bench, 'beta'));
});

test('the listening switch, the view\'s own actions, and a close answered by voice', async ({ page }) => {
  test.setTimeout(180_000);
  await start(page);
  // "keep listening" turns listening on at once.
  await utter(page, 'keep listening');
  await expect.poll(async () => (await viewState(page)).mic).toMatchObject({ mode: 'switch', open: true });
  const mic = await regionPoint(page, 'talk', 'talk');

  const pageActions: [string, (s: Awaited<ReturnType<typeof viewState>>) => unknown, unknown][] = [
    ['scroll up', s => s.scroll > 0, true],
    ['scroll down', s => s.scroll, 0],
    ['scroll up', s => s.scroll > 0, true],
    ['scroll bottom', s => s.scroll, 0],
    ['bigger text', s => s.scale, 1.1],
    ['smaller text', s => s.scale, 1],
    ['recenter', s => s.notice, 'Shelf recentred in front of you.'],
  ];
  await r.bench.type('agent1', '/burst 120');
  for (const [phrase, read, expected] of pageActions) {
    const u = await utter(page, phrase);
    expect(u.as, phrase).toBe('command');
    await expect.poll(async () => read(await viewState(page)), { message: phrase }).toBe(expected);
  }

  // A close the helper asked for: "no" keeps it, "yes" closes it.
  const keys = r.bench.pane('keys');
  let answer = r.view.bridge.requestClose('keys');
  await expect.poll(async () => (await viewState(page)).confirm?.name ?? '').toMatch(/^\d+ keys \(/);
  await utter(page, 'no');
  expect(await answer).toBe('declined');
  expect((await r.bench.client.snapshot()).panes.some(p => p.id === keys)).toBe(true);
  answer = r.view.bridge.requestClose('keys');
  await expect.poll(async () => (await viewState(page)).confirm?.name ?? '').toMatch(/^\d+ keys \(/);
  await utter(page, 'yes');
  expect(await answer).toBe('closed');
  expect((await r.bench.client.snapshot()).panes.some(p => p.id === keys)).toBe(false);

  await utter(page, 'stop listening');
  expect((await viewState(page)).mic.open).toBe(false);
  // A tap on Talk turns keep listening on again.
  await aim(page, 'controller', 'talk', mic.x, mic.y);
  await press(page, 'controller');
  await expect.poll(async () => (await viewState(page)).mic.open).toBe(true);
  await utter(page, 'hold to talk');
  expect((await viewState(page)).mic).toMatchObject({ mode: 'hold', open: false });
});

test('every action the view performs has a spoken form', () => {
  // The registry is what the page's handlers and the bridge's actions dispatch on; the two
  // parametric actions (show a session, prompt) and helper orders are spoken above.
  for (const c of COMMANDS) expect(c.say.length, c.id).toBeGreaterThan(0);
});
