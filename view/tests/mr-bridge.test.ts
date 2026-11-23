/**
 * Fix-3: Restore timing for explicit leave vs page disconnect.
 *   - An explicit leave (/api/mr false) restores the window promptly.
 *   - A page disconnect (SSE close without /api/mr false) uses the 30 s grace period.
 *
 * Fix-4 / AC-1.1 case 3: While any page is in MR, the bridge polls the front pane width every 2 s.
 *   When the pane grows above FRONT_COLS or shrinks below MIN_FIT_COLS the bridge re-fits.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { test } from 'node:test';
import { HerdrBench } from '../bench/bench.js';
import type { LevelAgents } from '../bridge/agents.js';
import { HerdrClient, type JsonObject } from '../bridge/herdr.js';
import { Bridge, type Transcriber } from '../bridge/bridge.js';
import { DEFAULT_MIRROR, Mirror } from '../bridge/mirror.js';
import { Mirrors } from '../bridge/mirrors.js';
import type { Windows, WindowRect, FoundWindow } from '../bridge/windows.js';
import type { BridgeEvent } from '../shared/messages.js';

const noAgents: LevelAgents = {
  seat: async () => { throw new Error('no level agents here'); },
  ready: async () => undefined,
  pending: () => ({ starting: [], failed: [] }),
  onChange: () => undefined,
  describe: id => id,
};
class FakeSpeech implements Transcriber {
  readonly queue: string[] = [];
  state() { return { ready: true as const }; }
  async transcribe(): Promise<string> { return this.queue.shift() ?? ''; }
}

/** Fake Windows that records resize/restore calls and returns a controllable pane width. */
function makeFakeWindows(opts: { initialRect?: WindowRect } = {}) {
  const terminalHwnd = 42;
  let currentRect: WindowRect = opts.initialRect ?? { left: 0, top: 0, right: 1920, bottom: 1200 };
  let isMaximized = false;
  const setCalls: WindowRect[] = [];

  const windows: Windows = {
    list: () => Promise.resolve([]),
    capture: () => Promise.resolve(null),
    stop: () => Promise.resolve(),
    input: () => Promise.resolve(null),
    open: () => Promise.reject(new Error('not implemented')),
    findWindow: (label: string) => {
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
      return Promise.resolve();
    },
    listen: () => undefined,
    close: () => undefined,
  };
  return { windows, setCalls, get currentRect() { return currentRect; } };
}

/**
 * Patches bench.client.call so pane.layout reports `cols` for all pane ids.
 * Returns a function that changes the reported cols at any time.
 */
function patchPaneLayout(benchClient: HerdrClient, initialCols: number): (cols: number) => void {
  let cols = initialCols;
  const orig = benchClient.call.bind(benchClient);
  // Use type cast to override the readonly method for testing.
  (benchClient as unknown as Record<string, unknown>).call = async (method: string, params: JsonObject = {}, timeoutMs?: number) => {
    const result = await orig(method as Parameters<typeof orig>[0], params, timeoutMs);
    if (method === 'pane.layout') {
      const layout = (result as { layout?: { panes?: { pane_id?: unknown; rect?: { width?: number } }[] } }).layout;
      if (layout?.panes) {
        for (const p of layout.panes) {
          if (p.pane_id === params.pane_id && p.rect) p.rect.width = cols;
        }
      }
    }
    return result;
  };
  return (newCols: number) => { cols = newCols; };
}

