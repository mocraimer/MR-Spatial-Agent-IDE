/**
 * A window mirror's session: `node mirror-session.js <window handle>`, run in the mirror's Herdr
 * pane. It tells the bridge which PC window this session shows and passes on every key typed
 * into the pane (at the desk, or by the view's key buttons) to that window.
 *
 * It never exits on its own: the session stays until the owner closes it, even when the window
 * or the bridge is gone, and it attaches again when the bridge comes back.
 */
import { connect, type Socket } from 'node:net';
import { join } from 'node:path';
import { dataDirectory } from './config.js';
import { MIRROR_SOCKET_ENV } from './mirrors.js';

const hwnd = Number(process.argv[2]);
const pane = process.env.HERDR_PANE_ID;
const path = process.env[MIRROR_SOCKET_ENV] ?? join(dataDirectory(), 'mirror.sock');
if (!Number.isInteger(hwnd) || hwnd <= 0 || !pane) {
  console.error('Usage, inside a Herdr pane: node mirror-session.js <window handle>');
  process.exit(1);
}

let socket: Socket | null = null;
let said = '';
function say(line: string): void {
  if (line === said) return;
  said = line;
  process.stdout.write(`\r\x1b[2K${line}`);
}

function attach(): void {
  const s = connect(path);
  s.on('connect', () => { socket = s; s.write(`${JSON.stringify({ attach: hwnd, pane })}\n`); });
  s.on('data', chunk => {
    for (const line of chunk.toString('utf8').split('\n').filter(Boolean)) {
      let m: { attached?: unknown; problem?: unknown };
      try { m = JSON.parse(line) as typeof m; } catch { continue; }
      if (m.attached === true) say('This session mirrors a PC window into the headset. Keys typed here go to that window.');
      else if (typeof m.problem === 'string') say(`The window cannot be shown: ${m.problem}`);
    }
  });
  s.on('error', () => undefined);
  s.on('close', () => {
    socket = null;
    say('Waiting for the view on the PC (npm run view)…');
    setTimeout(attach, 1000);
  });
}

if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.on('data', (chunk: Buffer) => { socket?.write(`${JSON.stringify({ keys: chunk.toString('base64') })}\n`); });
// Ctrl-C arrives as a key in raw mode, and an interrupt that still comes ends nothing. When the
// session is closed, its terminal goes away (hang-up, end of input): only then does this end.
process.on('SIGINT', () => undefined);
const end = () => { socket?.destroy(); process.exit(0); };
for (const signal of ['SIGTERM', 'SIGHUP'] as const) process.on(signal, end);
process.stdin.on('end', end);
say('Starting the mirror…');
attach();
