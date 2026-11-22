/** What the bridge and the page say to each other. The page parses every message with these. */

export type AgentStatus = 'idle' | 'working' | 'blocked' | 'done' | 'unknown';
export const AGENT_STATUSES: readonly AgentStatus[] = ['idle', 'working', 'blocked', 'done', 'unknown'];

/** A task session, or a level's own agent: the helper at the overview, a project's agent. */
export type AgentRole = 'overview-agent' | 'project-agent';
export type Role = 'task' | AgentRole;
/** The label of the workspace that is the overview, and of each level agent's pane (its seat). */
export const OVERVIEW_LABEL = 'helper';
export const SEAT_LABEL: Record<AgentRole, string> = { 'overview-agent': 'helper', 'project-agent': 'project agent' };

export interface Session {
  id: string;
  workspaceId: string;
  role: Role;
  /** Null for a shell. */
  agent: string | null;
  status: AgentStatus;
  name: string;
}
export interface Project { id: string; label: string }
export type HerdrLink = { state: 'up' } | { state: 'down'; reason: string };
export interface Shelf {
  herdr: HerdrLink;
  projects: Project[];
  sessions: Session[];
  focusedId: string | null;
  /** The workspace that is the overview, when there is one. */
  overviewId: string | null;
  /** Level agents that are starting, and those whose start failed, by session id. */
  starting: string[];
  failed: { id: string; reason: string }[];
}

/** The project the owner is in: the one holding the session in front. Null at the overview or with nothing in front. */
export function currentProject(shelf: Shelf): string | null {
  const front = shelf.sessions.find(s => s.id === shelf.focusedId);
  return front && front.workspaceId !== shelf.overviewId ? front.workspaceId : null;
}

/** One utterance, as the owner sees it: what was heard, what it was taken as, where it went. */
export interface Utterance {
  id: string;
  heard: string;
  as: 'command' | 'prompt' | 'helper' | 'nothing';
  /** What happened, in words: "Sent to alpha", "Showing 3", "Nothing is waiting". */
  outcome: string;
  ok: boolean;
}

export interface PendingClose { sessionId: string; name: string }

export type SpeechState = { ready: true } | { ready: false; reason: string };

export type BridgeEvent =
  | { type: 'shelf'; shelf: Shelf }
  | { type: 'text'; id: string; text: string }
  | { type: 'utterance'; utterance: Utterance }
  | { type: 'notice'; text: string }
  | { type: 'confirm'; pending: PendingClose | null }
  | { type: 'speech'; speech: SpeechState }
  | { type: 'page'; action: string };

type Raw = Record<string, unknown>;
const isObj = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string';

function parseSession(v: unknown): Session | null {
  if (!isObj(v) || !isStr(v.id) || !isStr(v.workspaceId) || !isStr(v.name)) return null;
  if (!(v.agent === null || isStr(v.agent)) || !AGENT_STATUSES.includes(v.status as AgentStatus)) return null;
  if (v.role !== 'task' && v.role !== 'overview-agent' && v.role !== 'project-agent') return null;
  return { id: v.id, workspaceId: v.workspaceId, role: v.role, agent: v.agent, status: v.status as AgentStatus, name: v.name };
}

function parseShelf(v: unknown): Shelf | null {
  if (!isObj(v) || !Array.isArray(v.projects) || !Array.isArray(v.sessions) || !isObj(v.herdr)) return null;
  const herdr: HerdrLink | null = v.herdr.state === 'up' ? { state: 'up' } : v.herdr.state === 'down' && isStr(v.herdr.reason) ? { state: 'down', reason: v.herdr.reason } : null;
  const projects = v.projects.map(p => isObj(p) && isStr(p.id) && isStr(p.label) ? { id: p.id, label: p.label } : null);
  const sessions = v.sessions.map(parseSession);
  if (!herdr || projects.includes(null) || sessions.includes(null) || !(v.focusedId === null || isStr(v.focusedId))) return null;
  if (!(v.overviewId === null || isStr(v.overviewId)) || !Array.isArray(v.starting) || !v.starting.every(isStr) || !Array.isArray(v.failed)) return null;
  const failed = v.failed.map(f => isObj(f) && isStr(f.id) && isStr(f.reason) ? { id: f.id, reason: f.reason } : null);
  if (failed.includes(null)) return null;
  return { herdr, projects: projects as Project[], sessions: sessions as Session[], focusedId: v.focusedId, overviewId: v.overviewId, starting: v.starting, failed: failed as { id: string; reason: string }[] };
}

export function parseUtterance(v: unknown): Utterance | null {
  if (!isObj(v) || !isStr(v.id) || !isStr(v.heard) || !isStr(v.outcome) || typeof v.ok !== 'boolean') return null;
  if (!['command', 'prompt', 'helper', 'nothing'].includes(v.as as string)) return null;
  return { id: v.id, heard: v.heard, as: v.as as Utterance['as'], outcome: v.outcome, ok: v.ok };
}

/** Null when the message is not one the page understands; the page then ignores it. */
export function parseEvent(text: string): BridgeEvent | null {
  let v: unknown;
  try { v = JSON.parse(text); } catch { return null; }
  if (!isObj(v)) return null;
  switch (v.type) {
    case 'shelf': { const shelf = parseShelf(v.shelf); return shelf ? { type: 'shelf', shelf } : null; }
    case 'text': return isStr(v.id) && isStr(v.text) ? { type: 'text', id: v.id, text: v.text } : null;
    case 'utterance': { const u = parseUtterance(v.utterance); return u ? { type: 'utterance', utterance: u } : null; }
    case 'notice': return isStr(v.text) ? { type: 'notice', text: v.text } : null;
    case 'confirm':
      if (v.pending === null) return { type: 'confirm', pending: null };
      return isObj(v.pending) && isStr(v.pending.sessionId) && isStr(v.pending.name) ? { type: 'confirm', pending: { sessionId: v.pending.sessionId, name: v.pending.name } } : null;
    case 'speech':
      if (isObj(v.speech) && v.speech.ready === true) return { type: 'speech', speech: { ready: true } };
      return isObj(v.speech) && v.speech.ready === false && isStr(v.speech.reason) ? { type: 'speech', speech: { ready: false, reason: v.speech.reason } } : null;
    case 'page': return isStr(v.action) ? { type: 'page', action: v.action } : null;
    default: return null;
  }
}
