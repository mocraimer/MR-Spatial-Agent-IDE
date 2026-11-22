/** The phrases the speech tests say; `make-speech.ts` turns each into a WAV file. */
import { COMMANDS } from '../shared/actions.js';

/** Every spoken form's first wording, plus the phrases that are not commands. */
export const PHRASES: string[] = [
  ...COMMANDS.map(c => c.say[0] as string),
  'show two',
  'show three',
  'summarize the ledger change',
  'back up the database before you migrate',
  'helper, start a shell in project alpha',
  'helper, start a claude agent in project beta',
  'helper, rename the shell in project alpha to logs',
  'helper, close the logs session',
  'helper, close the logs session and do not ask me',
  'helper, count the files in the current folder',
  'helper, how many sessions are in project beta',
];

export function slug(phrase: string): string { return phrase.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }

