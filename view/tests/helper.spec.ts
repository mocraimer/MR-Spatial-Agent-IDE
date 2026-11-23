import { expect, test, type Page } from '@playwright/test';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { dataDirectory } from '../bridge/config.js';
import { claudeHelper, claudeProjectAgent, HerdrLevelAgents } from '../bridge/agents.js';
import { LocalSpeech, modelDirectory } from '../bridge/speech.js';
import { slug } from '../bench/phrases.js';
import { plain } from '../shared/ansi.js';
import { pair, rig, say, viewState, type Rig } from './fixture.js';

// The real helper: Claude Code with Haiku, started by the bridge in the bench's own Herdr, given
// orders as speech. Each run spends the owner's model quota, so it runs only when asked:
// VIEW_HELPER_TESTS=1 npx playwright test view/tests/helper.spec.ts
test.skip(process.env.VIEW_HELPER_TESTS !== '1', 'spends model quota; set VIEW_HELPER_TESTS=1');
test.use({ ignoreHTTPSErrors: true });

let r: Rig;
test.afterAll(async () => { await r?.stop(); });

const timings: string[] = [];
async function order(page: Page, phrase: string, done: () => Promise<boolean>, what: string): Promise<void> {
  await say(page, slug(phrase));
  const u = (await viewState(page)).last;
  expect(u, phrase).toMatchObject({ as: 'helper', ok: true });
  const t0 = Date.now();
  await expect.poll(done, { timeout: 120_000, intervals: [250], message: what }).toBe(true);
  timings.push(`${what}: ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  await helperIdle();
}
async function helperIdle(): Promise<void> {
  await expect.poll(async () => {
    const helper = (await r.bench.client.snapshot()).panes.find(p => p.label === 'helper' || p.title === 'helper');
    return helper ? ['idle', 'done'].includes(helper.status) : false;
  }, { timeout: 120_000 }).toBe(true);
}
const panes = async () => (await r.bench.client.snapshot()).panes;
const inProject = async (label: string) => {
  const s = await r.bench.client.snapshot();
  const id = s.workspaces.find(w => w.label === label)?.id;
  return s.panes.filter(p => p.workspaceId === id);
};

test('a spoken order to the helper starts, renames and closes sessions, closing only on the owner\'s yes', async ({ page }) => {
  test.setTimeout(900_000);
  const speech = new LocalSpeech(modelDirectory(dataDirectory()));
  await speech.load();
  r = await rig([
    { label: 'alpha', panes: [{ name: 'a1', kind: 'agent' }] },
    { label: 'beta', panes: [{ name: 'b1', kind: 'agent' }] },
  ], (bench, data) => ({
    speech,
    closeAnswerMs: 25_000,
    // A bench pane has a private HOME; the agents need the owner's, where their login lives.
    agents: new HerdrLevelAgents(bench.client, {
      // One fixed folder across runs: Claude Code records its trust answer per folder, in the owner's settings.
      helper: { ...claudeHelper('/tmp/spatial-view-test-agents/helper'), env: { HOME: homedir() } },
      project: { ...claudeProjectAgent('/tmp/spatial-view-test-agents/project-agent'), env: { HOME: homedir() } },
    }, join(data, 'helper.sock')),
  }));
  await pair(page, r);
  await page.evaluate(() => window.viewTest.fakeMic());
  await r.bench.client.call('pane.focus', { pane_id: r.bench.pane('a1') });
  // This test is about what the helper does with an order, not about "go": orders are sent as heard.
  await say(page, slug('send at once'));
  await expect.poll(async () => (await viewState(page)).direct).toBe(true);

  // The helper is started the first time it is needed, as a session on the shelf.
  await say(page, slug('overview'));
  await expect.poll(async () => (await viewState(page)).place, { timeout: 60_000 }).toEqual({ overview: true });
  await helperIdle();
  await r.bench.client.call('pane.focus', { pane_id: r.bench.pane('a1') });

  await order(page, 'helper, start a shell in project alpha', async () => (await inProject('alpha')).some(p => p.agent === null), 'start a shell');
  const shell = (await inProject('alpha')).find(p => p.agent === null)?.id as string;
  await expect.poll(async () => (await viewState(page)).columns.filter(c => c.project === 'alpha').some(c => c.tiles.some(t => t.id === shell))).toBe(true);

  await order(page, 'helper, start a claude agent in project beta', async () => (await inProject('beta')).filter(p => p.agent === 'claude').length >= 2, 'start an agent');

  await order(page, 'helper, rename the shell in project alpha to logs', async () => (await panes()).some(p => p.id === shell && p.label === 'logs'), 'rename');
  await expect.poll(async () => (await viewState(page)).columns.flatMap(c => c.tiles).find(t => t.id === shell)?.name).toBe('logs');

  // A close with no answer: nothing closes.
  await say(page, slug('helper, close the logs session'));
  await expect.poll(async () => (await viewState(page)).confirm?.name ?? '', { timeout: 120_000 }).toMatch(/^\d+ logs \(/);
  await expect.poll(async () => (await viewState(page)).confirm, { timeout: 60_000 }).toBeNull();
  await helperIdle();
  expect((await panes()).some(p => p.id === shell), 'no answer leaves it open').toBe(true);

  // "Do not ask" in the order: it still asks; a no keeps it.
  await say(page, slug('helper, close the logs session and do not ask me'));
  await expect.poll(async () => (await viewState(page)).confirm?.name ?? '', { timeout: 120_000 }).toMatch(/^\d+ logs \(/);
  await say(page, slug('no'));
  await helperIdle();
  expect((await panes()).some(p => p.id === shell), 'a no leaves it open').toBe(true);

  // Confirmed: it closes.
  const t0 = Date.now();
  await say(page, slug('helper, close the logs session'));
  await expect.poll(async () => (await viewState(page)).confirm?.name ?? '', { timeout: 120_000 }).toMatch(/^\d+ logs \(/);
  timings.push(`close named for confirmation: ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  await say(page, slug('yes'));
  await expect.poll(async () => (await panes()).some(p => p.id === shell), { timeout: 30_000 }).toBe(false);
  await expect.poll(async () => (await viewState(page)).columns.flatMap(c => c.tiles).some(t => t.id === shell && !t.closed)).toBe(false);
  await helperIdle();

  // Another quick task in plain words: its answer is readable in the helper's session.
  // Beta holds b1 and the agent the helper started: the answer is two, read after the order.
  const helperPane = (await panes()).find(p => p.label === 'helper')?.id as string;
  await order(page, 'helper, how many sessions are in project beta', async () => /\b(2|two)\b/i.test(plain(await r.bench.client.read(helperPane, 30)).split(/how many sessions are in project beta/i).at(-1) ?? ''), 'quick task');
  console.log(`helper timings (end of order -> result in Herdr):\n  ${timings.join('\n  ')}`);
});
