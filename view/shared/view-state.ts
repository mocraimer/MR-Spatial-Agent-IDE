import type { HerdrLink, PendingClose, Role, SpeechState, Utterance } from './messages.js';

/** What the page reports through `window.viewState()`: for tests, and for an agent driving it. */
export interface ViewState {
  link: 'connecting' | 'live' | 'lost' | 'unpaired';
  /** Why the windows are not current and what to do, or null. */
  stale: string | null;
  herdr: HerdrLink | null;
  front: string | null;
  /** What the front panel says when no session is in front. */
  emptyHint: string | null;
  receiver: string | null;
  /** The rows the front panel draws, as plain text. */
  frontText: string[];
  /** Where the owner is: the overview, or inside one project. */
  place: { overview: true } | { overview: false; projectId: string; project: string };
  /** Why the level agent in front cannot take words yet, or null. */
  agentNote: string | null;
  /** The other projects as chips (inside a project) or nodes (at the overview); angle in degrees from straight ahead. */
  chips: { projectId: string; project: string; overview: boolean; sessions: { id: string; light: string }[]; angle: number; width: number }[];
  /** The sessions on the shelf: the current project's, or at the overview those of no project. */
  columns: { projectId: string; project: string; side: 'left' | 'right'; width: number; tiles: { n: number; id: string; name: string; role: Role; light: string; closed: boolean; inFront: boolean; /** The rows the tile draws, as plain text. */ text: string[] }[] }[];
  scroll: number;
  scale: number;
  mic: { mode: 'hold' | 'switch'; open: boolean; problem: string | null };
  speech: SpeechState;
  last: Utterance | null;
  hearing: number;
  notice: string | null;
  confirm: PendingClose | null;
  /** Sessions that hold a draft, by id. */
  drafts: string[];
  /** Direct sending is on. */
  direct: boolean;
  immersive: boolean;
  surfaces: string[];
}
