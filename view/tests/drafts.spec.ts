import { expect, test, type Page } from '@playwright/test';
import { plain } from '../shared/ansi.js';
import { emulateQuest, enterMixedReality, pair, rig, say, ScriptedSpeech, tap, viewState, type Rig } from './fixture.js';

// The draft as the owner meets it in the headset: spoken words wait in the session in front, the
// view says where and which words send or clear them, and the buttons do the same as the words.
test.use({ ignoreHTTPSErrors: true, viewport: { width: 1600, height: 1000 } });
let r: Rig;
let speech: ScriptedSpeech;
test.afterEach(async () => { await r?.stop(); });

const LAYOUT = [
  { label: 'alpha', panes: [{ name: 'a1', kind: 'agent' as const }, { name: 'a2', kind: 'agent' as const }] },
  { label: 'beta', panes: [{ name: 'b1', kind: 'agent' as const }] },
];
const text = async (name: string) => plain(await r.bench.client.read(r.bench.pane(name), 60));
/** Says `words` as one utterance, holding the talk key; the audio is any recorded phrase, the words are what the speech model "heard". */
async function speak(page: Page, words: string): Promise<void> {
  speech.queue.push(words);
  await say(page, 'summarize-the-ledger-change');
}
const shot = (page: Page, name: string) => page.screenshot({ path: test.info().outputPath(`${name}.png`) });

for (const input of ['controller', 'hand'] as const) {
  test(`a draft waits where it was typed and says so; Go and Scratch that and the send setting work by ${input}`, async ({ page }) => {
    test.setTimeout(150_000);
    speech = new ScriptedSpeech();
    r = await rig(LAYOUT, { speech });
    await emulateQuest(page);
    await pair(page, r);
    await page.evaluate(() => window.viewTest.fakeMic());
    await enterMixedReality(page);
    const a1 = r.bench.pane('a1');
    await r.bench.client.call('pane.focus', { pane_id: a1 });
    await expect.poll(async () => (await viewState(page)).front).toBe(a1);
    const s0 = await viewState(page);
    expect(s0.drafts, 'no draft, no draft bar').toEqual([]);
    expect(s0.surfaces).not.toContain('draft');
    expect(s0.direct, 'direct sending is off on first use').toBe(false);

    await speak(page, 'summarize the ledger change');
    await expect.poll(async () => (await viewState(page)).drafts).toEqual([a1]);
    const s1 = await viewState(page);
    expect(s1.last).toMatchObject({ as: 'prompt', ok: true });
    expect(s1.last?.outcome).toContain('Draft in a1');
    expect(s1.surfaces, 'the bar that says where the draft waits and which words send it').toContain('draft');
    expect(await text('a1')).toContain('summarize the ledger change');
    expect(await text('a1')).not.toContain('received:');
    await shot(page, `draft-waits-${input}`);

    // Go, by hand: sends the draft in front.
    await tap(page, input, 'controls-2', 'send');
    await expect.poll(async () => text('a1')).toContain('received: summarize the ledger change');
    expect((await viewState(page)).drafts).toEqual([]);
    expect((await viewState(page)).surfaces).not.toContain('draft');

    // Scratch that, by hand: clears a new draft; the next words start afresh.
    await speak(page, 'first words');
    await expect.poll(async () => (await viewState(page)).drafts).toEqual([a1]);
    await tap(page, input, 'controls-2', 'scratch');
    await expect.poll(async () => (await viewState(page)).drafts).toEqual([]);
    await speak(page, 'fresh words');
    await expect.poll(async () => (await viewState(page)).drafts).toEqual([a1]);
    await tap(page, input, 'controls-2', 'send');
    await expect.poll(async () => text('a1')).toContain('received: fresh words');
    expect(await text('a1')).not.toContain('received: first');

    // A draft in another session than the one in front is named, and not sent from here.
    await speak(page, 'a note for a1');
    await expect.poll(async () => (await viewState(page)).drafts).toEqual([a1]);
    await r.bench.client.call('pane.focus', { pane_id: r.bench.pane('a2') });
    await expect.poll(async () => (await viewState(page)).front).toBe(r.bench.pane('a2'));
    expect((await viewState(page)).surfaces).toContain('draft');
    await tap(page, input, 'controls-2', 'send');
    await expect.poll(async () => (await viewState(page)).notice).toContain('No draft waits');
    expect((await viewState(page)).drafts, 'a1\'s draft is still there').toEqual([a1]);
    await shot(page, `draft-elsewhere-${input}`);

    // The send setting: on by its button, shown on the strip; a prompt is then sent as heard; off again by its button.
    await tap(page, input, 'controls-2', 'direct-on');
    await expect.poll(async () => (await viewState(page)).direct).toBe(true);
    await speak(page, 'sent at once to a2');
    await expect.poll(async () => text('a2')).toContain('received: sent at once to a2');
    await shot(page, `direct-on-${input}`);
    await tap(page, input, 'controls-2', 'direct-off');
    await expect.poll(async () => (await viewState(page)).direct).toBe(false);
  });
}
