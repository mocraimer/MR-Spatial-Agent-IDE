/**
 * The Windows-side run: window mirrors end to end on this PC, with the real helper on Windows,
 * a bench Herdr and the real bridge. It uses only windows it opens itself (a test window, and a
 * browser with a temporary profile), never the owner's.
 *
 *   node build/view/bench/windows-run.js [screenshot-folder]
 *
 * Prints a JSON report; exits 1 when a check fails. Needs Windows Python 3.12 with
 * windows-capture and pywin32 (see view/windows/window_helper.py) and Chromium for Playwright.
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { HerdrBench } from './bench.js';
import { benchAgents, ScriptedSpeech } from '../tests/fixture.js';
import { REPO } from '../bridge/config.js';
import { startView, type RunningView } from '../bridge/view.js';
import { plain } from '../shared/ansi.js';
import type { BridgeEvent } from '../shared/messages.js';

const shots = process.argv[2];
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const report: Record<string, unknown> = {};
const failures: string[] = [];
const check = (name: string, ok: boolean, detail: unknown) => { report[name] = { ok, detail }; if (!ok) failures.push(name); };
const winPath = (p: string) => execFileSync('wslpath', ['-w', p], { encoding: 'utf8' }).trim();

const profile = execFileSync('/mnt/c/Windows/System32/cmd.exe', ['/c', 'echo %TEMP%'], { cwd: '/mnt/c', encoding: 'utf8' }).trim();
const tempWin = execFileSync('wslpath', ['-u', profile], { encoding: 'utf8' }).trim();
const runDir = join(tempWin, `spatial-run-${Date.now()}`);
mkdirSync(runDir, { recursive: true });
const record = join(runDir, 'record.json');
const title = `Spatial mirror test target ${Date.now() % 100000}`;
process.env.SPATIAL_BROWSER_ARGS = [`--user-data-dir=${winPath(join(runDir, 'chrome-profile'))}`, '--no-first-run', '--no-default-browser-check'].join('|');
delete process.env.SPATIAL_WINDOW_HELPER;

const py = (() => { const p = '/mnt/c/Windows/py.exe'; if (existsSync(p)) return p; const local = execFileSync('/mnt/c/Windows/System32/cmd.exe', ['/c', 'echo %LOCALAPPDATA%'], { cwd: '/mnt/c', encoding: 'utf8' }).trim(); return join(execFileSync('wslpath', ['-u', local], { encoding: 'utf8' }).trim(), 'Programs', 'Python', 'Launcher', 'py.exe'); })();
const target = spawn(py, ['-3.12', winPath(join(REPO, 'view', 'windows', 'test_target.py')), winPath(record), title], { cwd: '/mnt/c', stdio: 'ignore' });
const recorded = () => { try { return JSON.parse(readFileSync(record, 'utf8')) as { keys: string; clicks: number[][]; wheel: number; text: string }; } catch { return null; } };

const page = createServer((_, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<html><body style="font:48px sans-serif;background:#ffe"><h1>Spatial run page</h1><p>Served from WSL.</p></body></html>'); });
await new Promise<void>(resolve => page.listen(0, '127.0.0.1', resolve));
const pagePort = (page.address() as { port: number }).port;

const bench = await HerdrBench.start([{ label: 'alpha', panes: [{ name: 'a1', kind: 'agent' }, { name: 'sh', kind: 'shell' }] }]);
const data = mkdtempSync('/tmp/svwr-');
const logs: string[] = [];
const view = await startView({ herdrSocket: bench.socketPath, dataDirectory: data, host: '127.0.0.1', port: 0, speech: new ScriptedSpeech(), agents: benchAgents(bench, data), log: l => logs.push(l), showPairingCode: () => undefined });
const events: { at: number; e: BridgeEvent }[] = [];
view.bridge.connect(e => events.push({ at: Date.now(), e }));
const note = (id: string) => [...events].reverse().find(x => x.e.type === 'window' && x.e.id === id)?.e as Extract<BridgeEvent, { type: 'window' }> | undefined;
const frames = (id: string) => events.filter(x => x.e.type === 'frame' && x.e.id === id);
let browserHwnd: number | null = null;
// dataFit is set by B.9 and used in the outer finally's "nothing left running" filter.
let dataFit: string | null = null;

try {
  await sleep(2500);
  const alpha = bench.workspaces.get('alpha') as string;
  await view.bridge.act({ kind: 'go', projectId: alpha });
  const t0 = Date.now();
  const listed = await view.bridge.act({ kind: 'picker', list: 'windows' });
  const picker = [...events].reverse().find(x => x.e.type === 'picker')?.e as Extract<BridgeEvent, { type: 'picker' }>;
  const all = picker.picker?.items ?? [];
  check('list', all.some(i => i.label === title), { outcome: listed.outcome, ms: Date.now() - t0, count: all.length });
  const mine = all.find(i => i.label === title);
  if (!mine) throw new Error('the test window is not in the list');
  const pick = await view.bridge.act({ kind: 'pick', n: mine.n });
  await view.mirror.tick();
  const mirrorId = view.mirror.shelf().focusedId as string;
  check('pick', pick.ok && view.mirror.shelf().sessions.find(s => s.id === mirrorId)?.window === true, pick.outcome);
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline && frames(mirrorId).length < 3) await sleep(200);
  const f = frames(mirrorId);
  const gaps = f.slice(1).map((x, i) => x.at - (f[i] as { at: number }).at);
  check('picture', f.length >= 3 && note(mirrorId)?.note == null, { frames: f.length, size: f[0] && [(f[0].e as { w: number }).w, (f[0].e as { h: number }).h], medianGapMs: gaps.sort((a, b) => a - b)[Math.floor(gaps.length / 2)] });

  // The test window changes colour every 500 ms: each change should reach the page within about half a second.
  const window0 = frames(mirrorId).length;
  await sleep(4000);
  const perSecond = (frames(mirrorId).length - window0) / 4;
  check('picture follows changes', perSecond >= 1.5, { framesPerSecond: perSecond });

  // Desk keys: Herdr gives them to the focused pane, the mirror's.
  const k0 = Date.now();
  await bench.client.call('pane.send_input', { pane_id: mirrorId, text: 'hello mirror', keys: ['enter'] });
  let rec = recorded();
  while (Date.now() - k0 < 8000 && !rec?.text.includes('hello mirror')) { await sleep(100); rec = recorded(); }
  check('desk keys reach the window', Boolean(rec?.text.includes('hello mirror\n')), { ms: Date.now() - k0, keys: rec?.keys });

  // A terminal in front: desk keys reach Herdr, not the window.
  const sh = bench.pane('sh');
  await view.bridge.act({ kind: 'focus', sessionId: sh });
  const before = recorded()?.text;
  await bench.client.call('pane.send_input', { pane_id: sh, text: 'echo at-the-desk', keys: ['enter'] });
  await sleep(1500);
  const shText = plain(await bench.client.read(sh, 20));
  check('keys go back to Herdr', shText.includes('at-the-desk') && recorded()?.text === before, { shell: shText.includes('at-the-desk'), windowUnchanged: recorded()?.text === before });
  await view.bridge.act({ kind: 'focus', sessionId: mirrorId });

  const click = await view.bridge.act({ kind: 'window-input', sessionId: mirrorId, events: [{ type: 'click', x: 0.5, y: 0.5 }] });
  const wheel = await view.bridge.act({ kind: 'window-input', sessionId: mirrorId, events: [{ type: 'wheel', x: 0.5, y: 0.5, delta: -2 }] });
  await sleep(500);
  rec = recorded();
  check('pointing clicks and scrolls', click.ok && wheel.ok && (rec?.clicks.length ?? 0) > 0 && (rec?.wheel ?? 0) < 0, { click: rec?.clicks.at(-1), wheel: rec?.wheel });

  if (shots) {
    mkdirSync(shots, { recursive: true });
    const browser = await chromium.launch();
    const p = await browser.newPage({ ignoreHTTPSErrors: true, viewport: { width: 1400, height: 900 } });
    await p.goto(view.url);
    await p.locator('#code').fill(view.pairing.setupCode().code);
    await p.getByRole('button', { name: 'Pair this headset' }).click();
    await p.waitForFunction(() => (window.viewState() as { frontWindow: { picture: unknown } | null }).frontWindow?.picture != null, undefined, { timeout: 15_000 });
    await p.waitForTimeout(800);
    await p.screenshot({ path: join(shots, 'mirror-in-front.png') });
    await browser.close();
    report.screenshot = join(shots, 'mirror-in-front.png');
  }

  writeFileSync(`${record}.cmd`, 'minimize');
  const m0 = Date.now();
  while (Date.now() - m0 < 6000 && !/minimized/i.test(note(mirrorId)?.note ?? '')) await sleep(200);
  const minimized = note(mirrorId)?.note;
  writeFileSync(`${record}.cmd`, 'restore');
  const r0 = Date.now();
  while (Date.now() - r0 < 8000 && note(mirrorId)?.note !== null) await sleep(200);
  check('minimize and restore', /minimized/i.test(minimized ?? '') && note(mirrorId)?.note === null, { minimized, after: note(mirrorId)?.note });

  // An agent's order: a page from WSL opens in a browser window on the PC and is mirrored into alpha.
  const o0 = Date.now();
  const answer = await view.bridge.mirrorOrder({ open: `http://localhost:${pagePort}/`, workspace: alpha });
  await view.mirror.tick();
  const pageId = view.mirror.shelf().sessions.filter(s => s.window).map(s => s.id).find(id => id !== mirrorId) as string;
  const p0 = Date.now();
  while (Date.now() - p0 < 15_000 && frames(pageId).length < 1) await sleep(200);
  check('agent opens and mirrors a page', frames(pageId).length > 0 && view.mirror.shelf().focusedId === mirrorId, { answer, ms: Date.now() - o0 });
  // The run's own browser window, found by its page's title, to close at the end.
  const titles = JSON.parse(execFileSync(py, ['-3.12', '-c', 'import json,win32gui;r=[];win32gui.EnumWindows(lambda h,_: r.append([h,win32gui.GetWindowText(h)]),None);print(json.dumps(r))'], { cwd: '/mnt/c', encoding: 'utf8' })) as [number, string][];
  browserHwnd = titles.find(([, t]) => t.includes('Spatial run page') || t.includes(`localhost:${pagePort}`))?.[0] ?? null;

  // ── B.9: window fitting ──────────────────────────────────────────────────────────────────────
  // Opens a Windows Terminal window running the bench Herdr's TUI (not cmd.exe), verifies the
  // helper finds it by its workspace label, drives the REAL bridge's MR logic, and checks all
  // the fit scenarios: full-width → fit, layout change → re-fit, focus switch between panes of
  // different widths (split tab at 85/15) → re-fit, leave → restore, maximized → back to
  // maximized, hand-move → stays. A second window whose title does not match must never change
  // rect. Only the windows this run opened are closed.
  //
  // The bench Herdr uses an isolated HOME, so its socket and state are separate from the owner's.
  // The WT window title is "<host>: <workspace-label>" (set by herdr); the unique label avoids
  // collisions with the owner's windows. WSL_DISTRO_NAME is never hardcoded.
  const FIT_LABEL = `fit-${Date.now() % 100000}`;
  // herdr lives in ~/.local/bin, which is not on PATH when running `wsl.exe -- ...` without a
  // login shell. Resolve the absolute path in the current Linux session so we can pass it
  // explicitly to the WT command.
  const herdrBin = execFileSync('/bin/sh', ['-c', 'command -v herdr'], { encoding: 'utf8' }).trim();

  let benchFit: HerdrBench | null = null;
  let viewFit: RunningView | null = null;
  let fitHwnd: number | null = null;
  let otherHwnd: number | null = null;
  // WT hwnds (CASCADIA_HOSTING_WINDOW_CLASS) opened by this run; used in finally for cleanup.
  let fitWtHwnds: number[] = [];
  try {
    benchFit = await HerdrBench.start([
      { label: FIT_LABEL, panes: [{ name: 'fit-a', kind: 'agent' }] },
    ]);
    dataFit = mkdtempSync('/tmp/svwrf-');
    viewFit = await startView({
      herdrSocket: benchFit.socketPath, dataDirectory: dataFit,
      host: '127.0.0.1', port: 0, speech: new ScriptedSpeech(),
      agents: benchAgents(benchFit, dataFit),
      log: l => logs.push(`fit: ${l}`), showPairingCode: () => undefined,
    });

    const benchHome = join(benchFit.directory, 'home');
    const distro = process.env.WSL_DISTRO_NAME;
    if (!distro) throw new Error('fit: WSL_DISTRO_NAME is not set; cannot start herdr in WT');

    // Enumerate all visible windows (hwnd, title).
    const listWindows = () => JSON.parse(execFileSync(py, ['-3.12', '-c',
      `import json,win32gui;r=[];win32gui.EnumWindows(lambda h,_: r.append([h,win32gui.GetWindowText(h)]),None);print(json.dumps(r))`
    ], { cwd: '/mnt/c', encoding: 'utf8' })) as [number, string][];

    // Enumerate CASCADIA_HOSTING_WINDOW_CLASS hwnds: these are Windows Terminal (WT) windows.
    // Taking a snapshot before spawning lets us identify the new hwnd opened by this run, even
    // if the WT window never reaches the expected title (so we can always close what we opened).
    const listWtHwnds = () => JSON.parse(execFileSync(py, ['-3.12', '-c',
      `import json,win32gui;r=[];win32gui.EnumWindows(lambda h,_: r.append(h) if win32gui.GetClassName(h)=='CASCADIA_HOSTING_WINDOW_CLASS' else None,None);print(json.dumps(r))`
    ], { cwd: '/mnt/c', encoding: 'utf8' })) as number[];

    // Window rect helpers.
    const getRect = (hwnd: number) => JSON.parse(execFileSync(py, ['-3.12', '-c',
      `import json,ctypes,ctypes.wintypes as wt;r=wt.RECT();ctypes.windll.user32.GetWindowRect(${hwnd},ctypes.byref(r));print(json.dumps({'l':r.left,'t':r.top,'r':r.right,'b':r.bottom}))`,
    ], { cwd: '/mnt/c', encoding: 'utf8' })) as { l: number; t: number; r: number; b: number };
    const setWinRect = (hwnd: number, l: number, t: number, r: number, b: number) => execFileSync(py, ['-3.12', '-c',
      `import ctypes;ctypes.windll.user32.MoveWindow(${hwnd},${l},${t},${r-l},${b-t},True)`
    ], { cwd: '/mnt/c' });
    const isMaximized = (hwnd: number) => Boolean(JSON.parse(execFileSync(py, ['-3.12', '-c',
      `import ctypes,json;print(json.dumps(ctypes.windll.user32.IsZoomed(${hwnd})))`
    ], { cwd: '/mnt/c', encoding: 'utf8' })));

    // Bench pane.layout helper: returns column count for a pane.
    const getPaneCols = async (paneId: string) => {
      const layout = await benchFit!.client.call('pane.layout', { pane_id: paneId });
      const panes = (layout.layout as { panes?: { pane_id?: unknown; rect?: { width?: number } }[] } | undefined)?.panes ?? [];
      const rect = panes.find(p => p.pane_id === paneId)?.rect;
      return typeof rect?.width === 'number' ? rect.width : null;
    };

    // Split fit-a into a wide front pane (85%) and a narrow back pane (15%) in the same tab.
    // This exercises the focus-switch-between-different-width-panes case; using separate tabs
    // (tab.create) would give equally-wide panes and miss that scenario.
    const fitFrontPaneId = benchFit.pane('fit-a');
    const splitResult = await benchFit.client.call('pane.split', {
      pane_id: fitFrontPaneId, direction: 'right', ratio: 0.85,
    });
    const fitBackPaneId = (splitResult.pane as { pane_id: string }).pane_id;
    benchFit.panes.set('fit-b', fitBackPaneId); // register so benchFit.pane('fit-b') works

    // Take the snapshot of CASCADIA hwnds BEFORE spawning any WT windows.
    const hwndsBefore = listWtHwnds();

    // Open a second WT window whose title does NOT match the workspace label; its rect must
    // never change. Use a unique title so we can find it.
    const otherLabel = `fit-other-${Date.now() % 100000}`;
    spawn('/mnt/c/Windows/System32/cmd.exe', ['/c',
      `start wt.exe -w new cmd.exe /k "title ${otherLabel}"`
    ], { cwd: '/mnt/c', stdio: 'ignore', detached: true }).unref();

    // Open the main WT window running the bench Herdr TUI with isolated HOME.
    // Pass the absolute herdr path because wsl.exe --exec does not load the login shell and
    // ~/.local/bin is not in the PATH it inherits.
    // herdr connects to the already-running server and sets the title to "<host>: <label>".
    spawn('/mnt/c/Windows/System32/cmd.exe', ['/c',
      `start wt.exe -w new wsl.exe -d ${distro} -- env HOME=${benchHome} ${herdrBin}`
    ], { cwd: '/mnt/c', stdio: 'ignore', detached: true }).unref();

    // Wait for the WT window with title ending ": <FIT_LABEL>".
    // Track all new CASCADIA hwnds for cleanup regardless of whether the title matches.
    const expectedSuffix = `: ${FIT_LABEL}`;
    const wtDeadline = Date.now() + 20_000;
    while (Date.now() < wtDeadline) {
      await sleep(500);
      const currentWtHwnds = listWtHwnds();
      fitWtHwnds = currentWtHwnds.filter(h => !hwndsBefore.includes(h));
      const wins = listWindows();
      if (fitHwnd === null) {
        const m = wins.find(([h, t]) => fitWtHwnds.includes(h) && t.endsWith(expectedSuffix));
        if (m) fitHwnd = m[0];
      }
      if (otherHwnd === null) {
        const m = wins.find(([, t]) => t === otherLabel || t.endsWith(`: ${otherLabel}`));
        if (m) otherHwnd = m[0];
      }
      if (fitHwnd !== null) break;
    }
    check('fit: WT window found with ": <label>" suffix', fitHwnd !== null, { label: FIT_LABEL, fitHwnd });
    if (!fitHwnd) throw new Error('fit: WT window not found within 20 s');
    // Verify this window was opened by this run (not a pre-existing window).
    if (!fitWtHwnds.includes(fitHwnd)) throw new Error(`fit: hwnd ${fitHwnd} is not a window opened by this run`);

    // Record the other window's rect before any fit to verify it never changes.
    const otherR0 = otherHwnd ? getRect(otherHwnd) : null;

    // Record the initial rect of the fit window (before any MR fit).
    const r0 = getRect(fitHwnd);
    report['fit-initial-rect'] = r0;

    // Wait for herdr TUI to sync terminal dimensions with the server.
    await sleep(1500);

    // Focus the front pane (fit-a) so the initial column read and fit use it.
    await benchFit.client.call('pane.focus', { pane_id: fitFrontPaneId });
    await sleep(300);

    const cols0 = await getPaneCols(fitFrontPaneId);
    report['fit-cols-initial'] = cols0;

    // If the WT window started at ≤120 cols (fit-a is 85% of that), widen it so the initial
    // fit has something to do.
    if ((cols0 ?? 0) <= 120) {
      setWinRect(fitHwnd, r0.l, r0.t, r0.l + (r0.r - r0.l) * 2, r0.b);
      await sleep(1200); // give herdr time to report the new width
    }
    const colsBeforeFit = await getPaneCols(fitFrontPaneId);
    report['fit-cols-before-fit'] = colsBeforeFit;

    // Connect a page to the view to get a pageId for setMixedReality.
    let fitPageId: string | null = null;
    const fitDisconnect = viewFit.bridge.connect((event: BridgeEvent) => {
      if (event.type === 'instance') fitPageId = event.pageId;
    });
    await sleep(200);
    if (!fitPageId) throw new Error('fit: no instance event from bridge');

    // ── Scenario 1: full-width → fit → 116-120 cols within 3 s ─────────────────────────────
    // Take the reference rect immediately before entering MR: this is what the bridge will save
    // as restoreRect (the rect it sees on first findWindow, after any user widening above).
    const rBeforeEnter1 = getRect(fitHwnd);
    const t1 = Date.now();
    viewFit.bridge.setMixedReality(fitPageId, true);
    let colsAfterFit: number | null = null;
    const fitEnd = Date.now() + 3000;
    while (Date.now() < fitEnd) {
      await sleep(200);
      colsAfterFit = await getPaneCols(fitFrontPaneId);
      if (colsAfterFit !== null && colsAfterFit >= 116 && colsAfterFit <= 120) break;
    }
    const rAfterFit = getRect(fitHwnd);
    report['fit-cols-after-fit'] = colsAfterFit;
    report['fit-rect-after-fit'] = rAfterFit;
    report['fit-ms'] = Date.now() - t1;
    check('fit: cols 116-120 after MR enter', colsAfterFit !== null && colsAfterFit >= 116 && colsAfterFit <= 120, { colsAfterFit, ms: Date.now() - t1 });

    // ── Scenario 2: layout change → layout poll re-fits (Fix 4) ─────────────────────────────
    // Widen the WT window back to rBeforeEnter1 (the same size that gave colsBeforeFit > 120
    // before scenario 1). This is reliable: we already observed 186 cols > 120 at this size.
    setWinRect(fitHwnd, rBeforeEnter1.l, rBeforeEnter1.t, rBeforeEnter1.r, rBeforeEnter1.b);
    await sleep(1200);
    const colsAfterWiden = await getPaneCols(fitFrontPaneId);
    report['fit-cols-after-widen'] = colsAfterWiden;
    // The layout poll (every 2 s) detects > FRONT_COLS and re-fits.
    let colsAfterRefit: number | null = null;
    const refitEnd = Date.now() + 4000;
    while (Date.now() < refitEnd) {
      await sleep(200);
      colsAfterRefit = await getPaneCols(fitFrontPaneId);
      if (colsAfterRefit !== null && colsAfterRefit >= 116 && colsAfterRefit <= 120) break;
    }
    report['fit-cols-after-refit'] = colsAfterRefit;
    check('fit: layout poll re-fits when pane grows above 120', colsAfterRefit !== null && colsAfterRefit >= 116 && colsAfterRefit <= 120, { colsAfterRefit, colsAfterWiden });

    // ── Scenario 3: focus switch between panes of different widths ───────────────────────────
    // fit-b is the narrow pane (~15% of tab). Switching to it should NOT widen the window
    // (cols < MIN_FIT_COLS_POLL = 116). Switching back to fit-a (wide) should re-fit.
    await benchFit.client.call('pane.focus', { pane_id: fitBackPaneId });
    await sleep(1500);
    const colsFocusBack = await getPaneCols(fitBackPaneId);
    report['fit-cols-after-focus-switch-narrow'] = colsFocusBack;
    check('fit: narrow-pane focus does not over-resize (cols < 116)', colsFocusBack !== null && colsFocusBack < 116, { colsFocusBack });
    await benchFit.client.call('pane.focus', { pane_id: fitFrontPaneId });
    await sleep(1500);
    const colsFocusFront = await getPaneCols(fitFrontPaneId);
    report['fit-cols-after-focus-switch-wide'] = colsFocusFront;
    check('fit: wide-pane focus re-fits after switching back', colsFocusFront !== null && colsFocusFront >= 116 && colsFocusFront <= 120, { colsFocusFront });

    // ── Scenario 4: explicit leave → rect restored promptly ──────────────────────────────────
    // The bridge restores to rBeforeEnter1 (the rect it saved before its first fit, which is
    // the widened rect, not r0 which was taken before widening).
    viewFit.bridge.setMixedReality(fitPageId, false);
    await sleep(600);
    const rAfterLeave = getRect(fitHwnd);
    report['fit-rect-after-leave'] = rAfterLeave;
    check('fit: rect restored on explicit leave', Math.abs(rAfterLeave.l - rBeforeEnter1.l) < 30 && Math.abs((rAfterLeave.r - rAfterLeave.l) - (rBeforeEnter1.r - rBeforeEnter1.l)) < 30, { rBeforeEnter: rBeforeEnter1, rAfterLeave });

    // ── Scenario 5: maximized window → fit → leave → back to maximized ───────────────────────
    setWinRect(fitHwnd, r0.l, r0.t, r0.r, r0.b);
    await sleep(300);
    execFileSync(py, ['-3.12', '-c', `import ctypes;ctypes.windll.user32.ShowWindow(${fitHwnd},3)`], { cwd: '/mnt/c' }); // SW_MAXIMIZE
    await sleep(600);
    const maxBefore = isMaximized(fitHwnd);
    report['fit-maximized-before'] = maxBefore;
    const rBeforeEnter5 = getRect(fitHwnd);
    viewFit.bridge.setMixedReality(fitPageId, true);
    await sleep(2000);
    viewFit.bridge.setMixedReality(fitPageId, false);
    await sleep(600);
    const maxAfter = isMaximized(fitHwnd);
    report['fit-maximized-after'] = maxAfter;
    report['fit-rect-before-enter5'] = rBeforeEnter5;
    check('fit: maximized window restored to maximized after leave', maxAfter, { maxBefore, maxAfter });

    // ── Scenario 6: hand-move between fit and leave → stays where moved ──────────────────────
    execFileSync(py, ['-3.12', '-c', `import ctypes;ctypes.windll.user32.ShowWindow(${fitHwnd},9)`], { cwd: '/mnt/c' }); // SW_RESTORE
    setWinRect(fitHwnd, r0.l, r0.t, r0.r, r0.b);
    await sleep(400);
    const rBeforeEnter6 = getRect(fitHwnd);
    viewFit.bridge.setMixedReality(fitPageId, true);
    await sleep(2000);
    // "Hand-move": shift the window 100 px to the right after fit.
    const rFit2 = getRect(fitHwnd);
    const movedL = rFit2.l + 100;
    setWinRect(fitHwnd, movedL, rFit2.t, movedL + (rFit2.r - rFit2.l), rFit2.b);
    await sleep(400);
    viewFit.bridge.setMixedReality(fitPageId, false);
    await sleep(600);
    const rAfterHandMove = getRect(fitHwnd);
    report['fit-rect-before-enter6'] = rBeforeEnter6;
    report['fit-rect-after-hand-move'] = rAfterHandMove;
    check('fit: hand-moved window stays where moved on leave', Math.abs(rAfterHandMove.l - movedL) < 20, { movedL, actual: rAfterHandMove.l });

    // ── Second window: rect never changed ────────────────────────────────────────────────────
    if (otherHwnd && otherR0) {
      const otherRAfter = getRect(otherHwnd);
      check('fit: second window (non-matching title) rect unchanged', otherRAfter.l === otherR0.l && otherRAfter.r === otherR0.r, { otherR0, otherRAfter });
    }

    // Disconnect the page connection.
    fitDisconnect();

    report['fit-wt-hwnd'] = fitHwnd;
    report['fit-label'] = FIT_LABEL;
  } finally {
    // Close ALL WT windows opened by this run. fitWtHwnds captures every new CASCADIA hwnd
    // that appeared after the pre-spawn snapshot, including windows whose herdr TUI exited
    // before the title could be matched. Closing by hwnd works regardless of title.
    const hwndsToClose = fitWtHwnds.length > 0 ? fitWtHwnds : (fitHwnd ? [fitHwnd] : []);
    for (const hwnd of hwndsToClose) {
      try { execFileSync(py, ['-3.12', '-c', `import win32gui,win32con;win32gui.PostMessage(${hwnd},win32con.WM_CLOSE,0,0)`], { cwd: '/mnt/c' }); } catch { /* already closed */ }
    }
    await sleep(800);
    if (viewFit) await viewFit.stop().catch(() => undefined);
    if (benchFit) await benchFit.stop();
    if (dataFit) rmSync(dataFit, { recursive: true, force: true });
  }
  // ── end B.9 ─────────────────────────────────────────────────────────────────────────────────

} catch (error) {
  failures.push(`run: ${(error as Error).message}`);
} finally {
  if (browserHwnd) execFileSync(py, ['-3.12', '-c', `import win32gui,win32con;win32gui.PostMessage(${browserHwnd},win32con.WM_CLOSE,0,0)`], { cwd: '/mnt/c' });
  writeFileSync(`${record}.cmd`, 'quit');
  await sleep(1500);
  target.kill();
  await view.stop();
  await bench.stop();
  page.close();
  await sleep(2500);
  // Filter to only processes started by THIS run (using the run's data directories).
  // The owner's live view also runs mirror-session.js and window_helper.py with their own
  // data directory, which is different from `data` and `dataFit`. Filtering by path avoids
  // false failures from the owner's processes.
  const left = execFileSync('ps', ['-eo', 'args'], { encoding: 'utf8' }).split('\n').filter(l =>
    /mirror-session\.js|window_helper\.py/.test(l) &&
    !l.includes('grep') &&
    (l.includes(data) || (dataFit ? l.includes(dataFit) : false))
  );
  check('nothing left running', left.length === 0, left);
  rmSync(data, { recursive: true, force: true });
  rmSync(runDir, { recursive: true, force: true });
  report.failures = failures;
  console.log(JSON.stringify(report, null, 2));
  process.exit(failures.length ? 1 : 0);
}
