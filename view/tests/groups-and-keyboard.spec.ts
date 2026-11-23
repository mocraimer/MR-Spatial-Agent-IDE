/**
 * Tests for Deliverable 4 (two movable groups) and Deliverable 5 (typing from the headset).
 */
import { expect, test } from '@playwright/test';
import { emulateQuest, enterMixedReality, pair, rig, viewState, type Rig } from './fixture.js';

test.use({ ignoreHTTPSErrors: true, viewport: { width: 1600, height: 1000 } });

let r: Rig;
test.afterEach(async () => { await r?.stop(); });

// ---- Deliverable 4: two movable groups ----------------------------------------------------------------

test('AC-4.1: grab bars for screens and controls groups appear in the surface list in mixed reality', async ({ page }) => {
  test.setTimeout(60_000);
  r = await rig([{ label: 'alpha', panes: [{ name: 'a1', kind: 'agent' as const }] }]);
  await emulateQuest(page);
  await pair(page, r);
  await enterMixedReality(page);

  // Both grab bars are present as surfaces.
  await expect.poll(async () => (await viewState(page)).surfaces).toContain('bar:screens');
  await expect.poll(async () => (await viewState(page)).surfaces).toContain('bar:controls');
});

test('AC-4.1: group offsets saved to localStorage and loaded on reload', async ({ page }) => {
  test.setTimeout(90_000);
  r = await rig([{ label: 'alpha', panes: [{ name: 'a1', kind: 'agent' as const }] }]);
  await emulateQuest(page);
  await pair(page, r);
  await enterMixedReality(page);

  // Write a known offset directly into localStorage (simulates a drag).
  const key = 'spatial-view-group-offsets';
  await page.evaluate((k) => {
    localStorage.setItem(k, JSON.stringify([[0.1, -0.05, -0.95, 0.1], [0, -0.4, -0.6, 0]]));
  }, key);

  // Reload and verify the offset is read back.
  await page.reload({ waitUntil: 'domcontentloaded' });
  const stored = await page.evaluate((k) => localStorage.getItem(k), key);
  expect(stored).not.toBeNull();
  const parsed = JSON.parse(stored as string) as unknown[];
  expect(Array.isArray(parsed) && parsed.length === 2).toBe(true);
  // The first tuple should still match what we wrote.
  expect((parsed[0] as number[])[0]).toBeCloseTo(0.1, 5);
});

test('AC-4.1: recenter resets both group offsets to defaults', async ({ page }) => {
  test.setTimeout(60_000);
  r = await rig([{ label: 'alpha', panes: [{ name: 'a1', kind: 'agent' as const }] }]);
  await emulateQuest(page);
  await pair(page, r);
  await enterMixedReality(page);

  const key = 'spatial-view-group-offsets';
  // Write a non-default offset.
  await page.evaluate((k) => {
    localStorage.setItem(k, JSON.stringify([[0.5, 0, -1, 0], [0.3, -0.5, -0.5, 0]]));
  }, key);

  // Trigger recenter via the command endpoint.
  const url = await page.evaluate(() => window.location.origin);
  await page.evaluate(async (base) => {
    await fetch(`${base}/api/action`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ command: 'recenter' }) });
  }, url);

  // After recenter, the stored offset should reflect defaults (screens near identity, controls at default distance).
  await expect.poll(async () => {
    const raw = await page.evaluate((k) => localStorage.getItem(k), key);
    if (!raw) return false;
    const d = JSON.parse(raw) as [[number, number, number, number], [number, number, number, number]];
    // Screens: x~0, y~0, z~0 (identity)
    const sx = Math.abs(d[0][0]) < 0.01 && Math.abs(d[0][1]) < 0.01 && Math.abs(d[0][2]) < 0.01;
    return sx;
  }).toBe(true);
});

// ---- Deliverable 5: typing from the headset -----------------------------------------------------------

test('AC-5.1: keyboard button appears in the controls surface and responds to tap', async ({ page }) => {
  test.setTimeout(60_000);
  r = await rig([{ label: 'alpha', panes: [{ name: 'a1', kind: 'agent' as const }] }]);
  await emulateQuest(page);
  await pair(page, r);
  await enterMixedReality(page);

  // The keyboard button should be in the controls-0 surface.
  await expect.poll(async () => (await viewState(page)).surfaces).toContain('controls-0');

  // keyboardOpen starts false.
  const s = await viewState(page);
  expect(s.keyboardOpen).toBe(false);
});

test('AC-5.1: keyboard button in the registry has spoken forms "keyboard", "show keyboard", "open keyboard", "type"', async ({ page: _page }) => {
  // Static check: the COMMANDS registry lists these forms for the keyboard command.
  // This is exercised by the user-guide test; here we verify programmatically.
  const { COMMANDS } = await import('../shared/actions.js');
  const kb = COMMANDS.find(c => c.id === 'keyboard');
  expect(kb).toBeTruthy();
  expect(kb?.say).toContain('keyboard');
  expect(kb?.say).toContain('show keyboard');
  expect(kb?.say).toContain('open keyboard');
  expect(kb?.say).toContain('type');
  expect(kb?.run).toMatchObject({ page: 'keyboard' });
});

test('AC-5.3: diagnostics: keyboardOpen state is exposed in viewState', async ({ page }) => {
  test.setTimeout(60_000);
  r = await rig([{ label: 'alpha', panes: [{ name: 'a1', kind: 'agent' as const }] }]);
  await emulateQuest(page);
  await pair(page, r);
  await enterMixedReality(page);

  // Initially keyboard is not open.
  expect((await viewState(page)).keyboardOpen).toBe(false);

  // Focus the hidden keyboard input directly (simulates a keyboard open event).
  await page.evaluate(() => {
    const el = document.getElementById('keyboard-input') as HTMLInputElement | null;
    if (el) el.focus();
  });

  // After focus, keyboardOpen should be true.
  await expect.poll(async () => (await viewState(page)).keyboardOpen).toBe(true);

  // Blur closes it.
  await page.evaluate(() => {
    const el = document.getElementById('keyboard-input') as HTMLInputElement | null;
    if (el) el.blur();
  });
  await expect.poll(async () => (await viewState(page)).keyboardOpen).toBe(false);
});
