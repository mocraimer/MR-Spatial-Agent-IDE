import process from 'node:process';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { verifyCoordinatorApi } from './coordinator-api-artifact.mjs';

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--build-directory') {
  process.stderr.write('Usage: node scripts/coordinator-api-verify.mjs --build-directory <selected coordinator dist>\n');
  process.exitCode = 2;
} else {
  try {
    const installed = dirname(createRequire(import.meta.url).resolve('agent-system/coordinator-api-identity'));
    process.stdout.write(JSON.stringify(verifyCoordinatorApi(args[1], installed), null, 2) + '\n');
  } catch (error) {
    process.stderr.write(`${error.message}\n`); process.exitCode = 1;
  }
}
