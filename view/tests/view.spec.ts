import { expect, test } from '@playwright/test';
import { OWNER_SHAPE } from '../bench/bench.js';
import { aim, emulateQuest, enterMixedReality, pair, press, rig, seatOf, shownSessions, viewState, type Rig } from './fixture.js';

test.use({ ignoreHTTPSErrors: true, viewport: { width: 1600, height: 1000 } });

let r: Rig;
test.afterEach(async () => { await r?.stop(); });

test('every pane Herdr lists is shown under its project: a tile in the project in front, a light on every other project\'s chip', async ({ page }) => {
  test.setTimeout(60_000);
  r = await rig(OWNER_SHAPE);
  await pair(page, r);
  const herdr = await r.bench.client.snapshot();
  const labels = new Map(herdr.workspaces.map(w => [w.id, w.label]));
  await expect.poll(async () => shownSessions(await viewState(page)).length).toBe(herdr.panes.length);
  const s = await viewState(page);
  const shown = shownSessions(s).map(x => [x.id, x.project] as const).sort();
  expect(shown).toEqual(herdr.panes.map(p => [p.id, labels.get(p.workspaceId) as string] as const).sort());
  const front = herdr.panes.find(p => p.id === herdr.focusedPaneId);
  expect(s.place).toEqual({ overview: false, projectId: front?.workspaceId, project: labels.get(front?.workspaceId ?? '') });
  expect(s.columns.flatMap(c => c.tiles.map(t => t.id)).sort(), 'only the project in front has tiles').toEqual(herdr.panes.filter(p => p.workspaceId === front?.workspaceId).map(p => p.id).sort());
  await page.screenshot({ path: test.info().outputPath('shelf-owner-shape.png') });
});

test('in mixed reality: a project\'s sessions around the front, the others as chips; a controller or a hand brings a tile forward or goes into a project', async ({ page }) => {
  test.setTimeout(90_000);
  r = await rig(OWNER_SHAPE);
  await emulateQuest(page);
  await pair(page, r);
  await enterMixedReality(page);
  await r.bench.client.call('pane.focus', { pane_id: r.bench.pane('ledger') });
  await expect.poll(async () => (await viewState(page)).columns.flatMap(c => c.tiles).length).toBe(3);
  expect((await viewState(page)).chips.map(c => c.project)).toEqual(['Overview', ...OWNER_SHAPE.slice(1).map(w => w.label)]);
  await page.screenshot({ path: test.info().outputPath('mr-inside-a-project.png') });

  // A hand on the infra chip goes into infra: its agent comes to the front.
  const infra = r.bench.workspaces.get('infra') as string;
  await aim(page, 'hand', `chip:${infra}`);
  await press(page, 'hand');
  await expect.poll(async () => (await viewState(page)).place).toEqual({ overview: false, projectId: infra, project: 'infra' });
  await expect.poll(async () => (await viewState(page)).front, { timeout: 20_000 }).toBe(await seatOf(r.bench, 'infra'));

  for (const [input, name] of [['controller', 'alerts'], ['hand', 'terraform']] as const) {
    const id = r.bench.pane(name);
    await aim(page, input, `tile:${id}`);
    await press(page, input);
    await expect.poll(async () => (await viewState(page)).front, { message: `${input} brings ${name} forward` }).toBe(id);
    const focused = await r.bench.client.snapshot();
    expect(focused.focusedPaneId, 'Herdr itself focuses it, so the desk keyboard types there').toBe(id);
    const s = await viewState(page);
    expect(s.columns.flatMap(c => c.tiles).filter(t => t.inFront).map(t => t.id)).toEqual([id]);
  }
  await page.screenshot({ path: test.info().outputPath('mr-after-focus.png') });
});

