import { expect, test, type Page } from '@playwright/test';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { claudeHelper, claudeProjectAgent, HerdrLevelAgents } from '../bridge/agents.js';
import { plain } from '../shared/ansi.js';
import { pair, rig, ScriptedSpeech, seatOf, viewState, type Rig } from './fixture.js';

// A real project agent and the real helper: Claude Code in the bench's own Herdr, given questions
// and orders as heard text. Each run spends the owner's model quota, so it runs only when asked:
// VIEW_HELPER_TESTS=1 npx playwright test view/tests/project-agent.spec.ts
test.skip(process.env.VIEW_HELPER_TESTS !== '1', 'spends model quota; set VIEW_HELPER_TESTS=1');
test.use({ ignoreHTTPSErrors: true });

let r: Rig;
let speech: ScriptedSpeech;
test.afterAll(async () => { await r?.stop(); });

const timings: string[] = [];
const snap = () => r.bench.client.snapshot();
const text = async (id: string, lines = 120) => plain(await r.bench.client.read(id, lines));
/** Speaks `phrase` as heard text and returns what the strip shows for it. */
async function utter(page: Page, phrase: string) {
  speech.queue.push(phrase);
  const receiver = (await viewState(page)).receiver;
  return await page.evaluate(async ([id, receiver]) => {
    const r = await fetch(`/api/utterance?id=${id}${receiver ? `&receiver=${receiver}` : ''}`, { method: 'POST', body: new Float32Array(1600).buffer });
    return await r.json() as { ok: boolean; outcome: string; as: string };
  }, [`t${Date.now()}`, receiver] as const);
}
/** Waits for an agent's seat to be idle, answering a question it asks as it starts (such as trusting its folder). */
async function settle(id: string): Promise<void> {
  await expect.poll(async () => {
    const pane = (await snap()).panes.find(p => p.id === id);
    if (pane?.status === 'blocked' && /trust/i.test(await text(id, 40))) await r.bench.client.call('pane.send_keys', { pane_id: id, keys: ['enter'] });
    return pane?.agent !== null && ['idle', 'done'].includes(String(pane?.status));
  }, { timeout: 180_000, intervals: [1000] }).toBe(true);
}
async function answer(page: Page, seat: string, phrase: string, what: string): Promise<string> {
  const before = (await text(seat, 400)).length;
  const u = await utter(page, phrase);
  expect(u, phrase).toMatchObject({ ok: true });
  const t0 = Date.now();
  await expect.poll(async () => (await snap()).panes.find(p => p.id === seat)?.status, { timeout: 30_000 }).toBe('working').catch(() => undefined);
  await settle(seat);
  timings.push(`${what}: ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  return (await text(seat, 400)).slice(Math.max(0, before - 200));
}

test('a real project agent knows its project, acts only on order and within its project; the helper answers across projects', async ({ page }) => {
  test.setTimeout(1_200_000);
  speech = new ScriptedSpeech();
  r = await rig([
    { label: 'alpha', panes: [{ name: 'builder', kind: 'agent' }, { name: 'tester', kind: 'agent' }] },
    { label: 'beta', panes: [{ name: 'writer', kind: 'agent' }] },
  ], (bench, data) => ({
    speech,
    closeAnswerMs: 20_000,
    // A bench pane has a private HOME; the agents need the owner's, where their login lives.
    agents: new HerdrLevelAgents(bench.client, {
      helper: { ...claudeHelper(join(data, 'agents', 'helper')), env: { HOME: homedir() } },
      project: { ...claudeProjectAgent(join(data, 'agents', 'project-agent')), env: { HOME: homedir() } },
    }, join(data, 'helper.sock')),
  }));
  await pair(page, r);
  // The tester waits on a marked question; the builder has worked on something marked.
  await r.bench.type('builder', 'refactor the ZEBRA-PARSER module');
  await r.bench.type('tester', '/block');

  // Going in starts the agent and sends it nothing.
  const go = await page.evaluate(async id => (await (await fetch('/api/action', { method: 'POST', body: JSON.stringify({ go: id }) })).json()) as { ok: boolean }, r.bench.workspaces.get('alpha') as string);
  expect(go.ok).toBe(true);
  const seat = await seatOf(r.bench, 'alpha') as string;
  await settle(seat);
  expect((await viewState(page)).front).toBe(seat);
  const untouched = (await snap()).panes.filter(p => p.label !== 'project agent').map(p => p.id);
  const inputs = async () => Promise.all(untouched.map(async id => (await text(id)).split('received:').length));
  const quiet = await inputs();

  // A question: answered from the project's sessions as they are, and nothing changes.
  const said = await answer(page, seat, 'what are the sessions in this project doing, and what waits on me?', 'question about the project');
  expect(said).toMatch(/builder/i);
  expect(said).toMatch(/tester/i);
  expect(said, 'the waiting session and what it waits on').toMatch(/wait|block|question/i);
  expect(said, 'no session of another project as its own').not.toMatch(/writer/i);
  expect(await inputs(), 'a question sends nothing to any session').toEqual(quiet);
  const count = (await snap()).panes.length;
  expect(count).toBe(untouched.length + 1);

  // An order to tell a session something: delivered there.
  await answer(page, seat, 'tell the builder to run the KANGAROO checks', 'prompt a session');
  await expect.poll(async () => await text(r.bench.pane('builder')), { timeout: 30_000 }).toMatch(/KANGAROO/i);

  // An order to start a shell: started in this project.
  await answer(page, seat, 'start a shell session named scratch', 'start a session');
  await expect.poll(async () => (await snap()).panes.find(p => p.label === 'scratch')?.workspaceId, { timeout: 30_000 }).toBe(r.bench.workspaces.get('alpha'));

  // Beyond its powers: a session in another project, and a file change, wait for the owner's approval.
  for (const [phrase, effect] of [
    ['give the writer session in project beta the prompt OCELOT', async () => /OCELOT/.test(await text(r.bench.pane('writer')))],
    [`create a file named PANGOLIN.txt in ${r.data}`, async () => { try { return (await import('node:fs')).existsSync(join(r.data, 'PANGOLIN.txt')); } catch { return false; } }],
  ] as const) {
    await utter(page, phrase);
    await expect.poll(async () => (await snap()).panes.find(p => p.id === seat)?.status, { timeout: 180_000, intervals: [1000] }).toMatch(/blocked|idle|done/);
    const status = (await snap()).panes.find(p => p.id === seat)?.status;
    expect(await effect(), `${phrase}: nothing happened without approval (agent ${status})`).toBe(false);
    if (status === 'blocked') {
      // Approve: the change happens.
      await r.bench.client.call('pane.send_keys', { pane_id: seat, keys: ['enter'] });
      await settle(seat);
      timings.push(`${phrase}: approved -> ${String(await effect())}`);
    } else timings.push(`${phrase}: declined by the agent without asking`);
  }

  // The helper at the overview answers across projects.
  const overview = await page.evaluate(async () => (await (await fetch('/api/action', { method: 'POST', body: JSON.stringify({ command: 'overview' }) })).json()) as { ok: boolean });
  expect(overview.ok).toBe(true);
  const helper = await seatOf(r.bench, 'helper') as string;
  await settle(helper);
  const across = await answer(page, helper, 'what waits on me across all projects?', 'helper question across projects');
  expect(across).toMatch(/tester/i);
  expect(across).toMatch(/alpha/i);
  console.log(`level agent timings (end of question or order -> agent idle):\n  ${timings.join('\n  ')}`);
});
