/** What is said aloud: short phrases from outcomes, and speakable text from a reply. Pure text work. */

/** The longest phrase of feedback, in characters. */
export const FEEDBACK_MAX = 100;
/** The most of a reply that is read aloud, in characters. */
export const REPLY_MAX = 600;

/**
 * Split a phrase into sentences at [.!?]+ followed by whitespace or end-of-string. Splits like
 * "Hello! World?" → ["Hello!", "World?"] but "v4.6." → ["v4.6."] and "file.txt is here." stays
 * whole. The parts always rejoin to the original text (modulo surrounding whitespace).
 */
export function splitSentences(phrase: string): string[] {
  if (!phrase.trim()) return [];
  const parts: string[] = [];
  const re = /[.!?]+(?:\s+|$)/g;
  let start = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(phrase)) !== null) {
    // End of punctuation run (before the whitespace).
    const end = m.index + m[0].trimEnd().length;
    const part = phrase.slice(start, end).trim();
    if (part) parts.push(part);
    start = m.index + m[0].length;
  }
  const tail = phrase.slice(start).trim();
  if (tail) parts.push(tail);
  return parts.length > 0 ? parts : [phrase.trim()];
}

/** Whole sentences from the start that fit `cap`; the first is cut at the cap when it alone is longer. */
function upTo(text: string, cap: number, all: boolean): string {
  const parts = splitSentences(text);
  let out = '';
  for (const part of parts) {
    const next = out ? `${out} ${part}` : part;
    if (next.length > cap) break;
    out = next;
    if (!all) break;
  }
  if (out) return out;
  const first = parts[0] ?? text.trim();
  const cut = first.slice(0, cap);
  return cut.length < first.length ? `${cut.replace(/\s+\S*$/, '').trim() || cut.trim()}…` : cut;
}

/**
 * The phrase for an outcome: its first sentence, within `FEEDBACK_MAX`. A question keeps the
 * sentence after it ("Do X? Say yes or no.") when that fits.
 */
export function feedbackPhrase(outcome: string): string {
  const text = outcome.replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim();
  const first = upTo(text, FEEDBACK_MAX, false);
  if (!first.endsWith('?')) return first;
  const both = upTo(text, FEEDBACK_MAX, true);
  return both.length > first.length ? both : first;
}

/** Why there was nothing to read, said as a phrase. */
export const ONLY_CODE = 'That reply is only code.';

/**
 * The speakable start of a reply: code blocks dropped, markup and links made plain, whole
 * sentences up to `REPLY_MAX`. A reply of only code is said as such; an empty one gives null.
 */
export function replyPhrase(reply: string): string | null {
  const hadCode = /```/.test(reply);
  const plain = reply
    .replace(/```[\s\S]*?(?:```|$)/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/[^\s)]*[^\s).,;:!?]/g, 'a link')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/^\s{0,3}(?:#{1,6}|[-*+>]|\d+[.)])\s+/gm, '')
    .replace(/[*_~|]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!plain) return hadCode ? ONLY_CODE : null;
  return upTo(plain, REPLY_MAX, true);
}

import type { Utterance } from '../shared/messages.js';

/**
 * Which utterances get a spoken answer. A command or an order to the helper always does; a prompt
 * only when it failed; speech taken as nothing or ignored is noise and stays silent. Typed as a
 * record over every kind, so a new kind of utterance cannot be left unclassified.
 */
export const SPOKEN: Record<Utterance['as'], 'always' | 'failures' | 'never'> = {
  command: 'always', helper: 'always', prompt: 'failures', nothing: 'never', ignored: 'never',
};

/** The phrase to speak for an utterance's outcome, or null for silence. */
export function feedbackFor(as: Utterance['as'], ok: boolean, outcome: string): string | null {
  const rule = SPOKEN[as];
  if (rule === 'never' || (rule === 'failures' && ok)) return null;
  return feedbackPhrase(outcome);
}
