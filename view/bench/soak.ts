/**
 * `node build/view/bench/soak.js [minutes]`: the view under sustained output for a while, with
 * the bridge's and the page's memory sampled throughout. Four stand-ins print without pause,
 * sessions open and close every half minute, and the front session changes. Prints a table and
 * a verdict: level means the last third of the run grew less than 10% over the middle third.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { chromium } from '@playwright/test';
import { startView } from '../bridge/view.js';
import { HerdrBench, OWNER_SHAPE } from './bench.js';

const minutes = Number(process.argv[2] ?? 10);
const bench = await HerdrBench.start(OWNER_SHAPE);
const data = mkdtempSync('/tmp/svs-');
const transcriber = { state: () => ({ ready: true as const }), transcribe: async () => '' };
const agents = { seat: async () => { throw new Error('no level agents in the soak'); }, ready: async () => undefined, pending: () => ({ starting: [], failed: [] }), onChange: () => undefined };
const view = await startView({ herdrSocket: bench.socketPath, dataDirectory: data, host: '127.0.0.1', port: 0, speech: transcriber, agents, log: () => undefined, showPairingCode: () => undefined });
const browser = await chromium.launch();
const page = await (await browser.newContext({ ignoreHTTPSErrors: true })).newPage();
const cdp = await page.context().newCDPSession(page);
await cdp.send('Performance.enable');

try {
  await page.goto(view.url);
  await page.locator('#code').fill(view.pairing.setupCode().code);
  await page.getByRole('button', { name: 'Pair this headset' }).click();
  await page.waitForFunction(() => (window.viewState() as { link: string }).link === 'live');
  for (const name of ['ledger', 'payouts', 'terraform', 'alerts']) await bench.type(name, '/steady 100000000 4');

  const rows: { t: number; bridgeMb: number; pageMb: number; sessions: number }[] = [];
  const start = Date.now();
  let churn = 0;
  const fronts = ['ledger', 'terraform', 'payouts', 'guide'];
  while (Date.now() - start < minutes * 60_000) {
    await new Promise(resolve => setTimeout(resolve, 15_000));
    const t = Math.round((Date.now() - start) / 1000);
    if (t % 30 < 15) {
      churn += 1;
      const extra = await bench.addWorkspace({ label: `churn-${churn}`, panes: [{ name: `churn${churn}`, kind: 'agent' }] });
      await bench.type(`churn${churn}`, '/burst 400');
      await new Promise(resolve => setTimeout(resolve, 2000));
      await bench.client.call('workspace.close', { workspace_id: extra });
    }
    await bench.client.call('pane.focus', { pane_id: bench.pane(fronts[churn % fronts.length] as string) });
    global.gc?.();
    await cdp.send('HeapProfiler.collectGarbage');
    const metrics = (await cdp.send('Performance.getMetrics')).metrics;
    const pageHeap = metrics.find(m => m.name === 'JSHeapUsedSize')?.value ?? 0;
    const sessions = (await page.evaluate(() => (window.viewState() as { surfaces: string[] }).surfaces.length));
    rows.push({ t, bridgeMb: process.memoryUsage().heapUsed / 2 ** 20, pageMb: pageHeap / 2 ** 20, sessions });
    const last = rows[rows.length - 1] as typeof rows[number];
    console.log(`${String(last.t).padStart(5)} s  bridge heap ${last.bridgeMb.toFixed(1)} MB  page heap ${last.pageMb.toFixed(1)} MB  surfaces ${last.sessions}`);
  }
  const third = Math.floor(rows.length / 3);
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
  for (const key of ['bridgeMb', 'pageMb'] as const) {
    const middle = mean(rows.slice(third, 2 * third).map(r => r[key]));
    const end = mean(rows.slice(2 * third).map(r => r[key]));
    console.log(`${key}: middle third ${middle.toFixed(1)} MB, last third ${end.toFixed(1)} MB -> ${end <= middle * 1.1 ? 'level' : 'CLIMBING'}`);
  }
  console.log(`opened and closed ${churn} sessions; four stand-ins printed throughout`);
} finally {
  await browser.close();
  await view.stop();
  await bench.stop();
  rmSync(data, { recursive: true, force: true });
}
