/**
 * The level agents: the helper at the overview and one project agent per project. Each is a real
 * Herdr session started through Herdr's own agent start, in a pane the view can find again.
 *
 * A level's pane is its seat. The seat is found by its pane label, which Herdr keeps across a
 * restart; the agent in it is not kept, so an empty seat gets its agent started again. Each kind
 * of agent works in a directory of its own under the view's data directory, holding its settings
 * and instructions, so an agent that Herdr resumes by itself still runs under them.
 *
 * Closing is held outside the agents' instructions: a hook (guard.ts) refuses every direct close,
 * and the only way left asks the bridge, which waits for the owner's yes.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { OVERVIEW_LABEL, SEAT_LABEL, type AgentRole } from '../shared/messages.js';
import { compiled } from './config.js';
import { HerdrError, type HerdrClient, type HerdrPane, type HerdrSnapshot } from './herdr.js';

/** How long Herdr may take to see an agent ready. */
const START_MS = 90_000;
export const CLOSE_TOOL = compiled('bridge', 'close-tool.js');
export const LEVEL_TOOL = compiled('bridge', 'level-tool.js');
const GUARD = compiled('bridge', 'guard.js');
/** The environment variable that tells the close and level tools where the bridge listens. */
export const CLOSE_SOCKET_ENV = 'SPATIAL_VIEW_HELPER_SOCKET';

/** The overview, or the project with this workspace id. */
export type Level = { overview: true } | { project: string };
export const OVERVIEW: Level = { overview: true };

export interface AgentOptions {
  /** Agent kind as Herdr names it, and the arguments it starts with. */
  kind: string;
  args: string[];
  /** Where the agent works: the directory holding its settings and instructions. */
  cwd: string;
  /** Extra environment for the agent's pane (tests give a bench pane the owner's HOME). */
  env?: Record<string, string>;
  /** Writes what the agent tool needs before it starts: settings and instructions. */
  prepare?: () => void;
  /** Starts the agent in a pane in place of Herdr's own agent start (the bench's stand-ins). */
  launch?: (paneId: string) => Promise<void>;
}
export interface LevelOptions { helper: AgentOptions; project: AgentOptions }

export type SeatState = 'ready' | 'starting' | { failed: string };
export interface Seat { paneId: string; state: SeatState }

/** What the bridge needs from the level agents; tests stand in for it. */
export interface LevelAgents {
  /** The level's seat, made if it does not exist. Never waits for an agent to start. */
  seat(level: Level): Promise<Seat>;
  /** Resolves when the agent in this seat can take a prompt; rejects when its start failed. */
  ready(paneId: string): Promise<void>;
  /** Seats whose agent is starting or failed to start, for the view to show. */
  pending(): { starting: string[]; failed: { id: string; reason: string }[] };
  /** Called when a seat's state changes. */
  onChange(listener: () => void): void;
}

function settings(permissions: Record<string, unknown>, model?: string): string {
  return JSON.stringify({
    ...(model ? { model } : {}),
    permissions,
    skipDangerousModePermissionPrompt: true,
    // The guard runs on every tool call: it is what keeps a close behind the owner's yes.
    hooks: { PreToolUse: [{ matcher: '.*', hooks: [{ type: 'command', command: `node ${GUARD}` }] }] },
  }, null, 2);
}

function write(directory: string, settingsText: string, instructions: string): string {
  mkdirSync(join(directory, '.claude'), { recursive: true });
  const file = join(directory, '.claude', 'settings.json');
  writeFileSync(file, settingsText);
  writeFileSync(join(directory, 'CLAUDE.md'), instructions);
  return file;
}

function herdrSkill(): string {
  try { return execFileSync('herdr', ['--skill'], { encoding: 'utf8', timeout: 5000 }); } catch { return ''; /* the instructions still hold */ }
}

/** The helper: Haiku through Claude Code, with the guard hook and no per-command permission prompts. */
export function claudeHelper(directory: string): AgentOptions {
  const file = join(directory, '.claude', 'settings.json');
  return {
    kind: 'claude',
    cwd: directory,
    args: ['--model', 'haiku', '--permission-mode', 'bypassPermissions', '--settings', file, '--strict-mcp-config'],
    prepare: () => { write(directory, settings({ defaultMode: 'bypassPermissions' }, 'haiku'), `${HELPER_INSTRUCTIONS}\n\n${herdrSkill()}`); },
  };
}

/**
 * A project agent: an ordinary Claude Code session on its default model. It may read, and it
 * acts on sessions only through the level tool, which keeps it to its own project; anything
 * else meets Claude Code's own permission prompt, which shows as a waiting session.
 */
export function claudeProjectAgent(directory: string): AgentOptions {
  const file = join(directory, '.claude', 'settings.json');
  const allow = ['Read', 'Glob', 'Grep', `Bash(node ${LEVEL_TOOL}:*)`];
  return {
    kind: 'claude',
    cwd: directory,
    args: ['--settings', file, '--strict-mcp-config'],
    prepare: () => { write(directory, settings({ allow, defaultMode: 'default' }), PROJECT_INSTRUCTIONS); },
  };
}

