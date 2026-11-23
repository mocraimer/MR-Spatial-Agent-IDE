/**
 * The helper's way to show a page or a PC window in a project:
 *
 *   node mirror-tool.js <workspace id> <web address | window name>
 *
 * A web address opens in a new browser window on the PC; either way the window is mirrored into
 * that project as a new session, without changing what is in front of the owner.
 */
import { asOrder, sendOrder } from './mirror-order.js';

const [workspace, ...rest] = process.argv.slice(2);
const target = rest.join(' ').trim();
if (!workspace || !target) { console.error('Usage: node mirror-tool.js <workspace id> <web address | window name>'); process.exit(1); }
const r = await sendOrder(asOrder(target, workspace));
(r.ok ? console.log : console.error)(r.answer);
process.exit(r.ok ? 0 : 1);
