/** What is said aloud: which utterances get a phrase, how long it is, and how a reply is made speakable. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FEEDBACK_MAX, feedbackFor, feedbackPhrase, ONLY_CODE, replyPhrase, REPLY_MAX, SPOKEN } from '../bridge/spoken.js';
import type { Utterance } from '../shared/messages.js';

test('every kind of utterance is classified, and only commands, helper orders and failed prompts are spoken', () => {
  // SPOKEN is a record over every kind of utterance, so a new kind is a type error until it is classified here.
  const kinds = Object.keys(SPOKEN).sort() as Utterance['as'][];
  assert.deepEqual(kinds, ['command', 'helper', 'ignored', 'nothing', 'prompt']);
  const text = 'Showing alpha. Something else follows.';
  const table = kinds.flatMap(as => [true, false].map(ok => [as, ok, feedbackFor(as, ok, text)] as const));
  assert.deepEqual(table, [
    ['command', true, 'Showing alpha.'], ['command', false, 'Showing alpha.'],
    ['helper', true, 'Showing alpha.'], ['helper', false, 'Showing alpha.'],
    ['ignored', true, null], ['ignored', false, null],
    ['nothing', true, null], ['nothing', false, null],
    ['prompt', true, null], ['prompt', false, 'Showing alpha.'],
  ]);
});

test('a phrase of feedback is the first sentence, within the cap; a question keeps what answers it', () => {
  assert.equal(feedbackPhrase('Pressed enter in a1'), 'Pressed enter in a1');
  assert.equal(feedbackPhrase('Draft in a1. Say “go” to send it, or “scratch that” to clear it.'), 'Draft in a1.');
  assert.equal(feedbackPhrase('Do “Set the model to sonnet in a1”? Say “yes” or “no”.'), 'Do "Set the model to sonnet in a1"? Say "yes" or "no".');
  const long = `${'word '.repeat(60)}end.`;
  const cut = feedbackPhrase(long);
  assert.ok(cut.length <= FEEDBACK_MAX + 1, `cut to the cap, ${cut.length}`);
  assert.ok(cut.endsWith('…'));
  assert.equal(feedbackPhrase('Closed 3 sh (alpha).'), 'Closed 3 sh (alpha).');
});

test('a reply is made speakable: code dropped, links and markup plain, whole sentences within the cap', () => {
  assert.equal(replyPhrase('Done. The build passed.\n\n```ts\nconst x = 1;\n```\n\nSee [the docs](https://example.com/a) and https://example.com/b for more.'), 'Done. The build passed. See the docs and a link for more.');
  assert.equal(replyPhrase('```sh\nnpm test\n```'), ONLY_CODE);
  assert.equal(replyPhrase('   \n  '), null);
  assert.equal(replyPhrase('## Plan\n- first *step*\n- `second` step'), 'Plan first step second step');
  const many = Array.from({ length: 80 }, (_, i) => `Sentence number ${i} says something.`).join(' ');
  const phrase = replyPhrase(many) as string;
  assert.ok(phrase.length <= REPLY_MAX, `within the cap, ${phrase.length}`);
  assert.ok(phrase.endsWith('.') && !phrase.endsWith('…'), 'ends on a whole sentence');
  const oneLong = replyPhrase('x'.repeat(5000)) as string;
  assert.ok(oneLong.length <= REPLY_MAX + 1, 'one endless sentence is cut at the cap');
});
