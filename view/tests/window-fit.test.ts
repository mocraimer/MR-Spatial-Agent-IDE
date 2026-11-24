/**
 * Deliverable 1: The bridge and Windows helper resize the Windows Terminal window running Herdr
 * so the session in front fits ≤120 columns, then restore on leaving mixed reality.
 *
 * AC-1.1: Entering mixed reality when the front pane is wider than 120 cols calls setRect to
 *   narrow the terminal window.
 * AC-1.2: Leaving mixed reality (setMixedReality(false) + grace period) calls setRect or
 *   maximize to restore the window to its original rect.
 * AC-1.3: When no terminal window is found for the workspace, a notice is shown instead of
 *   crashing.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { atomicWriteText } from '../bridge/fs-util.js';
import { fitWindow, restoreWindow, newFitState, persistFitState, clearFitState } from '../bridge/window-fit.js';
import type { FitOptions, FitState } from '../bridge/window-fit.js';
import type { Windows, WindowRect, FoundWindow } from '../bridge/windows.js';

/** A fake Herdr client that returns a fixed column count for pane.layout. */
function fakeHerdr(cols: number) {
  return {
    async call(method: string, params: Record<string, unknown>) {
      if (method === 'pane.layout') {
        const paneId = params.pane_id as string;
        return { layout: { panes: [{ pane_id: paneId, rect: { width: cols, height: 32 } }] } };
      }
      throw new Error(`Unexpected herdr call: ${method}`);
    },
    async read() { return ''; },
    ping() { return Promise.resolve(); },
    snapshot() { return Promise.resolve({ workspaces: [], panes: [], focusedPaneId: null }); },
  };
}

/** A simple fake Windows helper that records set-rect calls and returns a fake terminal window. */
function fakeWindows(opts: { terminalFound: boolean; initialRect?: WindowRect; maximized?: boolean; initialCols?: number; colsAfterResize?: number; fakeHerdrCols?: { [key: string]: number } }) {
  const terminalHwnd = 999;
  let currentRect: WindowRect = opts.initialRect ?? { left: 0, top: 0, right: 1920, bottom: 1200 };
  let isMaximized = opts.maximized ?? false;
  const setCalls: WindowRect[] = [];
  const maximizeCalls: number[] = [];

  const windows: Windows = {
    list: () => Promise.resolve([]),
    capture: () => Promise.resolve(null),
    stop: () => Promise.resolve(),
    input: () => Promise.resolve(null),
    open: () => Promise.reject(new Error('not implemented')),
    findWindow: (label: string) => {
      if (!opts.terminalFound) return Promise.resolve(null);
      const w: FoundWindow = { hwnd: terminalHwnd, title: `Herdr: ${label}`, app: 'WindowsTerminal.exe', rect: currentRect, maximized: isMaximized };
      return Promise.resolve(w);
    },
    getRect: (hwnd: number) => {
      if (hwnd !== terminalHwnd) return Promise.reject(new Error('no such window'));
      return Promise.resolve({ rect: currentRect, maximized: isMaximized });
    },
    setRect: (hwnd: number, rect: WindowRect) => {
      if (hwnd !== terminalHwnd) return Promise.reject(new Error('no such window'));
      currentRect = { ...rect };
      isMaximized = false;
      setCalls.push({ ...rect });
      return Promise.resolve();
    },
    maximize: (hwnd: number) => {
      if (hwnd !== terminalHwnd) return Promise.reject(new Error('no such window'));
      isMaximized = true;
      maximizeCalls.push(hwnd);
      return Promise.resolve();
    },
    listen: () => undefined,
    close: () => undefined,
  };

  return { windows, setCalls, maximizeCalls, get currentRect() { return currentRect; }, get isMaximized() { return isMaximized; } };
}

test('AC-1.1: fitWindow narrows the terminal window when the front pane is wider than 120 cols', async () => {
  const notices: string[] = [];
  const logs: string[] = [];
  const state: FitState = newFitState();

  // The front pane is 160 cols wide. The window is 1920px wide.
  const fake = fakeWindows({ terminalFound: true, initialRect: { left: 100, top: 100, right: 2020, bottom: 1300 } });
  // Fake Herdr that always reports 160 cols (no reflow simulation).
  const herdrInitial = fakeHerdr(160);

  const opts: FitOptions = {
    log: l => logs.push(l),
    notice: t => notices.push(t),
    herdr: herdrInitial as unknown as FitOptions['herdr'],
    windows: fake.windows,
  };

  const result = await fitWindow('pane-1', 'alpha', state, opts);

  // Should have resized to roughly 1920 * 120 / 160 = 1440px wide.
  assert.ok(result !== null, 'returned a column count');
  assert.ok(fake.setCalls.length >= 1, `setRect should have been called; calls=${JSON.stringify(fake.setCalls)}`);
  const finalWidth = fake.setCalls[fake.setCalls.length - 1]!.right - fake.setCalls[fake.setCalls.length - 1]!.left;
  assert.ok(finalWidth < 1920, `window should be narrower than before; width=${finalWidth}`);
  assert.ok(state.hwnd === 999, 'fitState records the hwnd');
  assert.ok(state.restoreRect !== null, 'fitState records the restore rect');
});

