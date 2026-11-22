import { expect, test, type Page } from '@playwright/test';
import { plain } from '../shared/ansi.js';
import { aim, emulateQuest, enterMixedReality, feed, pair, regionPoint, rig, say, ScriptedSpeech, seatOf, setPressed, shownLight, squeeze, tap as tapOn, viewState, wav, type Rig } from './fixture.js';

test.use({ ignoreHTTPSErrors: true, viewport: { width: 1400, height: 900 } });
let r: Rig;
let speech: ScriptedSpeech;
test.afterEach(async () => { await r?.stop(); });

const LAYOUT = [
  { label: 'alpha', panes: [{ name: 'a1', kind: 'agent' as const }, { name: 'keys', kind: 'shell' as const }] },
  { label: 'beta', panes: [{ name: 'w1', kind: 'agent' as const }, { name: 'w2', kind: 'agent' as const }] },
  { label: 'gamma', panes: [{ name: 'w3', kind: 'agent' as const }] },
];

async function start(page: Page, xr = true): Promise<void> {
  speech = new ScriptedSpeech();
  r = await rig(LAYOUT, { speech });
  if (xr) await emulateQuest(page);
  await pair(page, r);
  await page.evaluate(() => window.viewTest.fakeMic());
  if (xr) await enterMixedReality(page);
}
const front = async (page: Page) => (await viewState(page)).front;
const focus = (name: string) => r.bench.client.call('pane.focus', { pane_id: r.bench.pane(name) });
const plainText = async (name: string) => plain(await r.bench.client.read(r.bench.pane(name), 60));
const light = async (page: Page, name: string) => shownLight(await viewState(page), r.bench.pane(name));

