import { expect, test, type Page } from '@playwright/test';
import { emulateQuest, enterMixedReality, pair, rig, sayStandby, ScriptedSpeech, tap, viewState, type Rig } from './fixture.js';

// Standby as the owner meets it in the headset: the microphone opens when they enter mixed
// reality and closes when they leave; while listening is off it stays open for commands, each
// asked with "Do X? Say yes", and what is not a command is shown as ignored.
test.use({ ignoreHTTPSErrors: true, viewport: { width: 1600, height: 1000 } });
let r: Rig;
let speech: ScriptedSpeech;
test.afterEach(async () => { await r?.stop(); });

const LAYOUT = [
  { label: 'alpha', panes: [{ name: 'a1', kind: 'agent' as const }, { name: 'a2', kind: 'agent' as const }] },
  { label: 'beta', panes: [{ name: 'b1', kind: 'agent' as const }] },
];
const shot = (page: Page, name: string) => page.screenshot({ path: test.info().outputPath(`${name}.png`) });
/** Hears `words` while listening is off; the audio is any recorded phrase, the words are what the speech model "heard". */
async function murmur(page: Page, words: string): Promise<void> {
  speech.queue.push(words);
  await sayStandby(page, 'summarize-the-ledger-change');
}

test('the microphone is closed on the flat page, open in mixed reality on standby, and closed again after leaving', async ({ page }) => {
  test.setTimeout(90_000);
  speech = new ScriptedSpeech();
  r = await rig(LAYOUT, { speech });
  await emulateQuest(page);
  await pair(page, r);
  await page.evaluate(() => window.viewTest.fakeMic());
  expect((await viewState(page)).mic, 'closed on the flat page').toMatchObject({ open: false, standby: false });

  await enterMixedReality(page);
  await expect.poll(async () => (await viewState(page)).mic).toMatchObject({ open: false, standby: true });
  await shot(page, 'standby-in-mixed-reality');

  // Leaving, by the button: closed again, and nothing heard on the way out reaches a session.
  await tap(page, 'controller', 'controls-0', 'exit');
  await expect.poll(async () => (await viewState(page)).immersive).toBe(false);
  expect((await viewState(page)).mic).toMatchObject({ open: false, standby: false });

  // Entering again: standby again. Leaving by voice (asked, then a yes): closed.
  await enterMixedReality(page);
  await expect.poll(async () => (await viewState(page)).mic.standby).toBe(true);
  await murmur(page, 'leave mixed reality');
  await expect.poll(async () => (await viewState(page)).ask).toEqual({ label: 'Leave mixed reality' });
  expect((await viewState(page)).immersive, 'asked, not done').toBe(true);
  await murmur(page, 'yes');
  await expect.poll(async () => (await viewState(page)).immersive).toBe(false);
  expect((await viewState(page)).mic).toMatchObject({ open: false, standby: false });
});

for (const input of ['controller', 'hand'] as const) {
  test(`a command heard on standby is asked and answered by voice, by ${input} and by key; a prompt is shown as ignored`, async ({ page }) => {
    test.setTimeout(120_000);
    speech = new ScriptedSpeech();
    r = await rig(LAYOUT, { speech });
    await emulateQuest(page);
    await pair(page, r);
    await page.evaluate(() => window.viewTest.fakeMic());
    const a1 = r.bench.pane('a1');
    await r.bench.client.call('pane.focus', { pane_id: a1 });
    await enterMixedReality(page);
    await expect.poll(async () => (await viewState(page)).mic.standby).toBe(true);

    // A prompt: ignored, and says so; no draft anywhere.
    await murmur(page, 'summarize the ledger change');
    let s = await viewState(page);
    expect(s.last).toMatchObject({ as: 'ignored', ok: false });
    expect(s.drafts).toEqual([]);
    expect(s.ask).toBeNull();
    await shot(page, `standby-ignored-${input}`);

    // A view-only command: at once.
    await murmur(page, 'bigger text');
    await expect.poll(async () => (await viewState(page)).scale).toBe(1.1);
    await murmur(page, 'smaller text');

    // Another command: asked; the strip names it and says how to answer; nothing is done yet.
    await murmur(page, 'next waiting');
    await expect.poll(async () => (await viewState(page)).ask).toEqual({ label: 'Bring the next waiting session forward' });
    expect((await viewState(page)).confirm).toBeNull();
    await shot(page, `standby-asked-${input}`);

    // "no" by hand drops it.
    await tap(page, input, 'strip', 'decline');
    await expect.poll(async () => (await viewState(page)).ask).toBeNull();

    // "yes" by hand does it: put a waiting session up and go to it.
    await r.bench.type('b1', '/block');
    await expect.poll(async () => (await viewState(page)).chips.find(c => c.project === 'beta')?.sessions.some(x => x.light === 'blocked')).toBe(true);
    await murmur(page, 'next waiting');
    await expect.poll(async () => (await viewState(page)).ask).not.toBeNull();
    await tap(page, input, 'strip', 'confirm');
    await expect.poll(async () => (await viewState(page)).front).toBe(r.bench.pane('b1'));
    expect((await viewState(page)).ask).toBeNull();

    // "yes" by key, and "no" by Escape.
    await murmur(page, 'back');
    await expect.poll(async () => (await viewState(page)).ask).toEqual({ label: 'Go back to the session you came from' });
    await page.keyboard.press('Escape');
    await expect.poll(async () => (await viewState(page)).ask).toBeNull();
    expect((await viewState(page)).front).toBe(r.bench.pane('b1'));
    await murmur(page, 'back');
    await expect.poll(async () => (await viewState(page)).ask).not.toBeNull();
    await page.keyboard.press('y');
    await expect.poll(async () => (await viewState(page)).front).toBe(a1);
    s = await viewState(page);
    expect(s.last?.heard).toBe('back');
  });
}

test('keep listening, asked on standby and answered yes, turns listening on; stop listening returns to standby', async ({ page }) => {
  test.setTimeout(90_000);
  speech = new ScriptedSpeech();
  r = await rig(LAYOUT, { speech });
  await emulateQuest(page);
  await pair(page, r);
  await page.evaluate(() => window.viewTest.fakeMic());
  await enterMixedReality(page);
  await expect.poll(async () => (await viewState(page)).mic.standby).toBe(true);
  await murmur(page, 'keep listening');
  await expect.poll(async () => (await viewState(page)).ask).toEqual({ label: 'Keep listening' });
  expect((await viewState(page)).mic.open, 'asked, not done').toBe(false);
  await murmur(page, 'yes');
  await expect.poll(async () => (await viewState(page)).mic).toMatchObject({ mode: 'switch', open: true, standby: false });
  await shot(page, 'listening-after-yes');
  await tap(page, 'controller', 'talk', 'talk');
  await expect.poll(async () => (await viewState(page)).mic).toMatchObject({ open: false, standby: true });
  await murmur(page, 'start listening');
  await expect.poll(async () => (await viewState(page)).ask).toEqual({ label: 'Keep listening' });
  await murmur(page, 'yes');
  await expect.poll(async () => (await viewState(page)).mic).toMatchObject({ open: true, standby: false });
});
