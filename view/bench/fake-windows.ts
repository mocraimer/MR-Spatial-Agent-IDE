/**
 * A stand-in for the PC's window helper, speaking its protocol (JSON lines on stdin and stdout),
 * for the view's tests: `SPATIAL_WINDOW_HELPER="node build/view/bench/fake-windows.js"`.
 *
 * Its windows come from SPATIAL_FAKE_WINDOWS (a JSON list of {hwnd, title, app}) or three of its
 * own. A captured window sends a PNG whose colour changes every half second. Every input it gets
 * is appended to SPATIAL_FAKE_WINDOWS_LOG; writing {"minimize"|"restore"|"gone": hwnd} lines to
 * SPATIAL_FAKE_WINDOWS_CTL changes a window's state.
 */
import { appendFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { deflateSync } from 'node:zlib';

interface W { hwnd: number; title: string; app: string; state: 'ok' | 'minimized' | 'gone' }
const windows: W[] = (JSON.parse(process.env.SPATIAL_FAKE_WINDOWS ?? 'null') as Omit<W, 'state'>[] | null ?? [
  { hwnd: 101, title: 'Storefront — localhost:3000 - Google Chrome', app: 'chrome.exe' },
  { hwnd: 102, title: 'Untitled - Notepad', app: 'notepad.exe' },
  { hwnd: 103, title: 'A window with a rather long title that goes on well past what a card can hold - Visual Studio Code', app: 'Code.exe' },
]).map(w => ({ ...w, state: 'ok' as const }));
const log = process.env.SPATIAL_FAKE_WINDOWS_LOG;
const ctl = process.env.SPATIAL_FAKE_WINDOWS_CTL;
const captures = new Map<number, NodeJS.Timeout>();
const emit = (m: object) => process.stdout.write(`${JSON.stringify(m)}\n`);

const CRC = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
function crc32(b: Buffer): number { let c = 0xffffffff; for (const x of b) c = (CRC[(c ^ x) & 0xff] as number) ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
/** A w by h picture in one colour, with a white square in its top-left corner. */
function png(w: number, h: number, rgb: [number, number, number]): Buffer {
  const rows: Buffer[] = [];
  for (let y = 0; y < h; y += 1) {
    const row = Buffer.alloc(1 + w * 3);
    for (let x = 0; x < w; x += 1) {
      const white = x < w / 8 && y < h / 8;
      row[1 + x * 3] = white ? 255 : rgb[0]; row[2 + x * 3] = white ? 255 : rgb[1]; row[3 + x * 3] = white ? 255 : rgb[2];
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}

function problemOf(w: W | undefined): string | null { return !w || w.state === 'gone' ? 'gone' : w.state === 'minimized' ? 'minimized' : null; }

function capture(hwnd: number): void {
  if (captures.has(hwnd)) return;
  let tick = 0;
  captures.set(hwnd, setInterval(() => {
    const w = windows.find(x => x.hwnd === hwnd);
    if (problemOf(w)) return;
    tick += 1;
    const phase = Math.floor(tick / 5) % 2;
    emit({ frame: hwnd, w: 320, h: 200, mime: 'image/png', data: png(320, 200, phase ? [40, 120, 200] : [200, 120, 40]).toString('base64') });
  }, 100));
}

function handle(r: Record<string, unknown>): Record<string, unknown> {
  switch (r.op) {
    case 'list': return { windows: windows.filter(w => w.state !== 'gone').map(({ hwnd, title, app }) => ({ hwnd, title, app })) };
    case 'capture': { const hwnd = Number(r.hwnd); capture(hwnd); return { problem: problemOf(windows.find(w => w.hwnd === hwnd)) }; }
    case 'stop': { const t = captures.get(Number(r.hwnd)); if (t) clearInterval(t); captures.delete(Number(r.hwnd)); if (log) appendFileSync(log, `${JSON.stringify({ stop: r.hwnd })}\n`); return {}; }
    case 'input': {
      const w = windows.find(x => x.hwnd === Number(r.hwnd));
      if (log) appendFileSync(log, `${JSON.stringify({ hwnd: r.hwnd, events: r.events })}\n`);
      return { problem: problemOf(w) };
    }
    case 'open': {
      const w: W = { hwnd: 200 + windows.length, title: `${String(r.url)} - Google Chrome`, app: 'chrome.exe', state: 'ok' };
      windows.push(w);
      if (log) appendFileSync(log, `${JSON.stringify({ open: r.url })}\n`);
      return { window: { hwnd: w.hwnd, title: w.title, app: w.app } };
    }
    default: throw new Error(`unknown op ${String(r.op)}`);
  }
}

if (ctl) setInterval(() => {
  if (!existsSync(ctl)) return;
  const lines = readFileSync(ctl, 'utf8').split('\n').filter(Boolean);
  rmSync(ctl);
  for (const line of lines) {
    const m = JSON.parse(line) as Record<string, number>;
    for (const [state, hwnd] of Object.entries(m)) {
      const w = windows.find(x => x.hwnd === hwnd);
      if (!w) continue;
      w.state = state === 'restore' ? 'ok' : state === 'minimize' ? 'minimized' : 'gone';
      emit({ window: hwnd, problem: problemOf(w) });
    }
  }
}, 100);

emit({ ready: true });
createInterface({ input: process.stdin }).on('line', line => {
  let r: Record<string, unknown>;
  try { r = JSON.parse(line) as Record<string, unknown>; } catch { return; }
  try { emit({ id: r.id, ok: true, ...handle(r) }); } catch (error) { emit({ id: r.id, ok: false, error: (error as Error).message }); }
});
process.stdin.on('end', () => process.exit(0));
