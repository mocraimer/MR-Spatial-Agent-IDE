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
  /** A window mirror: a PC window shown like a session (its pane is labelled "window: …"). */
  window: boolean;
  /** For a full-screen program that is not an agent (a viewer such as lazygit), its screen size; else null. */
  screen: { rows: number; cols: number } | null;
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
  /** Sessions whose input holds spoken words, typed and not yet sent. */
  drafts: string[];
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
  as: 'command' | 'prompt' | 'helper' | 'nothing' | 'ignored';
  /** What happened, in words: "Sent to alpha", "Showing 3", "Nothing is waiting". */
  outcome: string;
  ok: boolean;
}

export interface PendingClose { sessionId: string; name: string }
/** A command heard while listening is off, waiting for the owner's yes: what it will do. */
export interface PendingAsk { label: string }

/** A list the owner picks from on the shelf: the PC's windows, or folders to make a project of. */
export interface PickerItem { n: number; label: string; detail: string }
export interface Picker {
  kind: 'windows' | 'folders';
  title: string;
  /** What the owner said to narrow the list, or "". */
  filter: string;
  items: PickerItem[];
  page: number;
  pages: number;
  /** Said when the list is empty. */
  empty: string | null;
  /** For folders: the name a "Make" would give a new folder, from what was said; else null. */
  make: string | null;
}

export type SpeechState = { ready: true } | { ready: false; reason: string };

export type BridgeEvent =
  | { type: 'shelf'; shelf: Shelf }
  | { type: 'text'; id: string; text: string }
  | { type: 'utterance'; utterance: Utterance }
  | { type: 'notice'; text: string }
  | { type: 'confirm'; pending: PendingClose | null }
  /** A command heard while listening is off, waiting for "yes"; at most one question waits, this or a close. */
  | { type: 'ask'; ask: PendingAsk | null }
  /** Whether direct sending is on: spoken prompts sent as soon as they are heard. */
  | { type: 'direct'; on: boolean }
  | { type: 'speech'; speech: SpeechState }
  /** The voice settings: spoken feedback for commands, and reading each finished reply aloud. */
  | { type: 'voice'; feedback: boolean; reading: boolean; /** The PC's voice failed and has not worked since. */ trouble: boolean; /** True while a fallback voice stands in (e.g. Windows while Kokoro loads). */ standingIn?: boolean }
  /** A phrase to speak: the page fetches its audio from /api/say/<id>. */
  | { type: 'say'; id: string }
  /** The voice was stopped: the page ends the phrase it plays and drops the ones waiting. */
  | { type: 'say-stop' }
  | { type: 'page'; action: string }
  /** The latest picture of a window mirror (base64 image data). */
  | { type: 'frame'; id: string; w: number; h: number; mime: string; data: string }
  /** What a window mirror says in place of its picture, or null when the picture is live. */
  | { type: 'window'; id: string; note: string | null }
  | { type: 'picker'; picker: Picker | null }
  /** Sent on each page connect; id is the bridge instance (changes on restart); pageId is unique per connection. */
  | { type: 'instance'; id: string; pageId: string };

type Raw = Record<string, unknown>;
const isObj = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function parsePicker(v: unknown): Picker | null {
  if (!isObj(v) || (v.kind !== 'windows' && v.kind !== 'folders') || !isStr(v.title) || !isStr(v.filter) || !Array.isArray(v.items)) return null;
  if (!isNum(v.page) || !isNum(v.pages) || !(v.empty === null || isStr(v.empty)) || !(v.make === null || isStr(v.make))) return null;
  const items = v.items.map(i => isObj(i) && isNum(i.n) && isStr(i.label) && isStr(i.detail) ? { n: i.n, label: i.label, detail: i.detail } : null);
  if (items.includes(null)) return null;
  return { kind: v.kind, title: v.title, filter: v.filter, items: items as PickerItem[], page: v.page, pages: v.pages, empty: v.empty, make: v.make };
}

function parseSession(v: unknown): Session | null {
  if (!isObj(v) || !isStr(v.id) || !isStr(v.workspaceId) || !isStr(v.name)) return null;
  if (!(v.agent === null || isStr(v.agent)) || !AGENT_STATUSES.includes(v.status as AgentStatus)) return null;
  if (v.role !== 'task' && v.role !== 'overview-agent' && v.role !== 'project-agent') return null;
  if (typeof v.window !== 'boolean') return null;
  const screen = isObj(v.screen) && isNum(v.screen.rows) && isNum(v.screen.cols) ? { rows: v.screen.rows, cols: v.screen.cols } : null;
  if (v.screen !== null && !screen) return null;
  return { id: v.id, workspaceId: v.workspaceId, role: v.role, agent: v.agent, status: v.status as AgentStatus, name: v.name, window: v.window, screen };
}

