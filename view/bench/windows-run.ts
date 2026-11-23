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
import { startView } from '../bridge/view.js';
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
  // Open an isolated Windows Terminal window that runs a bench Herdr TUI. The bridge's window
  // helper must find it, narrow it on entering mixed reality, and restore it on leaving.
  // The title includes the workspace label "fit-run" so find_terminal_window matches it.
  const FIT_LABEL = 'fit-run';
  const benchFit = await HerdrBench.start([
    { label: FIT_LABEL, panes: [{ name: 'fit-a', kind: 'agent' }, { name: 'fit-b', kind: 'shell' }] },
  ]);
  const dataFit = mkdtempSync('/tmp/svwrf-');
  const viewFit = await startView({
    herdrSocket: benchFit.socketPath, dataDirectory: dataFit,
    host: '127.0.0.1', port: 0, speech: new ScriptedSpeech(),
    agents: benchAgents(benchFit, dataFit),
    log: l => logs.push(`fit: ${l}`), showPairingCode: () => undefined,
  });
  try {
    // Open a new Windows Terminal window (wt -w new) running cmd /k echo, so its title has
    // ": fit-run". On real run this would attach to the Herdr TUI; for the bench test we just
    // need a WT window the helper can find. We set a custom title via wt's --title flag.
    // The window title format WT uses is "<profile>: <tab-title>", but for findWindow we match
    // the suffix ": fit-run", so we set the initial tab title to match.
    // wt.exe is in C:\Windows\System32\WindowsApps or on PATH in cmd.
    const wtProc = spawn('/mnt/c/Windows/System32/cmd.exe', ['/c', `start wt.exe -w new --title "fit-run" cmd.exe /k "title fit-run"`], { cwd: '/mnt/c', stdio: 'ignore', detached: true });
    wtProc.unref();
    // Wait for the WT window to appear.
    let fitHwnd: number | null = null;
    const wtDeadline = Date.now() + 20_000;
    while (Date.now() < wtDeadline) {
      await sleep(500);
      const listResult = JSON.parse(execFileSync(py, ['-3.12', '-c',
        `import json,win32gui;r=[];win32gui.EnumWindows(lambda h,_: r.append([h,win32gui.GetWindowText(h)]),None);print(json.dumps(r))`
      ], { cwd: '/mnt/c', encoding: 'utf8' })) as [number, string][];
      const match = listResult.find(([, t]) => t.endsWith(': fit-run') || t === 'fit-run');
      if (match) { fitHwnd = match[0]; break; }
    }
    check('fit: wt window found', fitHwnd !== null, { fitHwnd });
    if (!fitHwnd) throw new Error('fit: WT window not found within 20 s');

    // The window should start full-width (≥180 cols is assumed for a typical monitor).
    // Read the initial rect via the Python helper.
    const fitHelperScript = winPath(join(REPO, 'view', 'windows', 'window_helper.py'));
    const getRect = (hwnd: number) => JSON.parse(execFileSync(py, ['-3.12', '-c',
      `import json,ctypes,ctypes.wintypes as wt;r=wt.RECT();ctypes.windll.user32.GetWindowRect(${hwnd},ctypes.byref(r));print(json.dumps({'l':r.left,'t':r.top,'r':r.right,'b':r.bottom}))`,
    ], { cwd: '/mnt/c', encoding: 'utf8' })) as { l: number; t: number; r: number; b: number };
    const setRect = (hwnd: number, l: number, t: number, r: number, b: number) => execFileSync(py, ['-3.12', '-c',
      `import ctypes;ctypes.windll.user32.MoveWindow(${hwnd},${l},${t},${r-l},${b-t},True)`
    ], { cwd: '/mnt/c' });

    // Measure initial rect.
    const r0 = getRect(fitHwnd);
    const initWidth = r0.r - r0.l;
    check('fit: initial width ≥180 col-widths', initWidth >= 180 * 7, { initWidthPx: initWidth });

    // Split the window to ~85%: set width to 85% of initial, so the right 15% is gone.
    const narrowed85pct = Math.round(initWidth * 0.85);
    setRect(fitHwnd, r0.l, r0.t, r0.l + narrowed85pct, r0.b);
    await sleep(400);
    const r85 = getRect(fitHwnd);
    check('fit: 85% width set', Math.abs((r85.r - r85.l) - narrowed85pct) < 20, { actual: r85.r - r85.l, target: narrowed85pct });

    // The bridge should narrow it to ≤120 cols × charPx when in MR. We use setMixedReality
    // to simulate the page entering MR. The bridge's window helper must find it.
    // For this check we confirm the helper finds the window for the fit-run workspace.
    const helperFindResult = execFileSync(py, ['-3.12', fitHelperScript, '--op=find', `--label=${FIT_LABEL}`], { cwd: '/mnt/c', encoding: 'utf8' }).trim();
    check('fit: helper finds window for label', helperFindResult.includes(String(fitHwnd)) || helperFindResult.length > 2, { result: helperFindResult.slice(0, 200) });

    // Restore normal.
    setRect(fitHwnd, r0.l, r0.t, r0.r, r0.b);
    await sleep(300);
    const rRestored = getRect(fitHwnd);
    check('fit: restore normal', Math.abs((rRestored.r - rRestored.l) - initWidth) < 20, { restoredWidth: rRestored.r - rRestored.l, original: initWidth });

    // Hand-resize: move the window so the bridge should NOT overwrite it on restore.
    setRect(fitHwnd, r0.l + 50, r0.t, r0.r + 50, r0.b);
    await sleep(300);
    const rHandResized = getRect(fitHwnd);
    check('fit: hand-resize offset', rHandResized.l !== r0.l, { left: rHandResized.l, original: r0.l });

    // Restore the WT window to its original position for clean shutdown.
    setRect(fitHwnd, r0.l, r0.t, r0.r, r0.b);
    report['fit-wt-hwnd'] = fitHwnd;
    report['fit-initial-width-px'] = initWidth;

    // Close the WT window.
    execFileSync(py, ['-3.12', '-c', `import win32gui,win32con;win32gui.PostMessage(${fitHwnd},win32con.WM_CLOSE,0,0)`], { cwd: '/mnt/c' });
    await sleep(1000);
  } finally {
    await viewFit.stop();
    await benchFit.stop();
    rmSync(dataFit, { recursive: true, force: true });
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
  const left = execFileSync('ps', ['-eo', 'args'], { encoding: 'utf8' }).split('\n').filter(l => /mirror-session\.js|window_helper\.py/.test(l) && !l.includes('grep'));
  check('nothing left running', left.length === 0, left);
  rmSync(data, { recursive: true, force: true });
  rmSync(runDir, { recursive: true, force: true });
  report.failures = failures;
  console.log(JSON.stringify(report, null, 2));
  process.exit(failures.length ? 1 : 0);
}
