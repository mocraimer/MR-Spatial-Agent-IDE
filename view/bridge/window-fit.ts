/**
 * Fits the Windows terminal window that runs Herdr so the session in front is at most 120 columns
 * wide, and restores it when the owner leaves mixed reality.
 *
 * The fit reads pane.layout for the front pane's column count, derives the target window width in
 * pixels (simple proportional scaling), sets the window, and re-reads up to MAX_CORRECTIONS times
 * to converge. If the window ends up below MIN_FIT_COLS after a correction, the next pass widens
 * it back toward TARGET_COLS. If the minimum window width prevents a fit, it logs once.
 *
 * The original rect is saved on the first fit and restored when the page leaves or after a grace
 * period with no page connected. If the owner resizes the window by hand during the session, the
 * bridge detects the change and keeps that size on restore instead of its own (B.4).
 */
import { readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteText } from './fs-util.js';
import type { HerdrClient } from './herdr.js';
import type { Windows, WindowRect } from './windows.js';
import { FRONT_COLS } from '../shared/front-cols.js';

/** Target front-pane columns: aim for this, accept down to MIN_FIT_COLS. */
const TARGET_COLS = FRONT_COLS;
/** Lower bound: if a correction pass lands below this, widen toward TARGET_COLS. */
const MIN_FIT_COLS = TARGET_COLS - 4; // 116 when TARGET_COLS=120
/** Maximum number of correction passes after the first resize. */
const MAX_CORRECTIONS = 3;
/** How long (ms) to wait for the terminal to reflow after a resize. */
const REFLOW_WAIT_MS = 300;
/** Grace period: after the last page leaves, wait this long before restoring the window. */
export const RESTORE_GRACE_MS = 30_000;

export interface FitOptions {
  /** Logs a line; never called with session text or key strokes. */
  log: (line: string) => void;
  /** Sends a notice to the page. */
  notice: (text: string) => void;
  /** The Herdr client for reading pane layout. */
  herdr: HerdrClient;
  /** The Windows helper for reading and setting the terminal rect. */
  windows: Windows;
}

export interface FitState {
  /** The hwnd of the window currently fitted, or null. */
  hwnd: number | null;
  /** The rect to restore to (after the first fit; updated when the owner resizes by hand). */
  restoreRect: WindowRect | null;
  /** Whether to maximize on restore (the window was maximized before the first fit). */
  restoreMaximized: boolean;
  /** The rect set by the bridge's last fit (to detect hand-resize). */
  lastFitRect: WindowRect | null;
}

export function newFitState(): FitState {
  return { hwnd: null, restoreRect: null, restoreMaximized: false, lastFitRect: null };
}

/**
 * Fits the terminal window so the front pane is at most TARGET_COLS wide.
 * Returns the number of columns the front pane ended up at (after all corrections), or null
 * when no front pane id or no Herdr window could be found.
 *
 * @param paneId The front pane's Herdr pane id.
 * @param workspaceLabel The label of the workspace that hosts the front pane.
 * @param state Mutable state shared across calls; updated in place.
 */
