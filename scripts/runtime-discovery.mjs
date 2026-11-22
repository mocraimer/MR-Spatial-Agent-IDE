import process from 'node:process';
import { readFileSync } from 'node:fs';
import { GuardedLocalAdapter } from '../build/host/src/runtime-adapters.js';

const args = process.argv.slice(2);
if (args.length !== 6 || args[0] !== '--profile' || args[2] !== '--model' || args[4] !== '--effort') {
  process.stderr.write('Usage: node scripts/runtime-discovery.mjs --profile <trusted RuntimeProfile.json> --model <exact ID> --effort <native effort>\n');
  process.exitCode = 2;
} else {
  try {
    const profile = JSON.parse(readFileSync(args[1], 'utf8'));
    if (!['pi-local', 'claude-local'].includes(profile.runtime)) throw new Error('Unsupported discovery runtime.');
    const adapter = new GuardedLocalAdapter(profile, {
      beforePrompt: () => { throw new Error('Discovery may not send a model prompt.'); },
      event: () => undefined,
      tools: async () => async () => { throw new Error('Discovery may not execute tools.'); },
      readUsage: async () => { throw new Error('Discovery may not read a provider account.'); },
    });
    process.stdout.write(JSON.stringify(await adapter.probe(args[3], args[5])) + '\n');
  } catch {
    process.stderr.write('BLOCKED: CLI preprompt inventory could not be verified. Check the explicitly selected CLI/profile/model/effort and private runtime state. No provider acceptance is claimed.\n');
    process.exitCode = 1;
  }
}
