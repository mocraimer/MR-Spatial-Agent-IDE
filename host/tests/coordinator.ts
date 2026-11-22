import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * The tests that drive the real coordinator need its compiled `dist/` directory: set
 * SPATIAL_COORDINATOR_DIST to that directory of a build of agent-system's spatial API
 * (docs/COORDINATOR-BUILD.md). Without it those tests are skipped and say so.
 */
const configured = process.env['SPATIAL_COORDINATOR_DIST'];
function skipReason(): string | false {
  if (!configured) return "SPATIAL_COORDINATOR_DIST is not set; set it to the coordinator build's dist directory (docs/COORDINATOR-BUILD.md)";
  if (!existsSync(resolve(configured, 'commands.js'))) return `SPATIAL_COORDINATOR_DIST is set to ${configured}, which holds no commands.js; set it to a built coordinator's dist directory (docs/COORDINATOR-BUILD.md)`;
  return false;
}
export const coordinatorSkip: string | false = skipReason();
/** Only meaningful when `coordinatorSkip` is false; the tests that use it are skipped otherwise. */
export const coordinatorDist = resolve(configured ?? '');
export const coordinatorFile = (name: string): string => resolve(coordinatorDist, name);
export const coordinatorUrl = (name: string): string => pathToFileURL(coordinatorFile(name)).href;
