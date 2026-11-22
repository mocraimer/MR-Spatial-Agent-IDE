import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The one directory the view keeps state in: pairing, certificate, speech model, helper files. */
export function dataDirectory(): string {
  return process.env.VIEW_DATA ?? join(homedir(), '.local', 'share', 'spatial-agent-workspace', 'view');
}

/** Port inside WSL. Windows forwards the home network's port 47851 here. */
export const BRIDGE_PORT = port(process.env.VIEW_PORT ?? '47850');
function port(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`VIEW_PORT must be a port number, not "${value}"`);
  return n;
}
export const WINDOWS_PORT = 47851;

/** The owner's Herdr: the socket Herdr names for its panes, else its default. */
export function herdrSocket(): string {
  return process.env.HERDR_SOCKET_PATH ?? join(homedir(), '.config', 'herdr', 'herdr.sock');
}

const here = dirname(fileURLToPath(import.meta.url));
/** The repository, whether this runs compiled (build/view/bridge) or as source in Playwright. */
export const REPO = here.split('/').includes('build') ? join(here, '..', '..', '..') : join(here, '..', '..');
/** A compiled file of the view, e.g. compiled('bridge', 'guard.js'). */
export function compiled(...parts: string[]): string { return join(REPO, 'build', 'view', ...parts); }
