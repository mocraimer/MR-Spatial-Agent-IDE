/**
 * A Herdr instance of the bench's own: a private HOME under /tmp, so its socket, state and
 * panes are separate from the owner's Herdr. Nothing here reads the caller's HERDR_* variables.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { compiled } from '../bridge/config.js';
import { HerdrClient, type JsonObject } from '../bridge/herdr.js';

export interface BenchPane { name: string; kind: 'agent' | 'shell'; /** The agent the stand-in presents itself as (default `claude`). */ as?: string }
export interface BenchWorkspace { label: string; panes: BenchPane[] }

/** Shaped like a busy desk: six projects, eight agents, plus shells. */
export const OWNER_SHAPE: BenchWorkspace[] = [
  { label: 'billing-reconciliation-service-with-a-very-long-project-name', panes: [{ name: 'ledger', kind: 'agent' }, { name: 'payouts', kind: 'agent' }, { name: 'tests', kind: 'shell' }] },
  { label: 'storefront-web', panes: [{ name: 'editor', kind: 'agent' }] },
  { label: 'agent-coordinator', panes: [{ name: 'review', kind: 'agent' }, { name: 'deploy', kind: 'shell' }] },
  { label: 'spatial-view', panes: [{ name: 'bridge', kind: 'agent' }] },
  { label: 'docs', panes: [{ name: 'guide', kind: 'agent' }] },
  { label: 'infra', panes: [{ name: 'terraform', kind: 'agent' }, { name: 'alerts', kind: 'agent' }] },
];

