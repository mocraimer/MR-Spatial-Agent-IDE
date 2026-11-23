/**
 * Keys typed into a mirror's pane, as the terminal sends them, turned into input for the PC
 * window it shows: text as text, and the keys a terminal encodes (Enter, arrows, Ctrl-letter…).
 */
import type { InputEvent } from './windows.js';

const CSI: Record<string, string> = { A: 'up', B: 'down', C: 'right', D: 'left', H: 'home', F: 'end' };
const TILDE: Record<string, string> = { '1': 'home', '3': 'delete', '4': 'end', '5': 'pageup', '6': 'pagedown', '7': 'home', '8': 'end' };

export function terminalKeys(bytes: Buffer): InputEvent[] {
  const s = bytes.toString('utf8');
  const out: InputEvent[] = [];
  let text = '';
  const key = (k: string, mods?: ('ctrl' | 'alt' | 'shift')[]) => { if (text) { out.push({ type: 'text', text }); text = ''; } out.push(mods ? { type: 'key', key: k, mods } : { type: 'key', key: k }); };
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i] as string;
    const code = c.charCodeAt(0);
    if (c === '\x1b') {
      const rest = s.slice(i + 1);
      const csi = /^\[(\d*)(?:;(\d+))?([A-Za-z~])/.exec(rest) ?? /^O([A-Za-z])/.exec(rest);
      if (csi) {
        const [whole] = csi;
        const final = csi.length === 2 ? csi[1] as string : csi[3] as string;
        const name = final === '~' ? TILDE[csi[1] ?? ''] : CSI[final];
        const m = Number(csi.length === 4 ? csi[2] ?? 1 : 1) - 1;
        const mods = ([m & 1 ? 'shift' : null, m & 2 ? 'alt' : null, m & 4 ? 'ctrl' : null].filter(Boolean) as ('ctrl' | 'alt' | 'shift')[]);
        if (name) key(name, mods.length ? mods : undefined);
        i += whole.length;
        continue;
      }
      const next = s[i + 1];
      if (next !== undefined && next !== '\x1b' && next.charCodeAt(0) >= 0x20) { key(next.toLowerCase(), ['alt']); i += 1; continue; }
      key('escape');
      continue;
    }
    if (c === '\r' || c === '\n') { key('enter'); continue; }
    if (c === '\t') { key('tab'); continue; }
    if (c === '\x7f' || c === '\b') { key('backspace'); continue; }
    if (code > 0 && code < 0x20) { key(String.fromCharCode(code + 96), ['ctrl']); continue; }
    if (code === 0) continue;
    text += c;
  }
  if (text) out.push({ type: 'text', text });
  return out;
}
