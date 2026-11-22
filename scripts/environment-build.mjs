import { spawnSync } from 'node:child_process';
import { fileURLToPath, URL } from 'node:url';
import process from 'node:process';
const context = fileURLToPath(new URL('../environments', import.meta.url));
const result = spawnSync('docker', ['build', '--label', 'com.spatial.workspace.product=task-environment', '--tag', 'spatial-workspace-task:offline-v1', context], { stdio: 'inherit', env: { PATH: process.env.PATH, HOME: process.env.HOME } });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