const STANDIN = compiled('bench', 'standin.js');
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export class HerdrBench {
  /** Pane id by stand-in name. */
  readonly panes = new Map<string, string>();
  /** Workspace id by label. */
  readonly workspaces = new Map<string, string>();

  private server: ChildProcess | null = null;

  private constructor(readonly directory: string, readonly client: HerdrClient, private readonly pathPrefix: string[]) {}

  get socketPath(): string { return this.client.socketPath; }

  /** `path`: directories put before PATH in this Herdr and its panes, e.g. one holding a stand-in `claude`. */
  static async start(layout: BenchWorkspace[] = [], options: { path?: string[] } = {}): Promise<HerdrBench> {
    // Short path: a unix socket path must fit in 108 bytes.
    const directory = mkdtempSync('/tmp/svb-');
    mkdirSync(join(directory, 'home'));
    const bench = new HerdrBench(directory, new HerdrClient(join(directory, 'home', '.config', 'herdr', 'herdr.sock')), options.path ?? []);
    try {
      await bench.startServer();
      for (const workspace of layout) await bench.addWorkspace(workspace);
    } catch (error) { await bench.stop(); throw error; }
    return bench;
  }

  /** Starts (or starts again) this bench's Herdr on the same socket. */
  async startServer(): Promise<void> {
    const env = { HOME: join(this.directory, 'home'), PATH: [...this.pathPrefix, process.env.PATH ?? '/usr/bin:/bin'].join(':'), TERM: 'xterm-256color', SHELL: '/bin/bash', LANG: 'C.UTF-8' };
    const server = spawn('herdr', ['server'], { env, cwd: this.directory, detached: true, stdio: 'ignore' });
    this.server = server;
    const deadline = Date.now() + 15_000;
    for (;;) {
      try { await this.client.ping(); return; } catch (error) {
        if (Date.now() > deadline || server.exitCode !== null) throw error;
        await sleep(100);
      }
    }
  }

  /** Stops this bench's Herdr and everything in its panes, keeping its directory. */
  async stopServer(): Promise<void> {
    try { await this.client.call('server.stop'); } catch { /* already gone */ }
    const server = this.server;
    const deadline = Date.now() + 5000;
    while (server && server.exitCode === null && server.signalCode === null && Date.now() < deadline) await sleep(50);
    if (server?.pid) { try { process.kill(-server.pid, 'SIGKILL'); } catch { /* group already gone */ } }
    for (const pid of benchProcesses(this.directory)) { try { process.kill(pid, 'SIGKILL'); } catch { /* exited */ } }
    this.server = null;
  }

  async addWorkspace(workspace: BenchWorkspace): Promise<string> {
    const created = await this.client.call('workspace.create', { label: workspace.label, cwd: this.directory, focus: false });
    const id = (created.workspace as { workspace_id: string }).workspace_id;
    this.workspaces.set(workspace.label, id);
    let root: string | null = (created.root_pane as { pane_id: string }).pane_id;
    for (const pane of workspace.panes) {
      let paneId: string;
      if (root) { paneId = root; root = null; } else {
        const tab = await this.client.call('tab.create', { workspace_id: id, cwd: this.directory, focus: false });
        paneId = (tab.root_pane as { pane_id: string }).pane_id;
      }
      await this.startPane(paneId, pane);
    }
    return id;
  }

  /** Starts a stand-in (or leaves a shell) in an existing pane and waits until Herdr sees it. */
  async startPane(paneId: string, pane: BenchPane): Promise<void> {
    this.panes.set(pane.name, paneId);
    await this.waitFor(async () => (await this.client.read(paneId, 5)).includes('$'), `${pane.name} shell prompt`);
    // A real shell is named by its terminal title; a bench shell has none, so it gets a label.
    if (pane.kind === 'shell') { await this.client.call('pane.rename', { pane_id: paneId, label: pane.name }); return; }
    await this.client.call('pane.send_text', { pane_id: paneId, text: `exec node ${STANDIN} --name ${pane.name} --bench ${this.directory}${pane.as ? ` --agent ${pane.as}` : ''}\r` });
    await this.waitFor(async () => (await this.client.snapshot()).panes.some(p => p.id === paneId && p.agent !== null), `${pane.name} registered as an agent`);
  }

  async type(name: string, text: string): Promise<void> {
    await this.client.call('pane.send_input', { pane_id: this.pane(name), text, keys: ['enter'] });
  }

  pane(name: string): string {
    const id = this.panes.get(name);
    if (!id) throw new Error(`No bench pane named ${name}`);
    return id;
  }

  async waitFor(check: () => Promise<boolean>, what: string, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try { if (await check()) return; } catch { /* not there yet */ }
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
      await sleep(50);
    }
  }

  /** Stops this bench's Herdr and every process it started, then removes its directory. */
  async stop(): Promise<void> {
    await this.stopServer();
    rmSync(this.directory, { recursive: true, force: true });
  }
}

/**
 * Keeps one connection open to a Herdr and calls `onEvent` with each event.
 * Returns a function that closes it.
 */
export function subscribe(socketPath: string, subscriptions: JsonObject[], onEvent: (name: string, data: JsonObject) => void): () => void {
  const socket = createConnection(socketPath);
  let buffer = '';
  socket.on('error', () => undefined);
  socket.on('data', chunk => {
    buffer += chunk.toString('utf8');
    for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
      const message = JSON.parse(buffer.slice(0, end)) as { event?: string; data?: JsonObject; error?: unknown };
      buffer = buffer.slice(end + 1);
      if (message.error) throw new Error(`Herdr refused the subscription: ${JSON.stringify(message.error)}`);
      if (message.event) onEvent(message.event, message.data ?? {});
    }
  });
  socket.write(`${JSON.stringify({ id: 'bench-subscribe', method: 'events.subscribe', params: { subscriptions } })}\n`);
  return () => socket.destroy();
}

/** Processes running with the bench's private HOME: its server, pane shells and stand-ins. */
export function benchProcesses(directory: string): number[] {
  const marker = `HOME=${join(directory, 'home')}\0`;
  const found: number[] = [];
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue;
    let environment = '';
    try { environment = readFileSync(`/proc/${entry}/environ`, 'latin1'); } catch { continue; }
    if (`\0${environment}`.includes(`\0${marker}`)) found.push(Number(entry));
  }
  return found;
}
