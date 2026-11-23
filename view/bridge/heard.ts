/**
 * What an utterance is taken as: a command, a place to go, a session to show, an order to the helper, or a
 * prompt for the receiver. Bridge-side: the page only sends audio.
 */
import { COMMANDS, type Command } from '../shared/actions.js';

/** Lower case, no punctuation, single spaces: "Next waiting." -> "next waiting". */
export function normalize(text: string): string {
  return text.toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty'];
/** What speech recognition writes for a short spoken number. */
const SOUNDS_LIKE: Record<string, number> = { won: 1, to: 2, too: 2, tree: 3, free: 3, for: 4, fore: 4, ate: 8 };

/** "two", "2", "to" -> 2; anything else -> null. */
function spokenNumber(word: string): number | null {
  if (/^\d+$/.test(word)) return Number(word);
  const n = NUMBER_WORDS.indexOf(word);
  return n > 0 ? n : SOUNDS_LIKE[word] ?? null;
}

export type Heard =
  | { as: 'command'; command: Command }
  | { as: 'show'; target: number | string }
  /** "go to <name>": navigation only. With no match, nothing is sent to any session. */
  | { as: 'go'; target: number | string }
  | { as: 'helper'; order: string }
  /** While a list is open: a number picks, "make <name>" makes a new folder, other words narrow it. */
  | { as: 'pick'; n: number }
  | { as: 'make'; name: string }
  | { as: 'filter'; text: string }
  | { as: 'prompt'; text: string }
  | { as: 'nothing' };

/** Leading/trailing spoken fillers that may appear around a command without changing its meaning. */
const FILLERS = /^(?:uh|um|okay|ok|so|please)\s+|\s+(?:uh|um|okay|ok|so|please)$|\s+(?:please)$/g;

/** Strip leading/trailing fillers from a normalized utterance; returns the core. */
function stripFillers(words: string): string {
  let s = words;
  let prev: string;
  do { prev = s; s = s.replace(FILLERS, ''); } while (s !== prev);
  return s.trim();
}

/**
 * What an utterance is taken as. A command must be the whole utterance, so a prompt that
 * merely starts with a command word ("back up the database") still goes to the agent.
 * Leading/trailing fillers ("uh", "um", "okay", "so", "please") are stripped before
 * matching commands so "please enter" and "uh next" still work.
 */
export function classify(text: string, confirming: boolean, picking = false): Heard {
  const words = normalize(text);
  if (!words) return { as: 'nothing' };
  // Strip fillers to try command matching, but keep original `words` for other uses.
  const core = stripFillers(words);
  // "press to", "press two" and "press 2" are one command: numbers are compared as digits.
  const numberize = (s: string) => s.replace(/^(press|option|show|focus|go to|open)(?: number| tile)? (\S+)$/, (whole, verb: string, word: string) => {
    const n = spokenNumber(word);
    return n === null ? whole : `${verb} ${n}`;
  });
  const said = numberize(core);
  const found = COMMANDS.find(c => c.say.includes(said) && (!c.whenConfirming || confirming) && (!c.whenPicking || picking));
  if (found) return { as: 'command', command: found };
  if (picking) {
    const pick = /^(?:pick |number |choose |select |option )?(\S+)$/.exec(said);
    const n = pick?.[1] ? spokenNumber(pick[1]) : null;
    if (n !== null) return { as: 'pick', n };
    const make = /^(?:make|create)(?: a)?(?: new)?(?: folder| project)?(?: called| named)? (.+)$/.exec(said);
    if (make?.[1]) return { as: 'make', name: make[1] };
  }
  const helper = /^(?:hey )?helper (.+)$/.exec(said);
  if (helper?.[1]) return { as: 'helper', order: text.trim().replace(/^(?:hey[\s,]+)?helper[\s,:.!-]*/i, '') };
  const go = /^go to (?:project |number |tile )?(.+)$/.exec(said);
  if (go?.[1]) return { as: 'go', target: /^\d+$/.test(go[1]) ? Number(go[1]) : go[1] };
  const show = /^(?:show|focus|open) (?:number |tile )?(.+)$/.exec(said);
  if (show?.[1]) return { as: 'show', target: /^\d+$/.test(show[1]) ? Number(show[1]) : show[1] };
  // A list is open: words that are no command narrow it, and never reach a session.
  if (picking) return { as: 'filter', text: words };
  return { as: 'prompt', text: text.trim() };
}

