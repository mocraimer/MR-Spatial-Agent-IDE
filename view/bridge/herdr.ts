import { createConnection } from 'node:net';
import { AGENT_STATUSES, type AgentStatus } from '../shared/messages.js';

/** Herdr's socket protocol this view was built against (`herdr api schema --json`). */
export const HERDR_PROTOCOL = 22;


export interface HerdrWorkspace { id: string; label: string }
export interface HerdrPane {
  id: string;
  workspaceId: string;
  tabId: string;
  /** Null for a shell: no agent is recognized in the pane. */
  agent: string | null;
  status: AgentStatus;
  label: string | null;
  title: string | null;
}
export interface HerdrSnapshot { workspaces: HerdrWorkspace[]; panes: HerdrPane[]; focusedPaneId: string | null }

/** Herdr answered with an error object. */
export class HerdrError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'HerdrError'; }
}
/** No Herdr answered on the socket at all. */
export class HerdrUnavailable extends Error {
  constructor(message: string) { super(message); this.name = 'HerdrUnavailable'; }
}

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

export class HerdrClient {
  private sequence = 0;
  constructor(readonly socketPath: string, private readonly timeoutMs = 5000) {}

  /** One request per connection: Herdr closes the socket after its reply. */
  call(method: string, params: JsonObject = {}, timeoutMs = this.timeoutMs): Promise<JsonObject> {
    const id = `view-${++this.sequence}`;
    return new Promise((resolve, reject) => {
      const socket = createConnection(this.socketPath);
      let buffer = '';
      let settled = false;
      const finish = (error: Error | null, value?: JsonObject) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        if (error) reject(error); else resolve(value as JsonObject);
      };
      const timer = setTimeout(() => finish(new HerdrUnavailable(`Herdr did not answer ${method} within ${timeoutMs} ms`)), timeoutMs);
      socket.on('error', error => finish(new HerdrUnavailable(`Herdr is not reachable at ${this.socketPath}: ${error.message}`)));
      socket.on('data', chunk => {
        buffer += chunk.toString('utf8');
        const end = buffer.indexOf('\n');
        if (end < 0) return;
        try { finish(null, parseReply(buffer.slice(0, end), method)); } catch (error) { finish(error as Error); }
      });
      socket.on('end', () => finish(new HerdrUnavailable(`Herdr closed the connection without answering ${method}`)));
      socket.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  async ping(): Promise<number> {
    const result = await this.call('ping');
    return num(result.protocol, 'ping.protocol');
  }

  async snapshot(): Promise<HerdrSnapshot> {
    const result = await this.call('session.snapshot');
    const snap = obj(result.snapshot, 'snapshot');
    const workspaces = arr(snap.workspaces, 'snapshot.workspaces').map(parseWorkspace);
    const agents = new Map(arr(snap.agents ?? [], 'snapshot.agents').map(value => {
      const agent = obj(value, 'agent');
      return [str(agent.pane_id, 'agent.pane_id'), optStr(agent.name)] as const;
    }));
    const panes = arr(snap.panes, 'snapshot.panes').map(value => parsePane(value, agents));
    return { workspaces, panes, focusedPaneId: optStr(snap.focused_pane_id) };
  }

  /** Text of a pane with its ANSI colors, the last `lines` rows of its history. */
  async read(paneId: string, lines: number): Promise<string> {
    const result = await this.call('pane.read', { pane_id: paneId, source: 'recent', format: 'ansi', lines });
    return str(obj(result.read, 'read').text, 'read.text');
  }

}

function parseReply(line: string, method: string): JsonObject {
  const message = obj(JSON.parse(line) as Json, `${method} reply`);
  if (message.error) {
    const error = obj(message.error, 'error');
    throw new HerdrError(str(error.code, 'error.code'), str(error.message, 'error.message'));
  }
  return obj(message.result, `${method} result`);
}

function parseWorkspace(value: Json): HerdrWorkspace {
  const w = obj(value, 'workspace');
  return { id: str(w.workspace_id, 'workspace_id'), label: str(w.label, 'workspace.label') };
}

function parsePane(value: Json, agentNames: Map<string, string | null>): HerdrPane {
  const p = obj(value, 'pane');
  const id = str(p.pane_id, 'pane_id');
  return {
    id,
    workspaceId: str(p.workspace_id, 'pane.workspace_id'),
    tabId: str(p.tab_id, 'pane.tab_id'),
    agent: optStr(p.agent),
    status: parseStatus(p.agent_status),
    label: optStr(p.label) ?? agentNames.get(id) ?? null,
    title: optStr(p.title) ?? optStr(p.terminal_title_stripped),
  };
}

function parseStatus(value: Json | undefined): AgentStatus {
  return AGENT_STATUSES.includes(value as AgentStatus) ? value as AgentStatus : 'unknown';
}

function obj(value: Json | undefined, what: string): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new HerdrError('bad-reply', `Herdr sent an unexpected ${what}`);
  return value;
}
function arr(value: Json | undefined, what: string): Json[] {
  if (!Array.isArray(value)) throw new HerdrError('bad-reply', `Herdr sent an unexpected ${what}`);
  return value;
}
function str(value: Json | undefined, what: string): string {
  if (typeof value !== 'string') throw new HerdrError('bad-reply', `Herdr sent an unexpected ${what}`);
  return value;
}
function num(value: Json | undefined, what: string): number {
  if (typeof value !== 'number') throw new HerdrError('bad-reply', `Herdr sent an unexpected ${what}`);
  return value;
}
function optStr(value: Json | undefined): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}