/** Gets the bridge pageId from the first instance event on a fresh connection. */
async function getPageId(bridge: Bridge): Promise<{ pageId: string; disconnect: () => void }> {
  let pageId: string | null = null;
  let resolve: (v: string) => void;
  const done = new Promise<string>(r => { resolve = r; });
  const disconnect = bridge.connect((event: BridgeEvent) => {
    if (event.type === 'instance' && !pageId) { pageId = event.pageId; resolve(event.pageId); }
  });
  return { pageId: await done, disconnect };
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

// ── Fix-3.a: explicit leave ───────────────────────────────────────────────────────────────────────

test('Fix-3: explicit /api/mr false restores the window promptly (no grace period)', async () => {
  const bench = await HerdrBench.start([{ label: 'alpha', panes: [{ name: 'a1', kind: 'agent' }] }]);
  const dataDir = mkdtempSync('/tmp/svmr-');
  try {
    patchPaneLayout(bench.client, 160);
    const fake = makeFakeWindows();
    const mirrors = new Mirrors(bench.client, fake.windows, bench.socketPath);
    const mirror = new Mirror(bench.client, DEFAULT_MIRROR);
    const speech = new FakeSpeech();
    const bridge = new Bridge(bench.client, mirror, speech, noAgents, {
      mirrors, claudeSettingsPath: null,
    });
    mirror.start();
    await bench.waitFor(async () => mirror.shelf().sessions.length === 1, 'session in mirror');

    const { pageId, disconnect } = await getPageId(bridge);
    try {
      // Enter MR and allow the fit to run.
      bridge.setMixedReality(pageId, true);
      await sleep(1200); // give doFit time to call findWindow + setRect
      const callsBefore = fake.setCalls.length;
      assert.ok(callsBefore >= 1, `fit must have resized the window; setCalls=${callsBefore}`);

      // Explicit leave.
      bridge.setMixedReality(pageId, false);
      await sleep(400); // well within any grace period
      assert.ok(fake.setCalls.length > callsBefore, `restoreWindow called promptly after explicit leave; setCalls=${fake.setCalls.length}`);
    } finally {
      disconnect();
      mirror.stop();
    }
  } finally {
    await bench.stop();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

// ── Fix-3.b: page disconnect ──────────────────────────────────────────────────────────────────────

test('Fix-3: page disconnect uses grace period — window is NOT restored within 500 ms', async () => {
  const bench = await HerdrBench.start([{ label: 'alpha', panes: [{ name: 'a1', kind: 'agent' }] }]);
  const dataDir = mkdtempSync('/tmp/svmr-');
  try {
    patchPaneLayout(bench.client, 160);
    const fake = makeFakeWindows();
    const mirrors = new Mirrors(bench.client, fake.windows, bench.socketPath);
    const mirror = new Mirror(bench.client, DEFAULT_MIRROR);
    const speech = new FakeSpeech();
    const bridge = new Bridge(bench.client, mirror, speech, noAgents, {
      mirrors, claudeSettingsPath: null,
    });
    mirror.start();
    await bench.waitFor(async () => mirror.shelf().sessions.length === 1, 'session in mirror');

    const { pageId, disconnect } = await getPageId(bridge);
    // Enter MR, allow the fit to run.
    bridge.setMixedReality(pageId, true);
    await sleep(1200);
    const callsBefore = fake.setCalls.length;
    assert.ok(callsBefore >= 1, `fit must have resized; setCalls=${callsBefore}`);

    // Disconnect (simulate page crash: no /api/mr false, just SSE close).
    disconnect();
    await sleep(500); // well before the 30 s grace period
    assert.equal(fake.setCalls.length, callsBefore, 'restore NOT called within 500 ms of disconnect (grace period in effect)');

    mirror.stop();
  } finally {
    await bench.stop();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

// ── Fix-4 / AC-1.1 case 3: layout-change poll ────────────────────────────────────────────────────

test('Fix-4: layout-change poll re-fits when the front pane grows above FRONT_COLS while in MR', async () => {
  const bench = await HerdrBench.start([{ label: 'alpha', panes: [{ name: 'a1', kind: 'agent' }] }]);
  const dataDir = mkdtempSync('/tmp/svmr-');
  try {
    // Start at 160 cols so the initial fit resizes the window.
    const setCols = patchPaneLayout(bench.client, 160);
    const fake = makeFakeWindows();
    const mirrors = new Mirrors(bench.client, fake.windows, bench.socketPath);
    const mirror = new Mirror(bench.client, DEFAULT_MIRROR);
    const speech = new FakeSpeech();
    const bridge = new Bridge(bench.client, mirror, speech, noAgents, {
      mirrors, claudeSettingsPath: null,
    });
    mirror.start();
    await bench.waitFor(async () => mirror.shelf().sessions.length === 1, 'session in mirror');

    const { pageId, disconnect } = await getPageId(bridge);
    try {
      // Enter MR and allow the fit to run.
      bridge.setMixedReality(pageId, true);
      await sleep(1200);
      const callsAfterFit = fake.setCalls.length;
      assert.ok(callsAfterFit >= 1, `initial fit must resize; calls=${callsAfterFit}`);

      // Simulate a layout change: the pane grew back to 200 cols (e.g. user widened the WT window).
      setCols(200);

      // Wait for the 2 s poll timer to fire (plus a margin).
      await sleep(2800);
      assert.ok(fake.setCalls.length > callsAfterFit, `re-fit triggered by layout poll after pane grew; calls before=${callsAfterFit}, after=${fake.setCalls.length}`);
    } finally {
      disconnect();
      mirror.stop();
    }
  } finally {
    await bench.stop();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