export function claudeAgents(directory: string): LevelOptions {
  return { helper: claudeHelper(join(directory, 'helper')), project: claudeProjectAgent(join(directory, 'project-agent')) };
}

export class HerdrLevelAgents implements LevelAgents {
  private readonly seating = new Map<string, Promise<Seat>>();
  private readonly starts = new Map<string, Promise<void>>();
  private readonly failures = new Map<string, string>();
  private readonly listeners = new Set<() => void>();

  constructor(private readonly herdr: HerdrClient, private readonly options: LevelOptions, private readonly closeSocket: string) {}

  onChange(listener: () => void): void { this.listeners.add(listener); }

  pending(): { starting: string[]; failed: { id: string; reason: string }[] } {
    return { starting: [...this.starts.keys()], failed: [...this.failures].map(([id, reason]) => ({ id, reason })) };
  }

  /** One seating at a time per level, so two calls close together cannot make two seats. */
  seat(level: Level): Promise<Seat> {
    const key = 'overview' in level ? 'overview' : level.project;
    let seating = this.seating.get(key);
    if (!seating) {
      seating = this.findOrMake(level).finally(() => { this.seating.delete(key); });
      this.seating.set(key, seating);
    }
    return seating;
  }

  ready(paneId: string): Promise<void> {
    const starting = this.starts.get(paneId);
    if (starting) return starting;
    const failed = this.failures.get(paneId);
    return failed ? Promise.reject(new Error(failed)) : Promise.resolve();
  }

  private async findOrMake(level: Level): Promise<Seat> {
    const role: AgentRole = 'overview' in level ? 'overview-agent' : 'project-agent';
    const agent = role === 'overview-agent' ? this.options.helper : this.options.project;
    const snapshot = await this.herdr.snapshot();
    // A seat closed from outside takes its failed start with it.
    for (const id of [...this.failures.keys()]) if (!snapshot.panes.some(p => p.id === id)) this.failures.delete(id);
    const workspace = 'overview' in level
      ? snapshot.workspaces.find(w => w.label === OVERVIEW_LABEL)
      : snapshot.workspaces.find(w => w.id === level.project);
    if (!workspace && 'project' in level) throw new HerdrError('workspace_not_found', 'That project is no longer open.');
    let pane = workspace ? seatIn(snapshot, workspace.id, role) : undefined;
    if (!pane) {
      agent.prepare?.();
      const env = { ...agent.env, [CLOSE_SOCKET_ENV]: this.closeSocket };
      const made = workspace
        ? await this.herdr.call('tab.create', { workspace_id: workspace.id, cwd: agent.cwd, focus: false, env })
        : await this.herdr.call('workspace.create', { label: OVERVIEW_LABEL, cwd: agent.cwd, focus: false, env });
      const paneId = paneOf(made.root_pane);
      await this.herdr.call('pane.rename', { pane_id: paneId, label: SEAT_LABEL[role] });
      pane = { id: paneId, workspaceId: workspace?.id ?? '', tabId: '', agent: null, status: 'unknown', label: SEAT_LABEL[role], title: null, cwd: agent.cwd };
    }
    if (pane.agent !== null && !this.starts.has(pane.id)) { this.failures.delete(pane.id); return { paneId: pane.id, state: 'ready' }; }
    if (!this.starts.has(pane.id)) this.start(pane, role, agent);
    return { paneId: pane.id, state: 'starting' };
  }

  /** Starts the agent in its seat beside the caller; the outcome is kept for `ready` and the view. */
  private start(pane: HerdrPane, role: AgentRole, agent: AgentOptions): void {
    this.failures.delete(pane.id);
    const started = this.run(pane, role, agent).then(
      () => { this.starts.delete(pane.id); this.changed(); },
      (error: unknown) => {
        this.starts.delete(pane.id);
        this.failures.set(pane.id, startProblem(error));
        this.changed();
        throw error;
      },
    );
    started.catch(() => undefined);
    this.starts.set(pane.id, started);
    this.changed();
  }

