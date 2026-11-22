/**
 * The helper's only way to close a session: `node close-tool.js <pane id or name>`.
 * It asks the bridge, which shows the owner the session's name and waits for their yes.
 */
import { createConnection } from 'node:net';
import { join } from 'node:path';
import type { CloseAnswer } from './bridge.js';
import { dataDirectory } from './config.js';

const ref = process.argv.slice(2).join(' ').trim();
// A pane that came back after a Herdr restart may have lost the variable: the bridge's default place still holds.
const socketPath = process.env.SPATIAL_VIEW_HELPER_SOCKET ?? join(dataDirectory(), 'helper.sock');
const say: Record<CloseAnswer, string> = {
  closed: `Closed ${ref}: the owner said yes.`,
  declined: `Not closed: the owner said no to closing ${ref}.`,
  'no-answer': `Not closed: the owner did not answer about ${ref}.`,
  'unknown-session': `Not closed: no open session matches "${ref}". Use its pane id from \`herdr pane list\`.`,
  ambiguous: `Not closed: more than one session matches "${ref}". Use its pane id from \`herdr pane list\`.`,
  busy: 'Not closed: another close is already waiting for the owner. Try again after they answer.',
  failed: `Not closed: Herdr refused to close ${ref}.`,
};

if (!ref || !socketPath) {
  console.error(socketPath ? 'Usage: close-tool <pane id or name>' : 'Not closed: the view bridge is not reachable from here.');
  process.exit(2);
}
const socket = createConnection(socketPath);
let buffer = '';
socket.on('error', () => { console.error('Not closed: the view bridge is not running.'); process.exit(1); });
socket.on('data', chunk => { buffer += chunk.toString('utf8'); });
socket.on('end', () => {
  let answer = 'failed';
  try { answer = String((JSON.parse(buffer) as { answer?: unknown }).answer); } catch { /* keep failed */ }
  console.log(say[answer as CloseAnswer] ?? `Not closed (${answer}).`);
  process.exit(answer === 'closed' ? 0 : 1);
});
socket.write(`${JSON.stringify({ close: ref })}\n`);
