/**
 * `node build/view/bench/demo.js`: the view on a bench Herdr shaped like the owner's (six
 * projects, eight agents, two shells), never on the owner's own Herdr. Prints the address and a
 * pairing code; Ctrl-C stops the bridge and the bench.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { dataDirectory } from '../bridge/config.js';
import { LocalSpeech, modelDirectory } from '../bridge/speech.js';
import { startView } from '../bridge/view.js';
import { HerdrBench, OWNER_SHAPE } from './bench.js';


const port = Number(process.env.VIEW_PORT ?? 47860);
const bench = await HerdrBench.start(OWNER_SHAPE);
const data = mkdtempSync('/tmp/svd-');
const speech = new LocalSpeech(modelDirectory(dataDirectory()));
await speech.load();
const view = await startView({
  herdrSocket: bench.socketPath,
  dataDirectory: data,
  host: '127.0.0.1',
  port,
  speech,
  log: line => console.log(line),
  showPairingCode: code => { if (process.stdout.isTTY) console.log(`pairing code: ${code}`); },
});
await bench.type('ledger', 'explain the reconciliation change');
await bench.type('review', '/block');
await bench.type('alerts', '/status working');
console.log(`demo view on ${view.url} (bench Herdr ${bench.socketPath})`);
// The code goes to a terminal only, never into a redirected log.
if (process.stdout.isTTY) console.log(`pairing code: ${view.pairing.setupCode().code}`);
const stop = async () => { await view.stop(); await bench.stop(); rmSync(data, { recursive: true, force: true }); process.exit(0); };
process.on('SIGINT', () => { void stop(); });
process.on('SIGTERM', () => { void stop(); });
