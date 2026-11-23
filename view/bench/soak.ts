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
// Every second and a half the owner "says" a command that fails, so the voice speaks a phrase: the soak covers the voice's queue, clips and playback too.
const transcriber = { state: () => ({ ready: true as const }), transcribe: async () => 'back' };
const quietWav = (() => { const b = Buffer.alloc(44 + 2 * 4410); b.write('RIFF', 0); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(22050, 24); b.writeUInt32LE(44100, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(2 * 4410, 40); return b; })();
const voice = { problem: () => null, speak: async () => quietWav };
const agents = { seat: async () => { throw new Error('no level agents in the soak'); }, ready: async () => undefined, pending: () => ({ starting: [], failed: [] }), onChange: () => undefined, describe: (id: string) => id };
const view = await startView({ herdrSocket: bench.socketPath, dataDirectory: data, host: '127.0.0.1', port: 0, speech: transcriber, agents, voice, log: () => undefined, showPairingCode: () => undefined });
const browser = await chromium.launch();
const page = await (await browser.newContext({ ignoreHTTPSErrors: true })).newPage();
const cdp = await page.context().newCDPSession(page);
await cdp.send('Performance.enable');

let said = 0;
const speaker = setInterval(() => { void view.bridge.utterance(`soak-${++said}`, new Float32Array(1600), null); }, 1500);
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
    console.log(`${String(last.t).padStart(5)} s  bridge heap ${last.bridgeMb.toFixed(1)} MB  page heap ${last.pageMb.toFixed(1)} MB  surfaces ${last.sessions}  phrases made ${said}`);
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
  clearInterval(speaker);
  await browser.close();
  await view.stop();
  await bench.stop();
  rmSync(data, { recursive: true, force: true });
}
