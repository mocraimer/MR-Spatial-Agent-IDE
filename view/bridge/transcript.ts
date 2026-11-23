/**
 * The last reply of a Claude Code session, read from the transcript Claude Code keeps for it at
 * `<root>/<project folder>/<session id>.jsonl`. Only the end of the file is read, so a long
 * session costs no more than a short one.
 */
import { closeSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Where Claude Code keeps its transcripts. */
export const TRANSCRIPT_ROOT = join(homedir(), '.claude', 'projects');
/** How much of the end of a transcript is read: a turn's last reply sits well within it. */
export const TAIL_BYTES = 256 * 1024;

export type LastReply = { text: string } | { problem: 'no-transcript' | 'no-reply' | 'unreadable' };

/** The transcript of a session id, searched one folder deep; a session id is a UUID, never a path. */
function find(root: string, sessionId: string): string | null {
  if (!/^[A-Za-z0-9-]{8,64}$/.test(sessionId)) return null;
  let folders: string[];
  try { folders = readdirSync(root); } catch { return null; }
  for (const folder of folders) {
    const file = join(root, folder, `${sessionId}.jsonl`);
    try { if (statSync(file).isFile()) return file; } catch { /* not in this folder */ }
  }
  return null;
}

function tail(file: string): string {
  const fd = openSync(file, 'r');
  try {
    const size = statSync(file).size;
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    const text = buffer.toString('utf8');
    // A read that starts mid-file starts mid-line: that first piece is not a whole record.
    return size > length ? text.slice(text.indexOf('\n') + 1) : text;
  } finally { closeSync(fd); }
}

/** The text of the last assistant message that has any, or why there is none. Never throws. */
export function lastReply(sessionId: string, root: string = TRANSCRIPT_ROOT): LastReply {
  const file = find(root, sessionId);
  if (!file) return { problem: 'no-transcript' };
  let lines: string[];
  try { lines = tail(file).split('\n'); } catch { return { problem: 'unreadable' }; }
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i] as string;
    if (!line.includes('"assistant"')) continue;
    let record: unknown;
    try { record = JSON.parse(line); } catch { continue; }
    const { type, message } = (record ?? {}) as { type?: unknown; message?: { content?: unknown } };
    if (type !== 'assistant' || !Array.isArray(message?.content)) continue;
    const text = (message.content as { type?: unknown; text?: unknown }[])
      .filter(block => block?.type === 'text' && typeof block.text === 'string')
      .map(block => block.text as string).join('\n').trim();
    if (text) return { text };
  }
  return { problem: 'no-reply' };
}
