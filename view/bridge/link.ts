/**
 * The Wi-Fi link: Windows forwards the home network's port 47851 to the bridge inside WSL
 * (127.0.0.1:47850 through WSL's own localhost forwarding, so WSL's changing address never
 * matters), and a firewall allowance limited to private networks lets the headset in.
 * This only reads Windows' settings and says what is missing; changing them is the owner's
 * one-time administrator step (docs/USER-GUIDE.md).
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { BRIDGE_PORT, WINDOWS_PORT } from './config.js';

const NETSH = '/mnt/c/Windows/System32/netsh.exe';
const POWERSHELL = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
export const FIREWALL_RULE = `Herdr spatial view ${WINDOWS_PORT}`;
export const ADD_FORWARD = `netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=${WINDOWS_PORT} connectaddress=127.0.0.1 connectport=${BRIDGE_PORT}`;
export const ADD_FIREWALL = `New-NetFirewallRule -DisplayName "${FIREWALL_RULE}" -Direction Inbound -Protocol TCP -LocalPort ${WINDOWS_PORT} -Action Allow -Profile Private`;

function windows(file: string, args: string[]): string | null {
  try { return execFileSync(file, args, { cwd: '/mnt/c', encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] }).replace(/\r/g, ''); } catch { return null; }
}

/** Lines telling the owner where to point the headset, or the command that is still missing. */
export function linkReport(): string[] {
  if (!existsSync(NETSH) || !existsSync(POWERSHELL)) return ['not running in WSL: open the bridge address from the headset directly'];
  const lines: string[] = [];
  const forwards = windows(NETSH, ['interface', 'portproxy', 'show', 'v4tov4']);
  const rule = windows(POWERSHELL, ['-NoProfile', '-Command', `Get-NetFirewallRule -DisplayName "${FIREWALL_RULE}" -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Enabled`]);
  // A query that failed tells nothing; only a successful answer can say something is missing.
  if (forwards === null || rule === null) lines.push('could not read Windows\' port forward or firewall settings; if the headset cannot connect, see docs/USER-GUIDE.md');
  const forwarded = forwards === null || new RegExp(`\\b${WINDOWS_PORT}\\s+127\\.0\\.0\\.1\\s+${BRIDGE_PORT}\\b`).test(forwards);
  const allowed = rule === null || rule.trim() === 'True';
  const address = windows(POWERSHELL, ['-NoProfile', '-Command', "(Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.InterfaceAlias -eq (Get-NetConnectionProfile | Where-Object NetworkCategory -eq 'Private' | Select-Object -First 1).InterfaceAlias }).IPAddress"])?.trim().split('\n')[0];
  if (!forwarded) lines.push(`Windows does not forward port ${WINDOWS_PORT} yet. Once, in an administrator PowerShell: ${ADD_FORWARD}`);
  if (!allowed) lines.push(`Windows' firewall does not allow port ${WINDOWS_PORT} yet. Once, in an administrator PowerShell: ${ADD_FIREWALL}`);
  lines.push(address ? `on the headset open https://${address}:${WINDOWS_PORT}/` : `on the headset open https://<this PC's home-network address>:${WINDOWS_PORT}/ (no private network found)`);
  return lines;
}
