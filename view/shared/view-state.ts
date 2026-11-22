import type { HerdrLink, PendingClose, SpeechState, Utterance } from './messages.js';

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
  frontText: string[];
  columns: { projectId: string; project: string; side: 'left' | 'right'; tiles: { n: number; id: string; name: string; light: string; closed: boolean; inFront: boolean }[] }[];
  scroll: number;
  scale: number;
  mic: { mode: 'hold' | 'switch'; open: boolean; problem: string | null };
  speech: SpeechState;
  last: Utterance | null;
  hearing: number;
  notice: string | null;
  confirm: PendingClose | null;
  immersive: boolean;
  surfaces: string[];
}
