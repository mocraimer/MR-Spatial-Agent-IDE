/**
 * Every action the view performs, with its button label and its spoken forms. Page and bridge
 * both read this one list, so a button and its words cannot drift apart.
 */

export type KeyName = 'enter' | 'escape' | 'ctrl+c' | 'up' | 'down' | 'left' | 'right' | 'tab' | 'backspace' | 'y' | 'n' | '1' | '2' | '3';

/** Done by the page itself: how the view is shown. */
export type PageAction = 'scroll-up' | 'scroll-down' | 'scroll-bottom' | 'recenter' | 'listening-off' | 'mode-hold' | 'mode-switch' | 'text-bigger' | 'text-smaller' | 'exit-mr' | 'keyboard';

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
  | { kind: 'answer'; answer: boolean }
  /** Types `/model <name>` into the session in front (a Claude Code session that is idle). */
  | { kind: 'model'; name: ModelName }
  /** Types `/effort <level>` into the session in front. */
  | { kind: 'effort'; level: EffortLevel }
  /** Spoken feedback for commands on or off. */
  | { kind: 'voice'; on: boolean }
  /** Reading each finished reply of the session in front aloud, on or off. */
  | { kind: 'read-replies'; on: boolean }
  /** Reads the last reply of the session in front aloud, once. */
  | { kind: 'read-last' }
  /** Ends the phrase that is being spoken and drops those waiting behind it. */
  | { kind: 'voice-stop' }
  /** Open a list to pick from: the PC's windows to mirror here, or folders to make a project of. */
  | { kind: 'picker'; list: 'windows' | 'folders' }
  | { kind: 'picker-cancel' }
  | { kind: 'picker-page'; delta: 1 | -1 }
  /** Make a new project folder named by what was said into the folder list. */
  | { kind: 'picker-make' }
  | { kind: 'pick'; n: number }
  /** Turn keeping utterance audio and text on or off. */
  | { kind: 'keep-speech'; on: boolean }
  /** Delete all kept utterances. */
  | { kind: 'delete-speech' }
  /** Clicks and scrolls for the PC window a mirror session shows. */
  | { kind: 'window-input'; sessionId: string; events: WindowInput[] }
  /** Types text directly into the session in front (from the headset keyboard or physical keys). */
  | { kind: 'type-text'; text: string };

/** A click or scroll on a mirrored window, at a point given as fractions of its width and height. */
export type WindowInput = { type: 'click'; x: number; y: number } | { type: 'wheel'; x: number; y: number; delta: number };

/** The models and effort levels the owner can set by voice: Claude Code's own names. */
export const MODELS = ['haiku', 'sonnet', 'opus'] as const;
export type ModelName = (typeof MODELS)[number];
/** Spoken name, then the level Claude Code takes. */
export const EFFORTS = [['low', 'low'], ['medium', 'medium'], ['high', 'high'], ['extra high', 'xhigh'], ['max', 'max']] as const;
export type EffortLevel = (typeof EFFORTS)[number][1];

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
  /** Only offered while a list to pick from is open. */
  whenPicking?: true;
}

const cap = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);
const model = (name: ModelName): Command => ({ id: `model-${name}`, label: `Model ${cap(name)}`, does: `Set the model to ${name}`, say: [`model ${name}`, `set model ${name}`, `set model to ${name}`, `model to ${name}`], run: { bridge: { kind: 'model', name } } });
const effort = (spoken: string, level: EffortLevel): Command => ({ id: `effort-${level}`, label: `Effort ${spoken}`, does: `Set the effort to ${spoken}`, say: [`effort ${spoken}`, `set effort ${spoken}`, `set effort to ${spoken}`, `effort to ${spoken}`], run: { bridge: { kind: 'effort', level } } });
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
  ...MODELS.map(model),
  ...EFFORTS.map(([spoken, level]) => effort(spoken, level)),
  // These change only what the owner hears: nothing reaches a session, so they run at once in standby.
  { id: 'voice-on', label: 'Voice on', does: 'Speak answers', say: ['voice on', 'speak answers'], run: { bridge: { kind: 'voice', on: true } }, viewOnly: true },
  { id: 'voice-off', label: 'Voice off', does: 'Stop speaking answers', say: ['voice off', 'mute voice'], run: { bridge: { kind: 'voice', on: false } }, viewOnly: true },
  { id: 'read-on', label: 'Read replies', does: 'Read each finished reply aloud', say: ['read replies', 'read my replies'], run: { bridge: { kind: 'read-replies', on: true } }, viewOnly: true },
  { id: 'read-off', label: 'Stop reading', does: 'Stop reading replies aloud', say: ['stop reading replies', 'dont read replies'], run: { bridge: { kind: 'read-replies', on: false } }, viewOnly: true },
  { id: 'read-last', label: 'Read that', does: 'Read the last reply aloud', say: ['read that', 'read that again', 'read the reply'], run: { bridge: { kind: 'read-last' } }, viewOnly: true },
  { id: 'voice-stop', label: 'Quiet', does: 'Stop the voice', say: ['stop talking', 'be quiet', 'quiet'], run: { bridge: { kind: 'voice-stop' } }, viewOnly: true },
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
  // Opening, paging and closing a list only change what is shown; making something asks first while listening is off.
  { id: 'mirror', label: 'Mirror', does: 'Show the PC\'s windows to mirror one here', say: ['mirror', 'mirror a window', 'show windows', 'show pc windows', 'pc windows'], run: { bridge: { kind: 'picker', list: 'windows' } }, viewOnly: true },
  { id: 'new-project', label: 'New project', does: 'Show folders to make a project of', say: ['new project', 'add project', 'add a project', 'make a project'], run: { bridge: { kind: 'picker', list: 'folders' } }, viewOnly: true },
  { id: 'cancel', label: 'Cancel', say: ['cancel', 'close list', 'close the list', 'never mind'], run: { bridge: { kind: 'picker-cancel' } }, whenPicking: true, viewOnly: true },
  { id: 'more', label: 'More', say: ['more', 'next page', 'show more'], run: { bridge: { kind: 'picker-page', delta: 1 } }, whenPicking: true, viewOnly: true },
  { id: 'previous', label: 'Previous', say: ['previous', 'previous page'], run: { bridge: { kind: 'picker-page', delta: -1 } }, whenPicking: true, viewOnly: true },
  { id: 'make', label: 'Make it', does: 'Make a new project folder with the name said', say: ['make it', 'make new', 'make a new folder', 'make that'], run: { bridge: { kind: 'picker-make' } }, whenPicking: true },
  { id: 'keyboard', label: 'Keyboard', does: 'Bring up the headset keyboard to type', say: ['keyboard', 'show keyboard', 'open keyboard', 'type'], run: { page: 'keyboard' }, viewOnly: true },
  // Keep speech: viewOnly because nothing reaches a session. Off by default; persisted.
  { id: 'keep-speech-on', label: 'Keep my speech', does: 'Keep each utterance as audio and text in the data folder', say: ['keep my speech', 'save my speech', 'record my speech'], run: { bridge: { kind: 'keep-speech', on: true } }, viewOnly: true },
  { id: 'keep-speech-off', label: 'Stop keeping speech', does: 'Stop keeping utterances', say: ['stop keeping my speech', 'dont keep my speech', 'stop saving my speech'], run: { bridge: { kind: 'keep-speech', on: false } }, viewOnly: true },
  { id: 'delete-speech', label: 'Delete my speech', does: 'Delete all kept utterances', say: ['delete my speech', 'delete my recordings', 'clear my speech'], run: { bridge: { kind: 'delete-speech' } } },
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