test('lights, sessions starting, closing, renamed and moved, and the front text all follow Herdr without a reload', async ({ page }) => {
  test.setTimeout(90_000);
  r = await rig([
    { label: 'alpha-project', panes: [{ name: 'a1', kind: 'agent' }, { name: 'sh1', kind: 'shell' }] },
    { label: 'beta', panes: [{ name: 'b1', kind: 'agent' }] },
  ]);
  await pair(page, r);
  // A session as shown: a tile in the project in front (with its name), or a light on its project's chip.
  const tile = async (id: string) => {
    const s = await viewState(page);
    const t = s.columns.flatMap(c => c.tiles.map(x => ({ ...x, project: c.project }))).find(x => x.id === id);
    if (t) return t;
    const chip = s.chips.find(c => c.sessions.some(x => x.id === id));
    const on = chip?.sessions.find(x => x.id === id);
    return chip && on ? { id, light: on.light, project: chip.project, name: undefined, closed: false } : undefined;
  };
  await r.bench.client.call('pane.focus', { pane_id: r.bench.pane('a1') });
  await expect.poll(async () => (await tile(r.bench.pane('sh1')))?.light).toBe('shell');

  // Every status in Herdr's schema has its own light. Herdr turns idle-after-work into done
  // for a session nobody is looking at.
  const b1 = r.bench.pane('b1');
  // Expected lights come from Herdr's own report: after work, Herdr usually says done (nobody
  // looked), but it decides that, so the page must match whatever Herdr says at that moment.
  const herdrStatus = async () => (await r.bench.client.snapshot()).panes.find(p => p.id === b1)?.status;
  const shown = new Set<string>();
  for (const say of ['/status blocked', '/status working', '/status idle', '/status unknown']) {
    await r.bench.type('b1', say);
    const want = say === '/status idle' ? ['done', 'idle'] : [say.slice(8)];
    await expect.poll(async () => want.includes(String(await herdrStatus())), { message: `Herdr reports ${want.join(' or ')}` }).toBe(true);
    const status = await herdrStatus();
    await expect.poll(async () => (await tile(b1))?.light, { message: say }).toBe(status);
    shown.add(String(status));
  }
  // Four distinct statuses were shown here; done has its own light in panels.ts (gallery shot 04).
  expect(shown.size).toBeGreaterThanOrEqual(4);
  await r.bench.type('b1', '/status idle');
  await r.bench.client.call('pane.focus', { pane_id: b1 });
  await r.bench.client.call('pane.focus', { pane_id: r.bench.pane('a1') });
  await expect.poll(async () => (await tile(b1))?.light).toBe('idle');

  await r.bench.addWorkspace({ label: 'gamma', panes: [{ name: 'g1', kind: 'agent' }] });
  await expect.poll(async () => (await tile(r.bench.pane('g1')))?.project).toBe('gamma');

  await r.bench.client.call('pane.rename', { pane_id: r.bench.pane('g1'), label: 'renamed-agent' });
  await r.bench.client.call('pane.focus', { pane_id: r.bench.pane('g1') });
  await expect.poll(async () => (await tile(r.bench.pane('g1')))?.name).toBe('renamed-agent');
  await r.bench.client.call('pane.focus', { pane_id: r.bench.pane('a1') });
  await r.bench.client.call('workspace.rename', { workspace_id: r.bench.workspaces.get('gamma') as string, label: 'gamma-renamed' });
  await expect.poll(async () => (await tile(r.bench.pane('g1')))?.project).toBe('gamma-renamed');

  const moved = await r.bench.client.call('pane.move', { pane_id: r.bench.pane('sh1'), destination: { type: 'new_tab', workspace_id: r.bench.workspaces.get('beta') as string }, focus: false });
  const newId = (moved.move_result as { pane: { pane_id: string } }).pane.pane_id;
  await expect.poll(async () => (await tile(newId))?.project).toBe('beta');
  expect((await tile(r.bench.pane('sh1')))?.closed ?? true, 'the old id is not shown as a live session').toBe(true);

  await r.bench.client.call('pane.close', { pane_id: r.bench.pane('g1') });
  await expect.poll(async () => await tile(r.bench.pane('g1')), { timeout: 10_000 }).toBeUndefined();

  // The front session's text keeps up, complete and in order.
  await r.bench.type('a1', '/steady 240 8');
  await expect.poll(async () => (await page.evaluate(id => window.viewTest.text(id), r.bench.pane('a1'))).some(l => l.includes('a1 END 240')), { timeout: 15_000 }).toBe(true);
  const lines = await page.evaluate(id => window.viewTest.text(id), r.bench.pane('a1'));
  const numbers = lines.flatMap(l => /a1 L(\d{5})/.exec(l)?.[1] ?? []).map(Number);
  expect(numbers).toEqual(Array.from({ length: 240 }, (_, i) => i + 1));
});

