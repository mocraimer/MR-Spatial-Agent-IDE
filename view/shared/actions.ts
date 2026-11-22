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
  /** Sends the draft in front: presses Enter there. */
  | { kind: 'send' }
  /** Clears the draft in front without sending it. */
  | { kind: 'scratch' }
  /** Turns direct sending on or off: spoken prompts sent as soon as they are heard. */
  | { kind: 'direct'; on: boolean }
  /** Answers the one question that waits for the owner: a close, or a command heard while listening is off. */
  | { kind: 'answer'; answer: boolean };

export interface Command {
  id: string;
  /** Button text on the shelf. */
  label: string;
  /** What it does, in words, for the question asked while listening is off; the label when absent. */
  does?: string;
  /** Whole utterances that perform it, lower case without punctuation (see bridge/heard.ts). */
  say: string[];
  run: { page: PageAction } | { bridge: BridgeAction };
  /** Only changes how the view is shown, so it runs at once even while listening is off. */
  viewOnly?: true;
  /** Only offered while a question waits for the owner's answer. */
  whenConfirming?: true;
}

const key = (id: string, label: string, k: KeyName, say: string[]): Command => ({ id, label, does: `Press ${label}`, say, run: { bridge: { kind: 'key', key: k } } });

export const COMMANDS: readonly Command[] = [
  { id: 'next', label: 'Next waiting', does: 'Bring the next waiting session forward', say: ['next waiting', 'next', 'whats waiting'], run: { bridge: { kind: 'next-waiting' } } },
  { id: 'back', label: 'Back', does: 'Go back to the session you came from', say: ['back', 'go back'], run: { bridge: { kind: 'back' } } },
  key('enter', 'Enter', 'enter', ['press enter', 'enter']),
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
  { id: 'send', label: 'Go', does: 'Send the draft', say: ['go', 'submit', 'send it'], run: { bridge: { kind: 'send' } } },
  { id: 'scratch', label: 'Scratch that', does: 'Clear the draft', say: ['scratch that', 'clear that'], run: { bridge: { kind: 'scratch' } } },
  { id: 'direct-on', label: 'Send at once', does: 'Send each prompt as soon as it is heard', say: ['send at once'], run: { bridge: { kind: 'direct', on: true } } },
  { id: 'direct-off', label: 'Wait for go', does: 'Wait for “go” before sending', say: ['wait for go', 'way for go'], run: { bridge: { kind: 'direct', on: false } } },
  { id: 'scroll-up', label: 'Scroll up', say: ['scroll up', 'page up'], run: { page: 'scroll-up' }, viewOnly: true },
  { id: 'scroll-down', label: 'Scroll down', say: ['scroll down', 'page down'], run: { page: 'scroll-down' }, viewOnly: true },
  { id: 'bottom', label: 'Latest', say: ['scroll bottom', 'bottom', 'go bottom', 'scroll to bottom', 'latest'], run: { page: 'scroll-bottom' }, viewOnly: true },
  { id: 'recenter', label: 'Recenter', say: ['recenter', 're center', 'center'], run: { page: 'recenter' }, viewOnly: true },
  { id: 'listening-off', label: 'Mic off', does: 'Stop listening', say: ['stop listening', 'mic off', 'microphone off'], run: { page: 'listening-off' } },
  { id: 'mode-hold', label: 'Hold to talk', say: ['hold to talk'], run: { page: 'mode-hold' } },
  { id: 'mode-switch', label: 'Keep listening', say: ['keep listening', 'start listening', 'listening switch'], run: { page: 'mode-switch' } },
  { id: 'bigger', label: 'A+', say: ['bigger text', 'larger text'], run: { page: 'text-bigger' }, viewOnly: true },
  { id: 'smaller', label: 'A−', say: ['smaller text'], run: { page: 'text-smaller' }, viewOnly: true },
  { id: 'exit', label: 'Exit MR', does: 'Leave mixed reality', say: ['leave mixed reality', 'exit mixed reality', 'exit'], run: { page: 'exit-mr' } },
  { id: 'overview', label: 'Overview', does: 'Go to the overview', say: ['overview', 'show overview', 'go to overview', 'go to the overview', 'all projects', 'show helper', 'helper'], run: { bridge: { kind: 'overview' } } },
  { id: 'confirm', label: 'Yes', say: ['yes', 'confirm', 'yes close it', 'close it'], run: { bridge: { kind: 'answer', answer: true } }, whenConfirming: true },
  { id: 'decline', label: 'No', say: ['no', 'cancel', 'dont close', 'keep it'], run: { bridge: { kind: 'answer', answer: false } }, whenConfirming: true },
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
