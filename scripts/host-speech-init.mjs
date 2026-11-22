import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import process from 'node:process';
import { assertPrivatePath, loadHostConfig, loadSpeechOptions, prepareHostRoot } from '../build/host/src/config.js';
import { acquireFileLease } from '../build/host/src/file-lease.js';
import { OpenAiSpeechService } from '../build/host/src/speech.js';

// Explicit owner provisioning, never invoked by npm start or by a client/model.
const config = loadHostConfig();
if (!config.speechConfig) throw new Error('Set private owner speechConfig before this explicit one-time provisioning command.');
prepareHostRoot(config.root);
const release = acquireFileLease(config.root + '/host.lock');
try {
  const options = loadSpeechOptions(config.speechConfig, config.root);
  if (existsSync(options.journalPath) || existsSync(options.journalPath + '.identity')) throw new Error('Refusing an existing or incomplete journal. Preserve liabilities and follow owner maintenance recovery.');
  mkdirSync(dirname(options.journalPath), { recursive: true, mode: 0o700 });
  assertPrivatePath(dirname(options.journalPath), true);
  const service = new OpenAiSpeechService({ ...options, initializeJournal: true });
  await service.close();
  process.stdout.write('New private speech journal provisioned. No provider call, login or paid authority was created.\n');
} finally { release(); }
