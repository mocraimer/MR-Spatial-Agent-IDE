/**
 * The helper's PreToolUse hook. It refuses any tool call that would close a Herdr session
 * other than through the close tool, so the owner's yes cannot be skipped by an order or a
 * model that ignores its instructions. Exit code 2 blocks the call and tells the helper why.
 */
import { readFileSync } from 'node:fs';

const CLOSING = [
  /\b(pane|tab|workspace)\s+close\b/i,
  /\b(pane|tab|workspace)\.close\b/i,
  /\bserver\s+stop\b|\bserver\.stop\b/i,
  /\bsession\s+(stop|delete)\b/i,
  /herdr\.sock/i,
  /\bclose_group\b/i,
];
const SHELL_ONLY = [
  /\b(kill|pkill|killall)\b/i,
  /\b(send-text|send-keys|send-input|pane\s+run)\b.*\b(exit|logout|ctrl\+d)\b/i,
];

let call: { tool_name?: unknown; tool_input?: unknown };
try {
  const value: unknown = JSON.parse(readFileSync(0, 'utf8'));
  if (typeof value !== 'object' || value === null) throw new Error('not an object');
  call = value as typeof call;
} catch {
  // What cannot be read cannot be shown safe: refuse rather than let a close through.
  process.stderr.write('Refused: the guard could not read this tool call.\n');
  process.exit(2);
}
const input = JSON.stringify(call.tool_input ?? '');
const patterns = call.tool_name === 'Bash' ? [...CLOSING, ...SHELL_ONLY] : CLOSING;
if (patterns.some(p => p.test(input))) {
  process.stderr.write('Refused: closing a session needs the owner\'s yes. Run the close tool named in your instructions with the session\'s pane id or name; it asks the owner.\n');
  process.exit(2);
}
process.exit(0);