test('AC-1.1: fitWindow does not resize when the front pane is already ≤120 cols', async () => {
  const fake = fakeWindows({ terminalFound: true, initialRect: { left: 0, top: 0, right: 1500, bottom: 900 } });
  const state: FitState = newFitState();
  const opts: FitOptions = {
    log: () => undefined,
    notice: () => undefined,
    herdr: fakeHerdr(100) as unknown as FitOptions['herdr'],
    windows: fake.windows,
  };
  const result = await fitWindow('pane-1', 'alpha', state, opts);
  assert.equal(result, 100, 'returns current cols');
  assert.equal(fake.setCalls.length, 0, 'no resize when pane already fits');
});

test('AC-1.2: restoreWindow restores the terminal to its original rect', async () => {
  const originalRect: WindowRect = { left: 100, top: 100, right: 2020, bottom: 1300 };
  const fake = fakeWindows({ terminalFound: true, initialRect: originalRect });
  const state: FitState = newFitState();
  const fitOpts: FitOptions = {
    log: () => undefined,
    notice: () => undefined,
    herdr: fakeHerdr(160) as unknown as FitOptions['herdr'],
    windows: fake.windows,
  };
  // Fit first.
  await fitWindow('pane-1', 'alpha', state, fitOpts);
  assert.ok(fake.setCalls.length >= 1, 'resized during fit');
  const widthAfterFit = fake.currentRect.right - fake.currentRect.left;
  assert.ok(widthAfterFit < 1920, 'narrowed');

  // Restore.
  await restoreWindow(state, { log: () => undefined, windows: fake.windows });
  const widthAfterRestore = fake.currentRect.right - fake.currentRect.left;
  assert.equal(widthAfterRestore, originalRect.right - originalRect.left, 'restored to original width');
  assert.equal(state.hwnd, null, 'fitState cleared after restore');
});

// ── NL2: persistFitState uses atomicWriteText ──────────────────────────────────────────────────

test('NL2: atomicWriteText writes file contents and leaves no temp files', () => {
  const dir = mkdtempSync('/tmp/wf-nl2-');
  try {
    const path = join(dir, 'out.txt');
    atomicWriteText(path, 'hello atomic\n');
    assert.equal(readFileSync(path, 'utf8'), 'hello atomic\n', 'file has the written content');
    const leftovers = readdirSync(dir).filter(f => f.startsWith('.tmp-'));
    assert.equal(leftovers.length, 0, `no temp files should remain after write; found: ${leftovers.join(', ')}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('NL2: persistFitState + clearFitState round-trip is atomic (no partial reads)', () => {
  const dir = mkdtempSync('/tmp/wf-nl2b-');
  try {
    const state = newFitState();
    state.hwnd = 7;
    state.restoreRect = { left: 0, top: 0, right: 1920, bottom: 1080 };
    persistFitState(state, dir);
    const leftovers = readdirSync(dir).filter(f => f.startsWith('.tmp-'));
    assert.equal(leftovers.length, 0, 'persistFitState leaves no temp files');
    clearFitState(dir);
    const remaining = readdirSync(dir).filter(f => !f.startsWith('.'));
    assert.equal(remaining.length, 0, 'clearFitState removes the state file');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AC-1.3: when no terminal window is found, a notice is shown and no crash', async () => {
  const notices: string[] = [];
  const fake = fakeWindows({ terminalFound: false });
  const state: FitState = newFitState();
  const opts: FitOptions = {
    log: () => undefined,
    notice: t => notices.push(t),
    herdr: fakeHerdr(160) as unknown as FitOptions['herdr'],
    windows: fake.windows,
  };
  const result = await fitWindow('pane-1', 'alpha', state, opts);
  assert.equal(result, null, 'returns null when window not found');
  // A notice about columns cut should be shown.
  const cutNotice = notices.find(n => /cut|wider/.test(n));
  assert.ok(cutNotice !== undefined, `expected a cut notice; got: ${JSON.stringify(notices)}`);
});
