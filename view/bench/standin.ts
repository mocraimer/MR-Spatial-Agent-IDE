/**
 * A scripted stand-in agent for the bench. It runs in a pane of the bench's own Herdr,
 * reports its state to that Herdr (the socket Herdr injected into the pane), and answers
 * each line typed into it:
 *
 *   /status <idle|working|blocked|unknown>  report that state
 *   /steady <count> <ms> [tag]      print numbered lines, one every <ms>
 *   /burst <count> [tag]            print numbered lines at once
 *                                   (a tag marks this run's lines apart from earlier runs')
 *   /block                          ask a question and stay blocked until the next line
 *   /exit                           exit
 *   anything else                   answer like an agent: working, a reply, idle
 */
import { createInterface } from 'node:readline';
import { HerdrClient } from '../bridge/herdr.js';

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length - 1; i += 2) args.set(process.argv[i] ?? '', process.argv[i + 1] ?? '');
const name = args.get('--name') ?? 'standin';
const agent = args.get('--agent') ?? 'claude';
const paneId = process.env.HERDR_PANE_ID;
const socket = process.env.HERDR_SOCKET_PATH;
if (!paneId || !socket) { console.error('standin must run inside a Herdr pane'); process.exit(2); }
// Herdr checks that a reported agent is the pane's foreground process by name.
process.title = agent;
const herdr = new HerdrClient(socket);
let seq = 0;

async function report(state: 'idle' | 'working' | 'blocked' | 'unknown'): Promise<void> {
  await herdr.call('pane.report_agent', { pane_id: paneId as string, source: 'standin', agent, state, seq: ++seq });
}

const C = { dim: '\x1b[2m', bold: '\x1b[1m', green: '\x1b[32m', cyan: '\x1b[36m', yellow: '\x1b[33m', red: '\x1b[31m', magenta: '\x1b[38;5;177m', reset: '\x1b[0m' };
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function reply(prompt: string): string[] {
  return [
    `${C.bold}${C.cyan}● ${name}${C.reset} ${C.dim}received:${C.reset} ${prompt}`,
    `${C.green}✓${C.reset} Read ${C.bold}src/services/very-long-project-name-for-the-billing-reconciliation-service/ledger.ts${C.reset} ${C.dim}(412 lines)${C.reset}`,
    `${C.yellow}⚠${C.reset} The reconciliation job compares each settled invoice against the provider's payout report, and when the two disagree by more than the configured tolerance it opens a review item instead of correcting the ledger silently, which is why the nightly run reported 3 items.`,
    `${C.magenta}  diff --git a/ledger.ts b/ledger.ts${C.reset}`,
    `${C.red}  - if (delta > tolerance) correct(entry)${C.reset}`,
    `${C.green}  + if (delta > tolerance) openReview(entry, delta)${C.reset}`,
    `${C.bold}${name}${C.reset}: done. ${C.dim}Tell me if you want the review items listed.${C.reset}`,
  ];
}

async function handle(line: string): Promise<void> {
  const [command, a, b, c] = line.trim().split(/\s+/);
  if (command === '/exit') process.exit(0);
  if (command === '/status' && (a === 'idle' || a === 'working' || a === 'blocked' || a === 'unknown')) { await report(a); return; }
  if (command === '/steady' || command === '/burst') {
    const count = Number(a ?? 0);
    const every = command === '/steady' ? Number(b ?? 10) : 0;
    const tag = (command === '/steady' ? c : b) ?? '';
    const mark = tag ? `${name} ${tag}` : name;
    await report('working');
    const lines: string[] = [];
    for (let i = 1; i <= count; i += 1) {
      const text = `${mark} L${String(i).padStart(5, '0')} ${C.dim}payload ${'x'.repeat(i % 37)}${C.reset}`;
      if (every > 0) { process.stdout.write(`${text}\n`); await sleep(every); } else lines.push(text);
    }
    if (lines.length) process.stdout.write(`${lines.join('\n')}\n`);
    process.stdout.write(`${mark} END ${count}\n`);
    await report('idle');
    return;
  }
  if (command === '/block') {
    process.stdout.write(`${C.yellow}?${C.reset} ${name} wants to edit ${C.bold}ledger.ts${C.reset}. Allow? (y/n) `);
    await report('blocked');
    blocked = true;
    return;
  }
  if (blocked) { blocked = false; process.stdout.write(`${name} answer: ${line.trim()}\n`); await report('idle'); return; }
  await report('working');
  for (const text of reply(line.trim())) { process.stdout.write(`${text}\n`); await sleep(40); }
  await report('idle');
}

let blocked = false;
let queue = Promise.resolve();
// Agents set the terminal title; Herdr reports it and the view names the session by it.
process.stdout.write(`\x1b]0;${name}\x07`);
process.stdout.write(`${C.bold}${C.cyan}${name}${C.reset} ${C.dim}(stand-in ${agent})${C.reset} ready\n`);
await report('idle');
createInterface({ input: process.stdin }).on('line', line => { queue = queue.then(() => handle(line)).catch(error => console.error(error)); });
