/**
 * Every action the view performs, with its button label and its spoken forms. Page and bridge
 * both read this one list, so a button and its words cannot drift apart.
 */

export type KeyName = 'enter' | 'escape' | 'ctrl+c' | 'up' | 'down' | 'tab' | 'y' | 'n' | '1' | '2' | '3';

/** Done by the page itself: how the view is shown. */
export type PageAction = 'scroll-up' | 'scroll-down' | 'scroll-bottom' | 'recenter' | 'listening-off' | 'mode-hold' | 'mode-switch' | 'text-bigger' | 'text-smaller' | 'exit-mr';

/** Done by the bridge: everything that reaches Herdr. */
export type BridgeAction =
  | { kind: 'focus'; sessionId: string }
  /** Go into a project: its agent comes to the front, started the first time. */
  | { kind: 'go'; projectId: string }
  /** Go to the overview: the helper comes to the front. */
  | { kind: 'overview' }
  | { kind: 'next-waiting' }
  | { kind: 'back' }
  | { kind: 'key'; key: KeyName }
  | { kind: 'confirm-close'; answer: boolean };

export interface Command {
  id: string;
  /** Button text on the shelf. */
  label: string;
  /** Whole utterances that perform it, lower case without punctuation (see bridge/heard.ts). */
  say: string[];
  run: { page: PageAction } | { bridge: BridgeAction };
  /** Only offered while a close waits for the owner's answer. */
  whenConfirming?: true;
}

const key = (id: string, label: string, k: KeyName, say: string[]): Command => ({ id, label, say, run: { bridge: { kind: 'key', key: k } } });

export const COMMANDS: readonly Command[] = [
  { id: 'next', label: 'Next waiting', say: ['next waiting', 'next', 'whats waiting'], run: { bridge: { kind: 'next-waiting' } } },
  { id: 'back', label: 'Back', say: ['back', 'go back'], run: { bridge: { kind: 'back' } } },
  key('enter', 'Enter', 'enter', ['press enter', 'enter', 'submit']),
  key('escape', 'Esc', 'escape', ['press escape', 'escape']),
  key('interrupt', 'Ctrl-C', 'ctrl+c', ['interrupt', 'press control c', 'control c']),
  key('up', '↑', 'up', ['press up', 'arrow up']),
  key('down', '↓', 'down', ['press down', 'arrow down']),
  key('tab', 'Tab', 'tab', ['press tab']),
  key('y', 'y', 'y', ['press yes', 'press y']),
  key('n', 'n', 'n', ['press no', 'press n']),
  key('one', '1', '1', ['press one', 'press 1', 'option one', 'option 1']),
  key('two', '2', '2', ['press two', 'press 2', 'option two', 'option 2']),
  key('three', '3', '3', ['press three', 'press 3', 'option three', 'option 3']),
  { id: 'scroll-up', label: 'Scroll up', say: ['scroll up', 'page up'], run: { page: 'scroll-up' } },
  { id: 'scroll-down', label: 'Scroll down', say: ['scroll down', 'page down'], run: { page: 'scroll-down' } },
  { id: 'bottom', label: 'Latest', say: ['scroll bottom', 'bottom', 'go bottom', 'scroll to bottom', 'latest'], run: { page: 'scroll-bottom' } },
  { id: 'recenter', label: 'Recenter', say: ['recenter', 're center', 'center'], run: { page: 'recenter' } },
  { id: 'listening-off', label: 'Mic off', say: ['stop listening', 'mic off', 'microphone off'], run: { page: 'listening-off' } },
  { id: 'mode-hold', label: 'Hold to talk', say: ['hold to talk'], run: { page: 'mode-hold' } },
  { id: 'mode-switch', label: 'Keep listening', say: ['keep listening', 'listening switch'], run: { page: 'mode-switch' } },
  { id: 'bigger', label: 'A+', say: ['bigger text', 'larger text'], run: { page: 'text-bigger' } },
  { id: 'smaller', label: 'A−', say: ['smaller text'], run: { page: 'text-smaller' } },
  { id: 'exit', label: 'Exit MR', say: ['leave mixed reality', 'exit mixed reality', 'exit'], run: { page: 'exit-mr' } },
  { id: 'overview', label: 'Overview', say: ['overview', 'show overview', 'go to overview', 'go to the overview', 'all projects', 'show helper', 'helper'], run: { bridge: { kind: 'overview' } } },
  { id: 'confirm', label: 'Yes, close', say: ['yes', 'confirm', 'yes close it', 'close it'], run: { bridge: { kind: 'confirm-close', answer: true } }, whenConfirming: true },
  { id: 'decline', label: 'No', say: ['no', 'cancel', 'dont close', 'keep it'], run: { bridge: { kind: 'confirm-close', answer: false } }, whenConfirming: true },
];

export function command(id: string): Command {
  const found = COMMANDS.find(c => c.id === id);
  if (!found) throw new Error(`No command ${id}`);
  return found;
}

export interface Ordered { id: string; workspaceId: string }
/**
 * Shelf order: by project in Herdr's order, then Herdr's pane order. Tile numbers are positions
 * in this order counted from 1, the same on page and bridge, and they do not move with focus.
 */
export function shelfOrder<S extends Ordered>(projects: { id: string }[], sessions: S[]): S[] {
  const rank = new Map(projects.map((p, i) => [p.id, i]));
  return sessions
    .map((s, i) => ({ s, i }))
    .sort((a, b) => ((rank.get(a.s.workspaceId) ?? 1e9) - (rank.get(b.s.workspaceId) ?? 1e9)) || a.i - b.i)
    .map(x => x.s);
}
