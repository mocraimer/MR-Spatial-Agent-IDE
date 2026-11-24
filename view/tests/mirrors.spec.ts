import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { compiled } from '../bridge/config.js';
import { aim, emulateQuest, enterMixedReality, pair, press, rig, say, ScriptedSpeech, tap as tapOn, viewState, type Rig } from './fixture.js';

test.use({ ignoreHTTPSErrors: true, viewport: { width: 1400, height: 900 } });
let r: Rig;
let speech: ScriptedSpeech;
let dir: string;
test.afterEach(async () => { await r?.stop(); rmSync(dir, { recursive: true, force: true }); });

const LAYOUT = [
  { label: 'alpha', panes: [{ name: 'a1', kind: 'agent' as const }, { name: 'sh', kind: 'shell' as const }] },
  { label: 'beta', panes: [{ name: 'b1', kind: 'agent' as const }] },
];

async function start(page: Page, windows?: { hwnd: number; title: string; app: string }[]): Promise<void> {
  dir = mkdtempSync('/tmp/svw-');
  process.env.SPATIAL_WINDOW_HELPER = `node ${compiled('bench', 'fake-windows.js')}`;
  process.env.SPATIAL_FAKE_WINDOWS_LOG = join(dir, 'windows.log');
  process.env.SPATIAL_FAKE_WINDOWS_CTL = join(dir, 'windows.ctl');
  if (windows) process.env.SPATIAL_FAKE_WINDOWS = JSON.stringify(windows); else delete process.env.SPATIAL_FAKE_WINDOWS;
  const roots = ['home', 'd', 'projects'].map(x => join(dir, x));
  for (const root of roots) mkdirSync(root);
  process.env.SPATIAL_PROJECT_ROOTS = roots.join(':');
  process.env.SPATIAL_NEW_PROJECT_ROOT = roots[0];
  speech = new ScriptedSpeech();
  r = await rig(LAYOUT, { speech });
  await emulateQuest(page);
  await pair(page, r);
  await page.evaluate(() => window.viewTest.fakeMic());
  await enterMixedReality(page);
  await r.view.bridge.act({ kind: 'go', projectId: r.bench.workspaces.get('alpha') as string });
  await expect.poll(async () => (await viewState(page)).place).toMatchObject({ project: 'alpha' });
}
const inputs = () => existsSync(join(dir, 'windows.log')) ? readFileSync(join(dir, 'windows.log'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as { hwnd?: number; events?: { type: string; x?: number; y?: number; delta?: number }[] }) : [];
const speak = async (page: Page, words: string) => { speech.queue.push(words); await say(page, 'press-one'); };

test('a window is mirrored from the list by hand: its picture in front, clicks and scrolls go to the window, its tile shows a picture', async ({ page }) => {
  test.setTimeout(120_000);
  await start(page);
  const tap = (surface: string, id: string) => tapOn(page, 'controller', surface, id);
  await tap('controls-0', 'mirror');
  await expect.poll(async () => (await viewState(page)).picker?.items.length).toBe(3);
  const picker = (await viewState(page)).picker;
  expect(picker?.items.map(i => i.label)).toEqual(['Storefront — localhost:3000 - Google Chrome', 'Untitled - Notepad', expect.stringMatching(/^A window with a rather long title/)]);
  await tap('front', 'cancel');
  await expect.poll(async () => (await viewState(page)).picker).toBeNull();

  await tap('controls-0', 'mirror');
  await tap('front', 'pick:1');
  await expect.poll(async () => (await viewState(page)).frontWindow?.picture?.version ?? 0, { timeout: 15_000 }).toBeGreaterThan(0);
  const s = await viewState(page);
  expect(s.picker).toBeNull();
  expect(s.frontWindow?.note).toBeNull();
  expect(s.columns.flatMap(c => c.tiles).find(t => t.inFront)?.name).toBe('window: Storefront — localhost:3000 - Google Chrome');

  // A select on the picture clicks at the same point of the window.
  const rect = s.frontWindow?.rect as { x: number; y: number; w: number; h: number };
  const canvas = { w: 2464, h: 1208 };
  await aim(page, 'controller', 'front', (rect.x + rect.w * 0.25) / canvas.w, (rect.y + rect.h * 0.75) / canvas.h);
  await press(page, 'controller');
  await expect.poll(() => inputs().find(e => e.events?.[0]?.type === 'click')?.events?.[0]).toMatchObject({ x: expect.closeTo(0.25, 1), y: expect.closeTo(0.75, 1) });
  await tap('controls-0', 'scroll-down');
  await expect.poll(() => inputs().some(e => e.events?.[0]?.type === 'wheel' && e.events[0].delta === -3)).toBe(true);

  // With another session in front, the mirror's tile shows a picture too.
  await r.view.bridge.act({ kind: 'focus', sessionId: r.bench.pane('sh') });
  await expect.poll(async () => (await viewState(page)).columns.flatMap(c => c.tiles).find(t => t.window)?.picture ?? 0, { timeout: 10_000 }).toBeGreaterThan(0);
});

test('the window list by voice: "mirror", a name narrows it, a number picks; "more" and "previous" turn pages; "cancel" closes it', async ({ page }) => {
  test.setTimeout(150_000);
  const many = Array.from({ length: 14 }, (_, i) => ({ hwnd: 300 + i, title: `Window ${i + 1}${i === 12 ? ' docs viewer' : ''}`, app: 'app.exe' }));
  await start(page, many);
  await speak(page, 'mirror');
  await expect.poll(async () => (await viewState(page)).picker?.pages).toBe(2);
  await speak(page, 'more');
  await expect.poll(async () => (await viewState(page)).picker?.page).toBe(1);
  await speak(page, 'previous');
  await expect.poll(async () => (await viewState(page)).picker?.page).toBe(0);
  // By hand too — the More and Previous buttons sit in the bottom 7 % edge zone of the front
  // canvas; before the fix, pressing them started a resize instead of turning the page.
  await tapOn(page, 'hand', 'front', 'more');
  await expect.poll(async () => (await viewState(page)).picker?.page).toBe(1);
  await tapOn(page, 'hand', 'front', 'previous');
  await expect.poll(async () => (await viewState(page)).picker?.page).toBe(0);
  // Confirm no resize happened — screensScale must still be 1.0.
  const raw = await page.evaluate(() => localStorage.getItem('spatial-view-group-offsets'));
  if (raw) {
    const d = JSON.parse(raw) as [[number, number, number], [number, number, number]];
    expect(d[0][2] ?? 1, 'screensScale still 1.0 — More/Previous did not trigger resize').toBeCloseTo(1.0, 2);
  }
  await speak(page, 'docs viewer');
  await expect.poll(async () => (await viewState(page)).picker?.items.map(i => i.label)).toEqual(['Window 13 docs viewer']);
  expect((await viewState(page)).last?.outcome).toMatch(/matches "docs viewer"/);
  await speak(page, 'cancel');
  await expect.poll(async () => (await viewState(page)).picker).toBeNull();
  await speak(page, 'mirror');
  await speak(page, 'number two');
  await expect.poll(async () => (await viewState(page)).frontWindow?.picture?.version ?? 0, { timeout: 15_000 }).toBeGreaterThan(0);
  expect((await viewState(page)).columns.flatMap(c => c.tiles).find(t => t.inFront)?.name).toBe('window: Window 2');
});

test('the New project list: by hand a git folder is picked and the view goes into it; by voice "make" names a new folder; an existing name is refused', async ({ page }) => {
  test.setTimeout(120_000);
  await start(page);
  for (const name of ['shop', 'notes']) { mkdirSync(join(dir, 'd', name)); execFileSync('git', ['init', '-q'], { cwd: join(dir, 'd', name) }); }
  mkdirSync(join(dir, 'd', 'plain-folder'));
  await tapOn(page, 'controller', 'controls-0', 'new-project');
  await expect.poll(async () => (await viewState(page)).picker?.items.map(i => i.label).sort()).toEqual(['notes', 'shop']);
  const shop = (await viewState(page)).picker?.items.find(i => i.label === 'shop')?.n as number;
  await tapOn(page, 'controller', 'front', `pick:${shop}`);
  await expect.poll(async () => (await viewState(page)).place, { timeout: 15_000 }).toMatchObject({ project: 'shop' });
  const shopPane = (await r.bench.client.snapshot()).panes.find(p => p.cwd === join(dir, 'd', 'shop'));
  expect(shopPane, 'the new project\'s first session starts in the folder').toBeTruthy();

  await speak(page, 'new project');
  await expect.poll(async () => (await viewState(page)).picker?.kind).toBe('folders');
  await speak(page, 'garden');
  await expect.poll(async () => (await viewState(page)).picker?.make).toBe('garden');
  await tapOn(page, 'controller', 'front', 'make');
  await expect.poll(async () => (await viewState(page)).place, { timeout: 15_000 }).toMatchObject({ project: 'garden' });
  expect(existsSync(join(dir, 'home', 'garden', '.git'))).toBe(true);

  writeFileSync(join(dir, 'home', 'garden', 'keep.txt'), 'x');
  await speak(page, 'new project');
  await speak(page, 'make garden');
  expect((await viewState(page)).last?.outcome).toMatch(/already exists/);
  expect(readFileSync(join(dir, 'home', 'garden', 'keep.txt'), 'utf8')).toBe('x');
  await tapOn(page, 'controller', 'front', 'cancel');
  await expect.poll(async () => (await viewState(page)).picker).toBeNull();
});

test('a full-screen viewer taller than the front panel shows whole: every row, top to bottom', async ({ page }) => {
  test.setTimeout(90_000);
  await start(page);
  const script = join(dir, 'screen.py');
  writeFileSync(script, [
    'import sys, time, shutil',
    'cols, rows = shutil.get_terminal_size()',
    "sys.stdout.write('\\x1b[?1049h\\x1b[H')",
    "lines = ['TOPLEFT' + ' ' * (cols - 15) + 'TOPRIGHT'] + ['row %d' % i for i in range(2, rows)] + ['BOTLEFT' + ' ' * (cols - 15) + 'BOTRIGHT']",
    "sys.stdout.write('\\r\\n'.join(lines))",
    'sys.stdout.flush()',
    'time.sleep(120)',
  ].join('\n'));
  await r.view.bridge.act({ kind: 'focus', sessionId: r.bench.pane('sh') });
  await r.bench.type('sh', `python3 ${script}`);
  await expect.poll(async () => { const t = (await viewState(page)).frontText; return [t[0]?.includes('TOPLEFT'), t.at(-1)?.includes('BOTRIGHT'), t.length]; }, { timeout: 15_000 }).toEqual([true, true, 40]);
});
