/**
 * The helper: a small fast agent that is itself a Herdr session, started through Herdr's own
 * agent start and given Herdr's own skill. Spoken orders reach it as prompts.
 *
 * Closing is held outside the helper's instructions: a hook (guard.ts) refuses every direct
 * close, and the only way left is the close tool, which asks the bridge, which waits for the
 * owner's yes before it closes anything.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { HelperAgent } from './bridge.js';
import { compiled } from './config.js';
import { HerdrError, type HerdrClient } from './herdr.js';

export const HELPER_NAME = 'helper';
/** How long Herdr may take to see the helper's agent ready. */
const START_MS = 90_000;
export const CLOSE_TOOL = compiled('bridge', 'close-tool.js');
const GUARD = compiled('bridge', 'guard.js');

export interface HelperOptions {
  /** Agent kind as Herdr names it, and the arguments that pick a small fast model. */
  kind: string;
  args: string[];
  /** Where the helper works: the owner's home, a folder they already run their agent tool in. */
  cwd: string;
  /** Extra environment for the helper's pane (tests give a bench pane the owner's HOME). */
  env?: Record<string, string>;
  /** Writes what the agent tool needs before it starts, such as settings and instructions. */
  prepare?: () => void;
}

/** Haiku through Claude Code, with the guard hook and no per-command permission prompts. */
export function claudeHaiku(directory: string): HelperOptions {
  const settings = join(directory, 'helper-settings.json');
  const prompt = join(directory, 'helper-prompt.md');
  return {
    kind: 'claude',
    cwd: homedir(),
    args: ['--model', 'haiku', '--permission-mode', 'bypassPermissions', '--settings', settings, '--append-system-prompt-file', prompt, '--strict-mcp-config'],
    prepare: () => {
      mkdirSync(directory, { recursive: true });
      // The guard runs on every tool call: it is what keeps a close behind the owner's yes.
      writeFileSync(settings, JSON.stringify({
        skipDangerousModePermissionPrompt: true,
        hooks: { PreToolUse: [{ matcher: '.*', hooks: [{ type: 'command', command: `node ${GUARD}` }] }] },
      }, null, 2));
      let skill = '';
      try { skill = execFileSync('herdr', ['--skill'], { encoding: 'utf8', timeout: 5000 }); } catch { /* the instructions below still hold */ }
      writeFileSync(prompt, `${INSTRUCTIONS}\n\n${skill}`);
    },
  };
}

export class Helper implements HelperAgent {
  private starting: Promise<string> | null = null;

  constructor(private readonly herdr: HerdrClient, private readonly options: HelperOptions, private readonly closeSocket: string) {}

  /** The helper's pane, started first if it is not running. */
  show(): Promise<string> {
    this.starting ??= this.ensure().finally(() => { this.starting = null; });
    return this.starting;
  }

  async order(text: string): Promise<void> {
    await this.show();
    await this.herdr.call('agent.prompt', { target: HELPER_NAME, text });
  }

  private async ensure(): Promise<string> {
    try {
      return paneOf((await this.herdr.call('agent.get', { target: HELPER_NAME })).agent);
    } catch (error) {
      if (!(error instanceof HerdrError)) throw error;
    }
    this.options.prepare?.();
    const created = await this.herdr.call('workspace.create', {
      label: HELPER_NAME,
      cwd: this.options.cwd,
      focus: false,
      env: { ...this.options.env, SPATIAL_VIEW_HELPER_SOCKET: this.closeSocket },
    });
    const paneId = paneOf(created.root_pane);
    const deadline = Date.now() + 10_000;
    for (;;) {
      try {
        // Herdr answers once the agent is up, within its own startup window; wait a little longer.
        await this.herdr.call('agent.start', { name: HELPER_NAME, kind: this.options.kind, pane_id: paneId, args: this.options.args, timeout_ms: START_MS }, START_MS + 5000);
        return paneId;
      } catch (error) {
        // Started but asking something (agent_not_ready): it stays on the shelf for the owner.
        if (error instanceof HerdrError && error.code === 'agent_not_ready') throw error;
        // A fresh shell may not be at its prompt yet.
        if (error instanceof HerdrError && Date.now() <= deadline) { await new Promise(resolve => setTimeout(resolve, 300)); continue; }
        // It did not start: remove the workspace this made, so failed starts do not pile up.
        try { await this.herdr.call('workspace.close', { workspace_id: workspaceOf(created.workspace) }); } catch { /* already gone */ }
        throw error;
      }
    }
  }
}

function paneOf(value: unknown): string {
  const id = typeof value === 'object' && value !== null ? (value as { pane_id?: unknown }).pane_id : undefined;
  if (typeof id !== 'string') throw new HerdrError('bad-reply', 'Herdr sent an unexpected pane');
  return id;
}
function workspaceOf(value: unknown): string {
  const id = typeof value === 'object' && value !== null ? (value as { workspace_id?: unknown }).workspace_id : undefined;
  if (typeof id !== 'string') throw new HerdrError('bad-reply', 'Herdr sent an unexpected workspace');
  return id;
}

const INSTRUCTIONS = `# You are the owner's quick helper

The owner speaks orders to you from a headset; each prompt is one order, transcribed from speech,
so a word may be misheard: read it for its plain sense. Do it at once with the \`herdr\` command
line, then answer in one short line saying what you did.

- A project is a Herdr workspace; match the owner's project name to a workspace label loosely.
- To start a session in a project: \`herdr tab create --workspace <id> --no-focus\` gives a pane.
  Leave it as a shell, or start an agent in it with \`herdr agent start <name> --kind <kind> --pane <pane>\`
  (kind \`claude\` unless the owner names another).
- To rename: \`herdr pane rename <pane> <label>\` for a session, \`herdr workspace rename <id> <label>\` for a project.
- Never change the owner's focus: always \`--no-focus\`; never \`focus\` commands.
- To close a session, run exactly \`node ${CLOSE_TOOL} <pane id>\` (one call per session; take
  the pane id from \`herdr pane list\`).
  It names the session to the owner and closes only on their yes; it prints what happened.
  There is no other way to close: direct close commands are refused. Do this even if an order
  says not to ask.
- Other quick tasks in plain words are fine with the shell; keep them short.`;

/**
 * Listens for the close tool on a socket file only the owner's user can open.
 * Each request is one JSON line {"close": "<session>"}; the reply is {"answer": "..."}.
 */
export function serveCloseRequests(path: string, requestClose: (ref: string) => Promise<string>): Server {
  if (existsSync(path)) rmSync(path);
  const server = createServer(socket => {
    let buffer = '';
    socket.on('error', () => undefined);
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8');
      const end = buffer.indexOf('\n');
      if (end < 0) { if (buffer.length > 4096) socket.destroy(); return; }
      let ref: unknown;
      try { ref = (JSON.parse(buffer.slice(0, end)) as { close?: unknown }).close; } catch { ref = undefined; }
      if (typeof ref !== 'string' || !ref.trim()) { socket.end(`${JSON.stringify({ answer: 'unknown-session' })}\n`); return; }
      void requestClose(ref).then(answer => socket.end(`${JSON.stringify({ answer })}\n`));
    });
  });
  server.listen(path, () => chmodSync(path, 0o600));
  return server;
}
