import { expect, test, type Page } from '@playwright/test';
import { OWNER_SHAPE } from '../bench/bench.js';
import { aim, emulateQuest, enterMixedReality, pair, press, regionPoint, rig, viewState, type Rig, shownSessions } from './fixture.js';

// Each state the view can be in, rendered in the emulated headset, with what the owner should
// see checked and a picture kept for review: no sessions, many, lights, a session closing, the
// bridge or Herdr lost, the microphone refused, listening, a close to confirm, larger text, and
// the shelf after the owner turns and recentres.
test.use({ ignoreHTTPSErrors: true, viewport: { width: 1600, height: 1000 } });
let r: Rig;
test.afterEach(async () => { await r?.stop(); });

async function look(page: Page, degrees: number): Promise<void> {
  await page.evaluate(d => {
    const a = d * Math.PI / 360;
    (window as unknown as { __xr: { quaternion: { set(x: number, y: number, z: number, w: number): void } } }).__xr.quaternion.set(0, Math.sin(a), 0, Math.cos(a));
  }, degrees);
  await page.waitForTimeout(250);
}
const shot = (page: Page, name: string) => page.screenshot({ path: test.info().outputPath(`${name}.png`) });

test('no sessions: the view says what to do', async ({ page }) => {
  r = await rig([]);
  await emulateQuest(page);
  await pair(page, r);
  await enterMixedReality(page);
  const s = await viewState(page);
  expect(s.front).toBeNull();
  expect(s.emptyHint).toBe('No sessions open in Herdr. Start one there and it appears here.');
  await shot(page, '01-no-sessions');
});

test('many sessions with every light, glanced at left and right', async ({ page }) => {
  test.setTimeout(90_000);
  r = await rig(OWNER_SHAPE);
  await emulateQuest(page);
  await pair(page, r);
  await r.bench.client.call('pane.focus', { pane_id: r.bench.pane('ledger') });
  await r.bench.type('ledger', 'explain the reconciliation change');
  await r.bench.type('review', '/block');
  await r.bench.type('alerts', '/status working');
  await r.bench.type('guide', '/status working');
  await r.bench.type('guide', '/status idle');
  await r.bench.type('bridge', '/status unknown');
  await enterMixedReality(page);
  await expect.poll(async () => shownSessions(await viewState(page)).map(t => t.light).sort().join()).toContain('blocked');
  await shot(page, '02-many-ahead');
  await look(page, 55);
  await shot(page, '03-many-left');
  await look(page, -55);
  await shot(page, '04-many-right');
  await look(page, 0);

  await r.bench.client.call('pane.close', { pane_id: r.bench.pane('payouts') });
  await expect.poll(async () => (await viewState(page)).notice).toContain('closed in Herdr');
  await look(page, 55);
  await shot(page, '05-session-closed');
  await look(page, 0);

  await page.evaluate(() => window.viewTest.fakeMic(true));
  const mic = await regionPoint(page, 'talk', 'talk');
  await aim(page, 'controller', 'talk', mic.x, mic.y);
  await press(page, 'controller', 400);
  await expect.poll(async () => (await viewState(page)).mic.problem).toContain('Mic refused: allow it in the browser');
  await shot(page, '06-mic-refused');

  void r.view.bridge.requestClose('tests');
  await expect.poll(async () => (await viewState(page)).confirm?.name ?? '').toMatch(/^\d+ tests \(/);
  await shot(page, '07-confirm-close');
  const no = await regionPoint(page, 'strip', 'decline');
  await aim(page, 'controller', 'strip', no.x, no.y);
  await press(page, 'controller');

  for (let i = 0; i < 2; i += 1) {
    // Each step resizes the panels, so the button moves: aim again.
    const bigger = await regionPoint(page, 'controls-0', 'bigger');
    await aim(page, 'controller', 'controls-0', bigger.x, bigger.y);
    await press(page, 'controller');
  }
  await expect.poll(async () => (await viewState(page)).scale).toBe(1.2);
  await shot(page, '08-larger-text');

  await look(page, 40);
  const recenter = await regionPoint(page, 'controls-0', 'recenter');
  await aim(page, 'controller', 'controls-0', recenter.x, recenter.y);
  await press(page, 'controller');
  await page.waitForTimeout(300);
  await shot(page, '09-turned-and-recentred');
  await look(page, 0);

  await r.bench.stopServer();
  await expect.poll(async () => (await viewState(page)).stale).toContain('Herdr is not running');
  await shot(page, '10-herdr-down');
  await r.view.stop();
  await expect.poll(async () => (await viewState(page)).stale).toContain('No link to the view bridge');
  await shot(page, '11-bridge-lost');
  await r.bench.startServer();
});

test('listening with an utterance shown', async ({ page }) => {
  test.setTimeout(60_000);
  const { ScriptedSpeech } = await import('./fixture.js');
  const speech = new ScriptedSpeech();
  r = await rig([{ label: 'alpha', panes: [{ name: 'a1', kind: 'agent' }, { name: 'a2', kind: 'agent' }] }], { speech });
  await emulateQuest(page);
  await pair(page, r);
  await page.evaluate(() => window.viewTest.fakeMic());
  await r.bench.client.call('pane.focus', { pane_id: r.bench.pane('a1') });
  await enterMixedReality(page);
  // A tap on Talk: keep listening.
  const talk = await regionPoint(page, 'talk', 'talk');
  await aim(page, 'controller', 'talk', talk.x, talk.y);
  await press(page, 'controller');
  speech.queue.push('Summarize the ledger change.');
  const { feed, wav } = await import('./fixture.js');
  await feed(page, [...new Array<number>(4800).fill(0), ...wav('summarize-the-ledger-change'), ...new Array<number>(16000).fill(0)]);
  await expect.poll(async () => (await viewState(page)).last?.outcome).toBe('Sent to a1');
  await shot(page, '12-listening-utterance');
});