export async function fitWindow(paneId: string, workspaceLabel: string, state: FitState, opts: FitOptions): Promise<number | null> {
  // 1. Read the current layout to get the front pane's column count.
  let frontCols: number;
  try {
    frontCols = await readFrontCols(paneId, opts.herdr);
  } catch (error) {
    opts.log(`window-fit: could not read layout for pane ${paneId}: ${(error as Error).message}`);
    return null;
  }

  if (frontCols <= TARGET_COLS) return frontCols; // Already fits.

  // 2. Find the terminal window.
  let hwnd: number;
  let currentWidth: number;
  let currentHeight: number;
  if (state.hwnd !== null) {
    // We already have the window; check for hand-resize and re-read its rect.
    await checkHandResize(state, opts);
    try {
      const { rect, maximized } = await opts.windows.getRect(state.hwnd);
      if (maximized) {
        // Owner maximized it; restore first so we can resize.
        await opts.windows.setRect(state.hwnd, state.restoreRect ?? rect);
        await sleep(REFLOW_WAIT_MS);
        const after = await opts.windows.getRect(state.hwnd);
        currentWidth = after.rect.right - after.rect.left;
        currentHeight = after.rect.bottom - after.rect.top;
        hwnd = state.hwnd;
      } else {
        currentWidth = rect.right - rect.left;
        currentHeight = rect.bottom - rect.top;
        hwnd = state.hwnd;
      }
    } catch (error) {
      opts.log(`window-fit: could not read window rect: ${(error as Error).message}`);
      return null;
    }
  } else {
    // 3. Find the window for this workspace.
    let found: Awaited<ReturnType<typeof opts.windows.findWindow>>;
    try {
      found = await opts.windows.findWindow(workspaceLabel);
    } catch (error) {
      opts.log(`window-fit: could not find terminal window for workspace "${workspaceLabel}": ${(error as Error).message}`);
      showCutNotice(frontCols, opts);
      return null;
    }
    if (!found) {
      opts.log(`window-fit: no WindowsTerminal window found for workspace "${workspaceLabel}"`);
      showCutNotice(frontCols, opts);
      return null;
    }
    hwnd = found.hwnd;
    if (found.maximized) {
      // Remember that the window was maximized so we can re-maximize on restore (B.3).
      state.restoreRect = found.rect;
      state.restoreMaximized = true;
      await opts.windows.setRect(hwnd, found.rect);
      await sleep(REFLOW_WAIT_MS);
      const after = await opts.windows.getRect(hwnd);
      currentWidth = after.rect.right - after.rect.left;
      currentHeight = after.rect.bottom - after.rect.top;
    } else {
      state.restoreRect = found.rect;
      state.restoreMaximized = false;
      currentWidth = found.rect.right - found.rect.left;
      currentHeight = found.rect.bottom - found.rect.top;
    }
    state.hwnd = hwnd;
    opts.log(`window-fit: found terminal window hwnd=${hwnd} for workspace "${workspaceLabel}" (${currentWidth}×${currentHeight})`);
  }

  // 4. Resize and correct (B.6: also widen when below MIN_FIT_COLS).
  let cols = frontCols;
  for (let pass = 0; pass <= MAX_CORRECTIONS; pass += 1) {
    if (cols <= TARGET_COLS && cols >= MIN_FIT_COLS) break;
    // Scale the window width proportionally to the target column count.
    const targetWidth = Math.round(currentWidth * TARGET_COLS / cols);
    const newRect: WindowRect = {
      left: (state.restoreRect ?? { left: 0 }).left,
      top: (state.restoreRect ?? { top: 0 }).top,
      right: (state.restoreRect ?? { left: 0 }).left + targetWidth,
      bottom: (state.restoreRect ?? { top: 0 }).top + currentHeight,
    };
    try {
      await opts.windows.setRect(hwnd, newRect);
      state.lastFitRect = newRect;
    } catch (error) {
      opts.log(`window-fit: could not resize window: ${(error as Error).message}`);
      return cols;
    }
    if (pass < MAX_CORRECTIONS) {
      await sleep(REFLOW_WAIT_MS);
      try {
        cols = await readFrontCols(paneId, opts.herdr);
        const after = await opts.windows.getRect(hwnd);
        currentWidth = after.rect.right - after.rect.left;
      } catch {
        break; // Can't re-read; use last known value.
      }
    }
  }

  if (cols > TARGET_COLS || cols < MIN_FIT_COLS) {
    opts.log(`window-fit: could not fit front pane to ${TARGET_COLS} cols; ended at ${cols}`);
  } else {
    opts.log(`window-fit: front pane fits at ${cols} cols`);
  }
  return cols;
}

/**
 * Restores the terminal window to the rect it had before the first fit.
 * B.4: If the owner resized the window by hand (rect differs from lastFitRect), leave it as is.
 * B.3: If the window was maximized before the first fit, re-maximize it.
 */
