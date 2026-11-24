import { expect, request, test, type Page } from '@playwright/test';
import { emulateQuest, enterMixedReality, FakeVoice, feed, pair, rig, say, sayStandby, ScriptedSpeech, tap, viewState, wav, type Rig } from './fixture.js';

// The voice as the owner meets it in the headset: a command is answered aloud, the microphone hears
// nothing while the voice plays, the voice can be stopped and turned off, and the controls for the
// model, the effort and the voice sit with the others.
test.use({ ignoreHTTPSErrors: true, viewport: { width: 1600, height: 1000 } });
let r: Rig;
let speech: ScriptedSpeech;
let voice: FakeVoice;
test.afterEach(async () => { await r?.stop(); });

const LAYOUT = [
  { label: 'alpha', panes: [{ name: 'a1', kind: 'agent' as const }, { name: 'a2', kind: 'agent' as const }] },
  { label: 'beta', panes: [{ name: 'b1', kind: 'agent' as const }] },
];
const shot = (page: Page, name: string) => page.screenshot({ path: test.info().outputPath(`${name}.png`) });
/** Says `words` as one utterance holding the talk key; the audio is any recorded phrase. */
async function speak(page: Page, words: string): Promise<void> { speech.queue.push(words); await say(page, 'summarize-the-ledger-change'); }
async function start(page: Page, seconds = 1.2): Promise<void> {
  speech = new ScriptedSpeech();
  voice = new FakeVoice();
  voice.seconds = seconds;
  r = await rig(LAYOUT, { speech, voice });
  await emulateQuest(page);
  await pair(page, r);
  await page.evaluate(() => window.viewTest.fakeMic());
  await enterMixedReality(page);
  const a1 = r.bench.pane('a1');
  await r.bench.client.call('pane.focus', { pane_id: a1 });
  await expect.poll(async () => (await viewState(page)).front).toBe(a1);
}
const silence = (seconds: number) => new Array<number>(Math.round(16000 * seconds)).fill(0);

test('a command is answered aloud: the page fetches the phrase from a route that needs the pairing, and plays it to its end', async ({ page }) => {
  test.setTimeout(90_000);
  await start(page);
  const fetched: { status: number; type: string }[] = [];
  page.on('response', async res => { if (res.url().includes('/api/say/')) fetched.push({ status: res.status(), type: res.headers()['content-type'] ?? '' }); });
  expect((await viewState(page)).voice).toMatchObject({ feedback: true, reading: false, playing: false, played: 0 });
  await speak(page, 'press enter');
  await expect.poll(async () => (await viewState(page)).voice.playing, { timeout: 10_000 }).toBe(true);
  await expect.poll(async () => (await viewState(page)).voice.played, { timeout: 10_000 }).toBe(1);
  expect(voice.spoken).toEqual(['Pressed enter in a1']);
  expect(fetched).toEqual([{ status: 200, type: 'audio/wav' }]);
  expect((await viewState(page)).voice.problem).toBeNull();
  // The route is closed to a client that is not paired.
  const stranger = await request.newContext({ ignoreHTTPSErrors: true });
  expect((await stranger.get(`${r.view.url}/api/say/00000000-0000-0000-0000-000000000000`)).status()).toBe(401);
  await stranger.dispose();
});

test('the microphone hears nothing while the voice plays, and hears again after it', async ({ page }) => {
  test.setTimeout(90_000);
  await start(page, 2.5);
  await expect.poll(async () => (await viewState(page)).mic.standby).toBe(true);
  // A command heard in standby is asked: the question is spoken (2.5 s of audio) and the microphone is shut meanwhile.
  speech.queue.push('overview');
  await sayStandby(page, 'overview');
  await expect.poll(async () => (await viewState(page)).voice.playing, { timeout: 10_000 }).toBe(true);
  speech.queue.push('press enter');
  await feed(page, [...silence(0.3), ...wav('press-enter'), ...silence(1.0)]);
  await page.waitForTimeout(500);
  expect(speech.queue, 'what was said while the voice played was never sent to be heard').toEqual(['press enter']);
  expect((await viewState(page)).hearing).toBe(0);
  await expect.poll(async () => (await viewState(page)).voice.playing, { timeout: 10_000 }).toBe(false);
  speech.queue.length = 0;
  speech.queue.push('press enter');
  await sayStandby(page, 'press-enter');
  expect((await viewState(page)).last?.heard, 'it hears again once the voice is done').toBe('press enter');
});