function parseShelf(v: unknown): Shelf | null {
  if (!isObj(v) || !Array.isArray(v.projects) || !Array.isArray(v.sessions) || !isObj(v.herdr)) return null;
  const herdr: HerdrLink | null = v.herdr.state === 'up' ? { state: 'up' } : v.herdr.state === 'down' && isStr(v.herdr.reason) ? { state: 'down', reason: v.herdr.reason } : null;
  const projects = v.projects.map(p => isObj(p) && isStr(p.id) && isStr(p.label) ? { id: p.id, label: p.label } : null);
  const sessions = v.sessions.map(parseSession);
  if (!herdr || projects.includes(null) || sessions.includes(null) || !(v.focusedId === null || isStr(v.focusedId))) return null;
  if (!(v.overviewId === null || isStr(v.overviewId)) || !Array.isArray(v.starting) || !v.starting.every(isStr) || !Array.isArray(v.failed)) return null;
  if (!Array.isArray(v.drafts) || !v.drafts.every(isStr)) return null;
  const failed = v.failed.map(f => isObj(f) && isStr(f.id) && isStr(f.reason) ? { id: f.id, reason: f.reason } : null);
  if (failed.includes(null)) return null;
  return { herdr, projects: projects as Project[], sessions: sessions as Session[], focusedId: v.focusedId, overviewId: v.overviewId, starting: v.starting, failed: failed as { id: string; reason: string }[], drafts: v.drafts };
}

export function parseUtterance(v: unknown): Utterance | null {
  if (!isObj(v) || !isStr(v.id) || !isStr(v.heard) || !isStr(v.outcome) || typeof v.ok !== 'boolean') return null;
  if (!['command', 'prompt', 'helper', 'nothing', 'ignored'].includes(v.as as string)) return null;
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
    case 'ask':
      if (v.ask === null) return { type: 'ask', ask: null };
      return isObj(v.ask) && isStr(v.ask.label) ? { type: 'ask', ask: { label: v.ask.label } } : null;
    case 'direct': return typeof v.on === 'boolean' ? { type: 'direct', on: v.on } : null;
    case 'notice': return isStr(v.text) ? { type: 'notice', text: v.text } : null;
    case 'confirm':
      if (v.pending === null) return { type: 'confirm', pending: null };
      return isObj(v.pending) && isStr(v.pending.sessionId) && isStr(v.pending.name) ? { type: 'confirm', pending: { sessionId: v.pending.sessionId, name: v.pending.name } } : null;
    case 'speech':
      if (isObj(v.speech) && v.speech.ready === true) return { type: 'speech', speech: { ready: true } };
      return isObj(v.speech) && v.speech.ready === false && isStr(v.speech.reason) ? { type: 'speech', speech: { ready: false, reason: v.speech.reason } } : null;
    case 'voice': return typeof v.feedback === 'boolean' && typeof v.reading === 'boolean' && typeof v.trouble === 'boolean' ? { type: 'voice', feedback: v.feedback, reading: v.reading, trouble: v.trouble, standingIn: v.standingIn === true } : null;
    case 'say': return isStr(v.id) && /^[A-Za-z0-9-]{1,64}$/.test(v.id) ? { type: 'say', id: v.id } : null;
    case 'say-stop': return { type: 'say-stop' };
    case 'page': return isStr(v.action) ? { type: 'page', action: v.action } : null;
    case 'frame': return isStr(v.id) && isNum(v.w) && isNum(v.h) && isStr(v.mime) && isStr(v.data) ? { type: 'frame', id: v.id, w: v.w, h: v.h, mime: v.mime, data: v.data } : null;
    case 'window': return isStr(v.id) && (v.note === null || isStr(v.note)) ? { type: 'window', id: v.id, note: v.note } : null;
    case 'picker': {
      if (v.picker === null) return { type: 'picker', picker: null };
      const picker = parsePicker(v.picker);
      return picker ? { type: 'picker', picker } : null;
    }
    case 'instance': return isStr(v.id) && isStr(v.pageId) ? { type: 'instance', id: v.id, pageId: v.pageId } : null;
    default: return null;
  }
}