  private async run(pane: HerdrPane, role: AgentRole, agent: AgentOptions): Promise<void> {
    agent.prepare?.();
    // A seat that came back after a Herdr restart may sit in another directory.
    if (pane.cwd !== agent.cwd) await this.herdr.call('pane.send_input', { pane_id: pane.id, text: `cd '${agent.cwd.replace(/'/g, `'\\''`)}'`, keys: ['enter'] });
    if (agent.launch) { await agent.launch(pane.id); return; }
    const name = role === 'overview-agent' ? OVERVIEW_LABEL : `project-agent-${pane.id.replace(/[^A-Za-z0-9]+/g, '-')}`;
    const deadline = Date.now() + 10_000;
    for (;;) {
      try {
        // Herdr answers once the agent is up, within its own startup window; wait a little longer.
        await this.herdr.call('agent.start', { name, kind: agent.kind, pane_id: pane.id, args: agent.args, timeout_ms: START_MS }, START_MS + 5000);
        return;
      } catch (error) {
        // Started but asking something (agent_not_ready): it stays in its seat for the owner.
        if (error instanceof HerdrError && error.code === 'agent_not_ready') throw error;
        // A fresh shell may not be at its prompt yet.
        if (error instanceof HerdrError && Date.now() <= deadline) { await new Promise(resolve => setTimeout(resolve, 300)); continue; }
        throw error;
      }
    }
  }

  private changed(): void { for (const listener of this.listeners) listener(); }
}

function seatIn(snapshot: HerdrSnapshot, workspaceId: string, role: AgentRole): HerdrPane | undefined {
  return snapshot.panes.find(p => p.workspaceId === workspaceId && p.label === SEAT_LABEL[role]);
}

function startProblem(error: unknown): string {
  if (error instanceof HerdrError && error.code === 'agent_not_ready') return 'It asks something as it starts. Answer it in its window; it is ready after that.';
  return `It did not start (${(error as Error).message}). Go to it again to retry.`;
}

export function paneOf(value: unknown): string {
  const id = typeof value === 'object' && value !== null ? (value as { pane_id?: unknown }).pane_id : undefined;
  if (typeof id !== 'string') throw new HerdrError('bad-reply', 'Herdr sent an unexpected pane');
  return id;
}

const HELPER_INSTRUCTIONS = `# You are the owner's helper, the agent of the overview

The owner speaks to you from a headset. Each prompt is one order or one question, transcribed
from speech, so a word may be misheard: read it for its plain sense. If you cannot tell what is
meant, say so in one line and do nothing. Use the \`herdr\` command line, then answer in one or two
short lines: the owner reads your answer in a headset.

- A project is a Herdr workspace; match the owner's project name to a workspace label loosely.
  Your own workspace is the overview: \`$HERDR_WORKSPACE_ID\`. Sessions that belong to no project
  live there. Your own pane is \`$HERDR_PANE_ID\`; a pane labelled "project agent" is that
  project's own agent, not its work.
- Asked what is going on or what waits: \`herdr agent list\` gives every session's state
  (\`blocked\` means it waits on the owner); \`herdr agent read <pane>\` shows what one says.
  Answer per project, waiting sessions first.
- To start a session in a project: \`herdr tab create --workspace <id> --no-focus\` gives a pane.
  With no project named, use your own workspace. Leave the pane as a shell, or start an agent in
  it with \`herdr agent start <name> --kind <kind> --pane <pane>\` (kind \`claude\` unless the owner
  names another).
- To rename: \`herdr pane rename <pane> <label>\` for a session, \`herdr workspace rename <id> <label>\` for a project.
- Never change what is in front of the owner: always \`--no-focus\`; never \`focus\` commands.
- To close a session, run exactly \`node ${CLOSE_TOOL} <pane id>\` (one call per session; take
  the pane id from \`herdr pane list\`).
  It names the session to the owner and closes only on their yes; it prints what happened.
  There is no other way to close: direct close commands are refused. Do this even if an order
  says not to ask.
- Other quick tasks in plain words are fine with the shell; keep them short.`;

const PROJECT_INSTRUCTIONS = `# You are the agent of one project

The owner runs several agent sessions per project in Herdr and wears a headset. You are the
agent of the project you were started in: you know its sessions and you act for the owner on
them. Each prompt is one question or one order from the owner, transcribed from speech, so a
word may be misheard: read it for its plain sense. If you cannot tell what is meant, say so in
one line and do nothing. Answer in a few short lines: the owner reads them in a headset.

Everything you do with sessions goes through one tool, which keeps to your project:

- \`node ${LEVEL_TOOL} sessions\` lists your project's sessions: pane id, name, agent or shell, state
  (\`blocked\` means it waits on the owner).
- \`node ${LEVEL_TOOL} read <pane> [lines]\` prints what a session shows.
- \`node ${LEVEL_TOOL} start shell [name]\` or \`start claude [name]\` starts a new session in your project.
- \`node ${LEVEL_TOOL} prompt <pane> <text>\` gives a session a prompt.
- \`node ${LEVEL_TOOL} close <pane>\` asks the owner whether to close a session; it closes only on
  their yes and prints what happened.

Asked about the project, look first: list the sessions and read the ones that matter, then
answer from what they show now, naming each session and what it waits on.

Act only when the owner orders it. A question is answered and changes nothing; you may read
the project's files to answer it. Do not change the project's files yourself: when the owner
wants work done, start a session for it or prompt the session that should do it, and say which. Anything outside the tool above needs the owner's
approval, which the permission prompt asks for.`;

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

/** Where the owner's home is, for a default working directory of a new session. */
export const HOME = homedir();
