import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';
import { prepareCoordinatorApi } from './coordinator-api-artifact.mjs';

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--build-directory') {
  process.stderr.write('Usage: node scripts/coordinator-api-prepare.mjs --build-directory <reviewed coordinator dist>\n');
  process.exitCode = 2;
} else {
  try {
    process.stdout.write(JSON.stringify(prepareCoordinatorApi(args[1], fileURLToPath(new URL('../', import.meta.url))), null, 2) + '\n');
  } catch (error) {
    process.stderr.write(`${error.message}\n`); process.exitCode = 1;
  }
}
