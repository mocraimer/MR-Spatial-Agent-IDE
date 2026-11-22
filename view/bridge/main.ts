/** `npm run view`: the bridge on the owner's Herdr. */
import { BRIDGE_PORT, dataDirectory, herdrSocket } from './config.js';
import { linkReport } from './link.js';
import { startView } from './view.js';

const log = (line: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${line}`);
/** The code goes to the owner's terminal only, never into a file or a redirected log. */
const showPairingCode = (code: string) => {
  if (process.stdout.isTTY) console.log(`\n  Pairing code: ${code}   (valid 10 minutes; enter it on the headset)\n`);
  else log('a pairing code is ready; run `npm run view` in a terminal to see it');
};

let view;
try {
  view = await startView({
    herdrSocket: herdrSocket(),
    dataDirectory: dataDirectory(),
    host: '127.0.0.1',
    port: BRIDGE_PORT,
  log,
  showPairingCode,
  });
} catch (error) {
  const code = (error as { code?: string }).code;
  console.error(code === 'EADDRINUSE' ? `The view is already running (port ${BRIDGE_PORT} is in use). Stop the other one first.` : (error as Error).message);
  process.exit(1);
}

log(`view bridge on ${view.url} (Herdr socket ${herdrSocket()})`);
for (const line of linkReport()) log(line);
if (view.pairing.clients().every(c => c.revokedAt !== null)) {
  log('no headset is paired yet');
  showPairingCode(view.pairing.setupCode().code);
}

const running = view;
const stop = () => { log('stopping'); void running.stop().then(() => process.exit(0)); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
