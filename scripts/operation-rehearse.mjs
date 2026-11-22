import { spawnSync } from 'node:child_process';
import { fileURLToPath, URL } from 'node:url';
import console from 'node:console';
import process from 'node:process';

const root = fileURLToPath(new URL('../', import.meta.url));
const commands = [
  ['node_modules/typescript/bin/tsc', '--target', 'ES2023', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--strict', '--noUncheckedIndexedAccess', '--exactOptionalPropertyTypes', '--skipLibCheck', '--rootDir', '.', '--outDir', 'build', '--types', 'node', 'host/tests/operations.test.ts', 'host/src/fs-native-extensions.d.ts'],
  ['--test', 'build/host/tests/operations.test.js'],
];
for (const args of commands) {
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
  if (result.error || result.status !== 0) {
    console.error('Operations rehearsal failed; this is not live-release acceptance.');
    process.exit(result.status || 1);
  }
}
console.log('Detached FIXTURE rehearsals passed. No live backup, activation, provider, Docker or headset operation was performed.');