test('each way the mirror stops being current says so and what to do, and recovers without a reload', async ({ page, context }) => {
  test.setTimeout(150_000);
  r = await rig([{ label: 'alpha-project', panes: [{ name: 'a1', kind: 'agent' }, { name: 'a2', kind: 'agent' }] }]);
  await pair(page, r);
  const stale = async () => (await viewState(page)).stale;
  await page.evaluate(() => { (window as unknown as { loaded: number }).loaded = 1; });
  const sameDocument = async () => await page.evaluate(() => (window as unknown as { loaded?: number }).loaded === 1);

  // Herdr gone, then back.
  await r.bench.stopServer();
  await expect.poll(stale).toContain('Herdr is not running on the PC. Start Herdr');
  await page.screenshot({ path: test.info().outputPath('stale-herdr-down.png') });
  await r.bench.startServer();
  await expect.poll(stale, { timeout: 15_000 }).toBeNull();

  // The bridge gone, then back on the same port with the same pairing.
  const port = Number(new URL(r.view.url).port);
  await r.view.stop();
  await expect.poll(stale).toContain('No link to the view bridge on the PC');
  const { startView } = await import('../bridge/view.js');
  const { ScriptedSpeech, benchAgents } = await import('./fixture.js');
  r.view = await startView({ herdrSocket: r.bench.socketPath, dataDirectory: r.data, host: '127.0.0.1', port, speech: new ScriptedSpeech(), agents: benchAgents(r.bench, r.data), log: () => undefined, showPairingCode: () => undefined });
  await expect.poll(stale, { timeout: 20_000 }).toBeNull();

  // The headset's own link lost, then back.
  await context.setOffline(true);
  await expect.poll(stale).toContain('This headset is offline. Check its Wi-Fi');
  await context.setOffline(false);
  await expect.poll(stale, { timeout: 20_000 }).toBeNull();

  // A session closed in Herdr: its window says so, and nothing is asked of the owner.
  await r.bench.client.call('pane.close', { pane_id: r.bench.pane('a2') });
  await expect.poll(async () => (await viewState(page)).notice).toContain('closed in Herdr');

  // Pairing no longer valid, then paired again from the page.
  for (const client of r.view.pairing.clients()) if (!client.revokedAt) r.view.pairing.revoke(client.id);
  await expect.poll(stale, { timeout: 20_000 }).toContain('not paired');
  await page.screenshot({ path: test.info().outputPath('stale-unpaired.png') });
  await page.locator('#code').fill(r.view.pairing.setupCode().code);
  await page.getByRole('button', { name: 'Pair this headset' }).click();
  await expect.poll(stale, { timeout: 15_000 }).toBeNull();
  expect(await sameDocument(), 'no reload happened').toBe(true);
});

test('with a single session, it is the one in front and the shelf holds nothing else', async ({ page }) => {
  test.setTimeout(60_000);
  r = await rig([{ label: 'solo-project', panes: [{ name: 'only', kind: 'agent' }] }]);
  await emulateQuest(page);
  await pair(page, r);
  await enterMixedReality(page);
  await expect.poll(async () => (await viewState(page)).front).toBe(r.bench.pane('only'));
  const s = await viewState(page);
  expect(s.columns.map(c => [c.project, c.tiles.map(t => t.inFront)])).toEqual([['solo-project', [true]]]);
  await page.screenshot({ path: test.info().outputPath('mr-one-session.png') });
});

test('a short answer above a tall blank area shows with the input box, on the front and on the tile', async ({ page }) => {
  test.setTimeout(60_000);
  r = await rig([{ label: 'alpha', panes: [{ name: 'tall', kind: 'agent' }, { name: 'plain', kind: 'agent' }, { name: 'gappy', kind: 'agent' }] }]);
  await pair(page, r);
  const frontOf = async (name: string) => { await r.bench.client.call('pane.focus', { pane_id: r.bench.pane(name) }); await expect.poll(async () => (await viewState(page)).front).toBe(r.bench.pane(name)); };
  const tileOf = async (name: string) => (await viewState(page)).columns.flatMap(c => c.tiles).find(t => t.id === r.bench.pane(name))?.text ?? [];

  // What Claude Code draws in a 69-row pane: a short answer, blank rows, the input box at the bottom.
  await r.bench.type('tall', '/tall 45');
  await r.bench.type('gappy', '/tall 2');
  await r.bench.type('plain', '/burst 5');
  await frontOf('tall');
  await expect.poll(async () => (await viewState(page)).frontText.join('\n')).toContain('tall INPUT BOX');
  const front = (await viewState(page)).frontText;
  expect(front.join('\n'), 'the answer is in view with the input box, with nothing scrolled').toContain('tall SHORT ANSWER');
  expect((await viewState(page)).scroll).toBe(0);
  const answerAt = front.findIndex(l => l.includes('tall SHORT ANSWER'));
  expect(front.slice(answerAt, answerAt + 3).map(l => l.trim()), 'the 45 blank rows between answer and box are drawn as one').toEqual(['tall SHORT ANSWER', '', '╭────────────────────╮']);

  // On its tile, once another session is in front.
  await frontOf('plain');
  await expect.poll(async () => (await tileOf('tall')).join('\n')).toContain('tall INPUT BOX');
  expect((await tileOf('tall')).join('\n'), 'the answer is on the tile too').toContain('tall SHORT ANSWER');

  // Text with no such run is shown as it is, a short run of blank rows included.
  await expect.poll(async () => (await tileOf('gappy')).join('\n')).toContain('gappy INPUT BOX');
  const gappy = await tileOf('gappy');
  const at = gappy.findIndex(l => l.includes('gappy SHORT ANSWER'));
  expect(gappy.slice(at, at + 4).map(l => l.trim())).toEqual(['gappy SHORT ANSWER', '', '', '╭────────────────────╮']);
  await expect.poll(async () => (await viewState(page)).frontText.join('\n')).toContain('plain END 5');
  const plainRows = (await viewState(page)).frontText;
  expect(plainRows.filter(l => /plain L0000\d/.test(l)).length, 'unbroken text is all there').toBe(5);
});
