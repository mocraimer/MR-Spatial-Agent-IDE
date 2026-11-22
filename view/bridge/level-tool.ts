/**
 * A project agent's one way to act on sessions: `node level-tool.js <command>`. It runs in the
 * agent's pane, takes the project from the pane's own workspace, and refuses anything outside
 * that project. It never changes what is in front of the owner.
 *
 *   sessions                    this project's sessions
 *   read <pane> [lines]         what a session shows
 *   start <shell|kind> [name]   a new session in this project
 *   prompt <pane> <text>        give a session a prompt
 *   close <pane>                ask the owner whether to close a session
 */
import { execFileSync } from 'node:child_process';
import { createConnection } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { SEAT_LABEL } from '../shared/messages.js';
import { plain } from '../shared/ansi.js';
import { agentName } from './agent-name.js';
import { paneOf } from './agents.js';
import { compiled, dataDirectory } from './config.js';
import { HerdrClient, type HerdrPane } from './herdr.js';

const [command, ...rest] = process.argv.slice(2);
const workspaceId = process.env.HERDR_WORKSPACE_ID;
const self = process.env.HERDR_PANE_ID;
const socket = process.env.HERDR_SOCKET_PATH;
function fail(message: string): never { console.error(message); process.exit(1); }
if (!workspaceId || !self || !socket) fail('This tool runs only inside a Herdr pane.');
const herdr = new HerdrClient(socket);
/** Puts a line in the view's log through the bridge, so the owner can read later what failed here. Best effort. */
function report(line: string): Promise<void> {
  const path = process.env.SPATIAL_VIEW_HELPER_SOCKET ?? join(dataDirectory(), 'helper.sock');
  return new Promise(resolve => {
    const connection = createConnection(path);
    const done = () => { connection.destroy(); resolve(); };
    connection.setTimeout(2000, done);
    connection.on('error', done);
    connection.on('close', done);
    connection.write(`${JSON.stringify({ log: line })}\n`);
  });
}
async function failWith(line: string, message = line): Promise<never> {
  await report(line);
  return fail(message);
}

async function mine(): Promise<HerdrPane[]> {
  return (await herdr.snapshot()).panes.filter(p => p.workspaceId === workspaceId);
}
async function own(ref: string | undefined): Promise<HerdrPane> {
  const panes = await mine();
  const found = panes.filter(p => p.id === ref || (ref !== undefined && (p.label ?? p.title ?? '').toLowerCase() === ref.toLowerCase()));
  if (found.length !== 1 || !found[0]) fail(`No one session of this project matches "${ref ?? ''}". Its sessions: ${panes.map(p => p.id).join(', ')}. A session of another project needs the owner: tell them.`);
  return found[0];
}

switch (command) {
  case 'sessions': {
    for (const p of await mine()) {
      const what = p.label === SEAT_LABEL['project-agent'] ? 'you, the project agent' : p.agent ? `agent ${p.agent}, ${p.status}` : 'shell';
      console.log(`${p.id}\t${p.label ?? p.title ?? '(no name)'}\t${what}`);
    }
    break;
  }
  case 'read': {
    const pane = await own(rest[0]);
    const lines = Math.min(400, Math.max(1, Number(rest[1]) || 60));
    console.log(plain(await herdr.read(pane.id, lines)));
    break;
  }
  case 'start': {
    const kind = rest[0];
    if (!kind) fail('Usage: start <shell|agent kind> [name]');
    const name = rest.slice(1).join(' ').trim();
    // A new session works where the project's sessions work, not in the agent's own directory.
    const cwd = (await mine()).find(p => p.id !== self && p.cwd)?.cwd ?? homedir();
    const made = await herdr.call('tab.create', { workspace_id: workspaceId, cwd, focus: false });
    const paneId = paneOf(made.root_pane);
    if (name) await herdr.call('pane.rename', { pane_id: paneId, label: name });
    if (kind !== 'shell') {
      const deadline = Date.now() + 10_000;
      for (;;) {
        try { await herdr.call('agent.start', { kind, pane_id: paneId, name: agentName(name || kind, paneId), timeout_ms: 90_000 }, 95_000); break; } catch (error) {
          if (Date.now() > deadline || (error as { code?: string }).code === 'agent_not_ready') await failWith(`a project agent in ${workspaceId} made session ${paneId}, but its ${kind} agent did not start: ${(error as Error).message}`, `Session ${paneId} was made, but its agent did not start: ${(error as Error).message}`);
          await new Promise(resolve => setTimeout(resolve, 300));
        }
      }
    }
    console.log(`Started ${kind === 'shell' ? 'a shell' : `a ${kind} agent`} as session ${paneId}${name ? ` named ${name}` : ''}.`);
    break;
  }
  case 'prompt': {
    const pane = await own(rest[0]);
    const text = rest.slice(1).join(' ').trim();
    if (!text) fail('Usage: prompt <pane> <text>');
    if (pane.id === self) fail('That is your own session.');
    // Ending a shell closes its session, which needs the owner's yes: use close instead.
    if (!pane.agent && /^\s*(exit|logout)\b/i.test(text)) fail(`That would close ${pane.id}. To close a session, use: close ${pane.id}`);
    if (pane.agent) await herdr.call('agent.prompt', { target: pane.id, text });
    else await herdr.call('pane.send_input', { pane_id: pane.id, text, keys: ['enter'] });
    console.log(`Sent to ${pane.id}.`);
    break;
  }
  case 'close': {
    const pane = await own(rest[0]);
    const env = { ...process.env, SPATIAL_VIEW_HELPER_SOCKET: process.env.SPATIAL_VIEW_HELPER_SOCKET ?? join(dataDirectory(), 'helper.sock') };
    try { process.stdout.write(execFileSync('node', [compiled('bridge', 'close-tool.js'), pane.id], { encoding: 'utf8', env })); } catch (error) {
      const out = (error as { stdout?: string; stderr?: string });
      fail((out.stdout ?? '') + (out.stderr ?? '') || 'Not closed.');
    }
    break;
  }
  default: fail('Commands: sessions | read <pane> [lines] | start <shell|kind> [name] | prompt <pane> <text> | close <pane>');
}