for (const input of ['controller', 'hand'] as const) {
  test(`every action on the shelf can be done by ${input}`, async ({ page }) => {
    test.setTimeout(150_000);
    await start(page);
    const tap = (surface: string, id: string) => tapOn(page, input, surface, id);

    // Keys reach the receiver.
    await focus('keys');
    await r.bench.type('keys', 'cat -v');
    for (const id of ['y', 'n', 'one', 'two', 'three', 'tab', 'up', 'down', 'escape']) await tap('controls-1', id);
    await tap('controls-1', 'enter');
    await expect.poll(() => plainText('keys')).toMatch(/yn123\s+\^\[\[A\^\[\[B\^\[\s*\n/);
    await tap('controls-1', 'interrupt');
    await expect.poll(() => plainText('keys')).toContain('^C');

    // Scrolling, size, recentring.
    await focus('a1');
    await r.bench.type('a1', '/burst 120');
    await expect.poll(async () => (await page.evaluate(id => window.viewTest.text(id), r.bench.pane('a1'))).length).toBeGreaterThan(100);
    await tap('controls-0', 'scroll-up');
    await expect.poll(async () => (await viewState(page)).scroll).toBe(10);
    await tap('controls-0', 'scroll-up');
    await tap('controls-0', 'scroll-down');
    await expect.poll(async () => (await viewState(page)).scroll).toBe(10);
    await tap('controls-0', 'bottom');
    await expect.poll(async () => (await viewState(page)).scroll).toBe(0);

    // Grab the front text and drag it down: older lines come into view. "Latest" goes back.
    await aim(page, input, 'front', 0.5, 0.35);
    await setPressed(page, input, 1);
    for (const y of [0.45, 0.55, 0.65]) await aim(page, input, 'front', 0.5, y);
    await setPressed(page, input, 0);
    await expect.poll(async () => (await viewState(page)).scroll).toBeGreaterThan(5);
    await tap('controls-0', 'bottom');
    await expect.poll(async () => (await viewState(page)).scroll).toBe(0);
    if (input === 'controller') {
      // Thumbstick up scrolls back smoothly; released, it stops.
      await page.evaluate(() => (window as unknown as { __xr: { controllers: { right: { updateAxes(id: string, x: number, y: number): void } } } }).__xr.controllers.right.updateAxes('thumbstick', 0, -1));
      await page.waitForTimeout(600);
      await page.evaluate(() => (window as unknown as { __xr: { controllers: { right: { updateAxes(id: string, x: number, y: number): void } } } }).__xr.controllers.right.updateAxes('thumbstick', 0, 0));
      const after = (await viewState(page)).scroll;
      expect(after, 'about 30 rows a second at full push').toBeGreaterThan(5);
      expect(after).toBeLessThan(40);
      await page.waitForTimeout(300);
      expect((await viewState(page)).scroll, 'it stops when released').toBe(after);
      await tap('controls-0', 'bottom');
    }
    await tap('controls-0', 'bigger');
    await expect.poll(async () => (await viewState(page)).scale).toBe(1.1);
    await tap('controls-0', 'smaller');
    await expect.poll(async () => (await viewState(page)).scale).toBe(1);
    await tap('controls-0', 'recenter');
    await expect.poll(async () => (await viewState(page)).notice).toContain('recentred');

    // Next waiting and back.
    await r.bench.type('w2', '/block');
    await expect.poll(() => light(page, 'w2')).toBe('blocked');
    await tap('controls-0', 'next');
    await expect.poll(() => front(page)).toBe(r.bench.pane('w2'));
    await tap('controls-0', 'back');
    await expect.poll(() => front(page)).toBe(r.bench.pane('a1'));

    // The overview: the helper comes forward, so the desk keyboard types orders to it.
    await tap('controls-0', 'overview');
    await expect.poll(async () => { const seat = await seatOf(r.bench, 'helper'); return seat !== undefined && (await r.bench.client.snapshot()).focusedPaneId === seat; }, { timeout: 20_000 }).toBe(true);
    await focus('a1');

    // A close answered by hand.
    let answer = r.view.bridge.requestClose('w3');
    await expect.poll(async () => (await viewState(page)).confirm?.name ?? '').toMatch(/^\d+ w3 \(/);
    await tap('strip', 'decline');
    expect(await answer).toBe('declined');
    answer = r.view.bridge.requestClose('w3');
    await expect.poll(async () => (await viewState(page)).confirm?.name ?? '').toMatch(/^\d+ w3 \(/);
    await tap('strip', 'confirm');
    expect(await answer).toBe('closed');

    // Hold to talk by holding a pinch or trigger on the microphone, and by holding the grip.
    const mic = await regionPoint(page, 'talk', 'talk');
    await aim(page, input, 'talk', mic.x, mic.y);
    speech.queue.push('first prompt by hand');
    await setPressed(page, input, 1);
    await expect.poll(async () => (await viewState(page)).mic.open).toBe(true);
    await feed(page, wav('summarize-the-ledger-change'));
    await setPressed(page, input, 0);
    await expect.poll(async () => (await viewState(page)).last?.outcome).toBe('Sent to a1');
    await expect.poll(() => plainText('a1')).toContain('received: first prompt by hand');
    if (input === 'controller') {
      speech.queue.push('second prompt by grip');
      await squeeze(page, 1);
      await expect.poll(async () => (await viewState(page)).mic.open).toBe(true);
      await feed(page, wav('summarize-the-ledger-change'));
      await squeeze(page, 0);
      await expect.poll(() => plainText('a1')).toContain('received: second prompt by grip');
    }

    // Talk tapped: keep listening; tapped again: off.
    await tap('talk', 'talk');
    await expect.poll(async () => (await viewState(page)).mic).toMatchObject({ mode: 'switch', open: true });
    await tap('talk', 'talk');
    await expect.poll(async () => (await viewState(page)).mic).toMatchObject({ mode: 'hold', open: false });

    // Exit MR leaves mixed reality, back to the flat page.
    await tap('controls-0', 'exit');
    await expect.poll(async () => (await viewState(page)).immersive).toBe(false);
    await expect(page.getByRole('button', { name: 'Enter mixed reality' })).toBeVisible();
  });
}

test('the receiver is shown, moves only by a focus act, and is fixed when speech starts', async ({ page }) => {
  test.setTimeout(90_000);
  await start(page);
  await focus('a1');
  await expect.poll(async () => (await viewState(page)).receiver).toBe(r.bench.pane('a1'));

  // Status changes and new sessions leave the receiver where it was.
  await r.bench.type('w1', '/block');
  await r.bench.type('w2', '/status working');
  await r.bench.addWorkspace({ label: 'delta', panes: [{ name: 'late', kind: 'agent' }] });
  await expect.poll(() => light(page, 'late')).toBe('idle');
  expect((await viewState(page)).receiver).toBe(r.bench.pane('a1'));

  // Hold to talk: focus moves before the release; the utterance still goes to a1.
  speech.queue.push('hold utterance for the first receiver');
  await say(page, 'summarize-the-ledger-change', async () => {
    await focus('w3');
    await expect.poll(async () => (await viewState(page)).receiver).toBe(r.bench.pane('w3'));
  });
  await expect.poll(() => plainText('a1')).toContain('received: hold utterance for the first receiver');
  expect(await plainText('w3')).not.toContain('hold utterance');

  // Listening switch: the receiver is the one in front where speech begins, not where it ends.
  const tap = (surface: string, id: string) => tapOn(page, 'controller', surface, id);
  await tap('talk', 'talk');
  await expect.poll(async () => (await viewState(page)).mic).toMatchObject({ mode: 'switch', open: true });
  await focus('a1');
  await expect.poll(async () => (await viewState(page)).receiver).toBe(r.bench.pane('a1'));
  speech.queue.push('switch utterance for a1');
  const audio = wav('summarize-the-ledger-change');
  const half = Math.floor(audio.length / 2);
  await feed(page, [...new Array<number>(4800).fill(0), ...audio.slice(0, half)]);
  await focus('w3');
  await expect.poll(async () => (await viewState(page)).receiver).toBe(r.bench.pane('w3'));
  await feed(page, [...audio.slice(half), ...new Array<number>(16000).fill(0)]);
  await expect.poll(() => plainText('a1')).toContain('received: switch utterance for a1');
  expect(await plainText('w3')).not.toContain('switch utterance');
});

test('next waiting visits each session that needs the owner, back returns, and there is no Inbox panel', async ({ page }) => {
  test.setTimeout(90_000);
  await start(page, false);
  await focus('a1');
  const act = (command: string) => page.evaluate(c => fetch('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ command: c }) }).then(x => x.json()), command) as Promise<{ ok: boolean; outcome: string }>;

  expect((await act('next')).outcome).toBe('Nothing is waiting for you.');
  for (const name of ['w1', 'w2', 'w3']) await r.bench.type(name, '/block');
  for (const name of ['w1', 'w2', 'w3']) await expect.poll(() => light(page, name)).toBe('blocked');
  const visited: string[] = [];
  for (let i = 0; i < 4; i += 1) {
    await act('next');
    visited.push(await front(page) as string);
  }
  const [w1, w2, w3] = ['w1', 'w2', 'w3'].map(n => r.bench.pane(n));
  expect(visited).toEqual([w1, w2, w3, w1]);
  await act('back');
  await expect.poll(() => front(page)).toBe(r.bench.pane('a1'));
  expect((await act('back')).ok).toBe(false);

  const surfaces = (await viewState(page)).surfaces;
  expect(surfaces.filter(s => !/^(front|strip|talk|controls-\d|tile:.+|label:.+|chip:.+)$/.test(s)), 'no panel beyond the shelf and its chips, such as an Inbox').toEqual([]);
});
