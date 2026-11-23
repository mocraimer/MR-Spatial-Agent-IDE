/** The last reply of a Claude Code session, read from a transcript file kept in a temporary directory. */
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { lastReply, TAIL_BYTES } from '../bridge/transcript.js';

const ID = '0297fb39-12de-405c-90b8-6f1b5a50073a';
const assistant = (...blocks: object[]) => JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: blocks } });
const text = (t: string) => ({ type: 'text', text: t });
const user = (t: string) => JSON.stringify({ type: 'user', message: { role: 'user', content: t } });

function withTranscript(lines: string[], run: (root: string) => void): void {
  const root = mkdtempSync('/tmp/svl-transcripts-');
  try {
    mkdirSync(join(root, '-some-project'));
    writeFileSync(join(root, '-some-project', `${ID}.jsonl`), `${lines.join('\n')}\n`);
    run(root);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test('the last assistant message with text is the reply: later tool-only messages and user lines are passed over', () => {
  withTranscript([
    user('first question'),
    assistant(text('An earlier answer.')),
    user('second question'),
    assistant(text('The real reply.'), { type: 'tool_use', name: 'Bash', input: {} }),
    assistant({ type: 'tool_use', name: 'Read', input: {} }),
    JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } }),
  ], root => assert.deepEqual(lastReply(ID, root), { text: 'The real reply.' }));
});

test('several text blocks of one message are one reply; a transcript with no assistant text has no reply', () => {
  withTranscript([assistant(text('One.'), text('Two.'))], root => assert.deepEqual(lastReply(ID, root), { text: 'One.\nTwo.' }));
  withTranscript([user('hello'), assistant({ type: 'thinking', thinking: 'hm' })], root => assert.deepEqual(lastReply(ID, root), { problem: 'no-reply' }));
});

test('a missing transcript, an id that is not a session id, and an unreadable file are told, never thrown', () => {
  withTranscript([assistant(text('x'))], root => {
    assert.deepEqual(lastReply('11111111-2222-3333-4444-555555555555', root), { problem: 'no-transcript' });
    assert.deepEqual(lastReply('../../etc/passwd', root), { problem: 'no-transcript' });
  });
  assert.deepEqual(lastReply(ID, '/tmp/svl-no-such-root'), { problem: 'no-transcript' });
  const root = mkdtempSync('/tmp/svl-transcripts-');
  try {
    mkdirSync(join(root, 'p', `${ID}.jsonl`), { recursive: true });
    assert.deepEqual(lastReply(ID, root), { problem: 'no-transcript' }, 'a directory is no transcript');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a transcript of many megabytes is read from its end: only the tail is loaded and its cut first line is skipped', () => {
  const filler = Array.from({ length: 40_000 }, (_, i) => assistant(text(`Old reply number ${i} ${'x'.repeat(100)}`)));
  withTranscript([...filler, assistant(text('The newest reply.'))], root => {
    assert.ok(filler.join('\n').length > 4 * TAIL_BYTES, 'the file is far bigger than the tail read');
    assert.deepEqual(lastReply(ID, root), { text: 'The newest reply.' });
  });
  // The tail starts inside a line: that piece is not read as a record.
  const huge = assistant(text('y'.repeat(TAIL_BYTES * 2)));
  withTranscript([assistant(text('Before.')), huge], root => assert.deepEqual(lastReply(ID, root), { problem: 'no-reply' }));
});

test('a transcript that is there but cannot be opened is told as unreadable, not as missing', () => {
  withTranscript([assistant(text('x'))], root => {
    chmodSync(join(root, '-some-project', `${ID}.jsonl`), 0o000);
    try { assert.deepEqual(lastReply(ID, root), { problem: 'unreadable' }); } finally { chmodSync(join(root, '-some-project', `${ID}.jsonl`), 0o600); }
  });
});