test('Quiet stops the phrase at once and drops those behind it; Voice off silences answers; Voice on brings them back', async ({ page }) => {
  test.setTimeout(120_000);
  await start(page, 6);
  await speak(page, 'press enter');
  await expect.poll(async () => (await viewState(page)).voice.playing, { timeout: 10_000 }).toBe(true);
  const stopped = Date.now();
  await tap(page, 'controller', 'controls-4', 'voice-stop');
  await expect.poll(async () => (await viewState(page)).voice.playing, { timeout: 3000 }).toBe(false);
  expect(Date.now() - stopped, 'stopped at once, not at the end of 6 s of audio').toBeLessThan(3000);

  await tap(page, 'controller', 'controls-4', 'voice-off');
  await expect.poll(async () => (await viewState(page)).voice.feedback).toBe(false);
  const before = voice.spoken.length;
  await speak(page, 'press enter');
  await page.waitForTimeout(600);
  expect(voice.spoken.length, 'nothing is spoken with the voice off').toBe(before);
  await shot(page, 'voice-off');

  await tap(page, 'controller', 'controls-4', 'voice-on');
  await expect.poll(async () => (await viewState(page)).voice.feedback).toBe(true);
  await tap(page, 'controller', 'controls-4', 'read-on');
  await expect.poll(async () => (await viewState(page)).voice.reading).toBe(true);
  await shot(page, 'reading-on');
});

test('the model and effort buttons type the slash command into the session in front, as the spoken words do', async ({ page }) => {
  test.setTimeout(90_000);
  await start(page);
  await tap(page, 'controller', 'controls-3', 'model-sonnet');
  await expect.poll(async () => (await r.bench.client.read(r.bench.pane('a1'), 40)).includes('a1 got: /model claude-sonnet-5-5')).toBe(true);
  await tap(page, 'hand', 'controls-3', 'effort-xhigh');
  await expect.poll(async () => (await r.bench.client.read(r.bench.pane('a1'), 40)).includes('a1 got: /effort xhigh')).toBe(true);
  await shot(page, 'model-and-effort-controls');
});

test('each voice action is also done by speaking it: voice off and on, read replies and stop reading, read that, stop talking, the model and the effort', async ({ page }) => {
  test.setTimeout(150_000);
  await start(page, 0.3);
  const state = async () => (await viewState(page)).voice;
  await speak(page, 'voice off');
  await expect.poll(async () => (await state()).feedback).toBe(false);
  await speak(page, 'read replies');
  await expect.poll(async () => (await state()).reading).toBe(true);
  await speak(page, 'stop reading replies');
  await expect.poll(async () => (await state()).reading).toBe(false);
  await speak(page, 'voice on');
  await expect.poll(async () => (await state()).feedback).toBe(true);
  await expect.poll(async () => (await viewState(page)).voice.played, { timeout: 10_000 }).toBeGreaterThan(0);
  // Read that and stop talking are heard and acted on (no transcript here, so the answer says why).
  await speak(page, 'read that');
  await expect.poll(async () => (await viewState(page)).last?.outcome).toMatch(/transcript/);
  await speak(page, 'stop talking');
  await expect.poll(async () => (await viewState(page)).last?.outcome).toBe('The voice is stopped.');
  await speak(page, 'set model to opus');
  await expect.poll(async () => (await r.bench.client.read(r.bench.pane('a1'), 40)).includes('a1 got: /model claude-opus-5-5')).toBe(true);
  await speak(page, 'effort max');
  await expect.poll(async () => (await r.bench.client.read(r.bench.pane('a1'), 40)).includes('a1 got: /effort max')).toBe(true);
});

test('Stop reading and Read that are also buttons', async ({ page }) => {
  test.setTimeout(90_000);
  await start(page, 0.3);
  await tap(page, 'controller', 'controls-4', 'read-on');
  await expect.poll(async () => (await viewState(page)).voice.reading).toBe(true);
  await tap(page, 'controller', 'controls-4', 'read-off');
  await expect.poll(async () => (await viewState(page)).voice.reading).toBe(false);
  await tap(page, 'hand', 'controls-4', 'read-last');
  await expect.poll(async () => (await viewState(page)).notice).toMatch(/transcript/);
});

test('a voice that failed shows "Voice problem" on the strip until it works again', async ({ page }) => {
  test.setTimeout(90_000);
  await start(page, 0.3);
  voice.mode = 'fail';
  await speak(page, 'press enter');
  await expect.poll(async () => (await viewState(page)).voice.trouble).toBe(true);
  await shot(page, 'voice-problem');
  voice.mode = 'ok';
  await speak(page, 'press enter');
  await expect.poll(async () => (await viewState(page)).voice.trouble, { timeout: 10_000 }).toBe(false);
});
