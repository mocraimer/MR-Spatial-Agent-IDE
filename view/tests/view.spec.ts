import { expect, test } from '@playwright/test';
import { OWNER_SHAPE } from '../bench/bench.js';
import { aim, emulateQuest, enterMixedReality, pair, press, rig, viewState, type Rig } from './fixture.js';

test.use({ ignoreHTTPSErrors: true, viewport: { width: 1600, height: 1000 } });

let r: Rig;
test.afterEach(async () => { await r?.stop(); });

test('every pane Herdr lists is a task window under its project, with live text and a light', async ({ page }) => {
  test.setTimeout(60_000);
  r = await rig(OWNER_SHAPE);
  await pair(page, r);
  const herdr = await r.bench.client.snapshot();
  const labels = new Map(herdr.workspaces.map(w => [w.id, w.label]));
  await expect.poll(async () => (await viewState(page)).columns.flatMap(c => c.tiles).length).toBe(herdr.panes.length);
  const s = await viewState(page);
  const shown = s.columns.flatMap(c => c.tiles.map(t => [t.id, c.project] as const)).sort();
  expect(shown).toEqual(herdr.panes.map(p => [p.id, labels.get(p.workspaceId) as string] as const).sort());
  await page.screenshot({ path: test.info().outputPath('shelf-owner-shape.png') });
});

test('the shelf in mixed reality: one session large, every other a tile; a controller or a hand brings a tile forward', async ({ page }) => {
  test.setTimeout(90_000);
  r = await rig(OWNER_SHAPE);
  await emulateQuest(page);
  await pair(page, r);
  await enterMixedReality(page);
  await expect.poll(async () => (await viewState(page)).columns.flatMap(c => c.tiles).length).toBe(10);
  await page.screenshot({ path: test.info().outputPath('mr-eight-agents.png') });

  for (const [input, name] of [['controller', 'payouts'], ['hand', 'terraform']] as const) {
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
  const tile = async (id: string) => (await viewState(page)).columns.flatMap(c => c.tiles.map(t => ({ ...t, project: c.project }))).find(t => t.id === id);
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
  await expect.poll(async () => (await tile(r.bench.pane('g1')))?.name).toBe('renamed-agent');
  await r.bench.client.call('workspace.rename', { workspace_id: r.bench.workspaces.get('gamma') as string, label: 'gamma-renamed' });
  await expect.poll(async () => (await tile(r.bench.pane('g1')))?.project).toBe('gamma-renamed');

  const moved = await r.bench.client.call('pane.move', { pane_id: r.bench.pane('sh1'), destination: { type: 'new_tab', workspace_id: r.bench.workspaces.get('beta') as string }, focus: false });
  const newId = (moved.move_result as { pane: { pane_id: string } }).pane.pane_id;
  await expect.poll(async () => (await tile(newId))?.project).toBe('beta');
  expect((await tile(r.bench.pane('sh1')))?.closed ?? true, 'the old id is not shown as a live session').toBe(true);

  await r.bench.client.call('pane.close', { pane_id: r.bench.pane('g1') });
  await expect.poll(async () => (await tile(r.bench.pane('g1')))?.closed).toBe(true);
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
  const { ScriptedSpeech, noHelper } = await import('./fixture.js');
  r.view = await startView({ herdrSocket: r.bench.socketPath, dataDirectory: r.data, host: '127.0.0.1', port, speech: new ScriptedSpeech(), helper: noHelper, log: () => undefined, showPairingCode: () => undefined });
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