export async function restoreWindow(state: FitState, opts: Pick<FitOptions, 'log' | 'windows'>): Promise<void> {
  if (state.hwnd === null || state.restoreRect === null) return;
  const hwnd = state.hwnd;
  const rect = state.restoreRect;
  const maximized = state.restoreMaximized;
  const lastFit = state.lastFitRect;
  state.hwnd = null;
  state.restoreRect = null;
  state.lastFitRect = null;
  state.restoreMaximized = false;
  // B.4: Check for a hand-resize before restoring. If the current rect differs from the last
  // fitted rect, the owner moved or resized the window; leave it where they put it.
  try {
    const { rect: current } = await opts.windows.getRect(hwnd);
    if (lastFit && !rectEq(current, lastFit)) {
      opts.log(`window-fit: owner resized the window since last fit; skipping restore for hwnd=${hwnd}`);
      return;
    }
  } catch {
    // Could not read rect; proceed with restore anyway.
  }
  try {
    if (maximized) {
      await opts.windows.maximize(hwnd);
      opts.log(`window-fit: restored window hwnd=${hwnd} (maximized)`);
    } else {
      await opts.windows.setRect(hwnd, rect);
      opts.log(`window-fit: restored window hwnd=${hwnd} to ${rect.right - rect.left}×${rect.bottom - rect.top}`);
    }
  } catch (error) {
    opts.log(`window-fit: could not restore window hwnd=${hwnd}: ${(error as Error).message}`);
  }
}

/** Checks whether the owner resized the window by hand and updates the restore target. */
export async function checkHandResize(state: FitState, opts: Pick<FitOptions, 'log' | 'windows'>): Promise<void> {
  if (state.hwnd === null || state.lastFitRect === null) return;
  try {
    const { rect } = await opts.windows.getRect(state.hwnd);
    if (!rectEq(rect, state.lastFitRect)) {
      opts.log(`window-fit: owner resized the window; will restore to new size`);
      state.restoreRect = rect;
      state.lastFitRect = rect;
    }
  } catch { /* ignore transient errors */ }
}

/** Reads the front pane's column count from pane.layout. */
async function readFrontCols(paneId: string, herdr: HerdrClient): Promise<number> {
  const layout = await herdr.call('pane.layout', { pane_id: paneId });
  const panes = (layout.layout as { panes?: { pane_id?: unknown; rect?: { width?: unknown } }[] } | undefined)?.panes ?? [];
  const rect = panes.find(p => p.pane_id === paneId)?.rect;
  if (!rect || typeof rect.width !== 'number') throw new Error('pane.layout did not include the front pane rect');
  return rect.width;
}

function showCutNotice(cols: number, opts: Pick<FitOptions, 'notice'>): void {
  const cut = cols - FRONT_COLS;
  if (cut > 0) opts.notice(`${cut} column${cut === 1 ? '' : 's'} cut: the session in front is wider than the panel.`);
}

function rectEq(a: WindowRect, b: WindowRect): boolean {
  return a.left === b.left && a.top === b.top && a.right === b.right && a.bottom === b.bottom;
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** File name for persisted fit state inside the data directory. */
const FIT_STATE_FILE = 'fit-state.json';

/**
 * Writes the fitted window's original rect to `dir/fit-state.json` so a restarted bridge
 * can restore the window even without having been the one that fitted it.
 * Called after fitWindow successfully sets state.hwnd for the first time.
 */
export function persistFitState(state: FitState, dir: string): void {
  if (!state.hwnd || !state.restoreRect) return;
  const { hwnd, restoreRect, restoreMaximized } = state;
  try {
    atomicWriteText(join(dir, FIT_STATE_FILE), JSON.stringify({ hwnd, restoreRect, restoreMaximized }) + '\n');
  } catch { /* best effort */ }
}

/**
 * Loads persisted fit state from `dir/fit-state.json` into `state`.
 * Called at bridge startup before the first connect(); if no file exists, it is a no-op.
 */
export function loadFitState(state: FitState, dir: string): void {
  try {
    const data = JSON.parse(readFileSync(join(dir, FIT_STATE_FILE), 'utf8')) as unknown;
    if (typeof data !== 'object' || data === null) return;
    const d = data as Record<string, unknown>;
    if (typeof d.hwnd !== 'number' || typeof d.restoreRect !== 'object' || d.restoreRect === null) return;
    const r = d.restoreRect as Record<string, unknown>;
    if (typeof r.left !== 'number' || typeof r.top !== 'number' || typeof r.right !== 'number' || typeof r.bottom !== 'number') return;
    state.hwnd = d.hwnd;
    state.restoreRect = { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    state.restoreMaximized = d.restoreMaximized === true;
  } catch { /* file not present or corrupt — not an error */ }
}

/**
 * Removes the persisted fit state file after the window has been restored.
 */
export function clearFitState(dir: string): void {
  try { unlinkSync(join(dir, FIT_STATE_FILE)); } catch { /* file may not exist */ }
}
