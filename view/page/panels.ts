/**
 * Draws each surface of the view onto a 2D canvas; the scene puts the canvases in the room.
 * The app draws the text itself: a picture of a terminal is not legible in the headset.
 */
import { ANSI, CONTROL, plain } from '../shared/ansi.js';
import type { AgentStatus, PendingClose, Session, Utterance } from '../shared/messages.js';

export const INK = '#0b1017';
export const PAPER = '#e8eef4';
const DIM = '#8fa0b3';
const FAINT = '#5f6e80';
const EDGE = '#273444';
const RAISED = '#141d29';
const ACCENT = '#6cb6ff';
const AMBER = '#f2b33d';
const RED = '#ff5d5d';
/** The page ships both families (page/fonts); the rest are what a browser falls back to. */
const FONT = '"JetBrains Mono", "DejaVu Sans Mono", "Cascadia Mono", Menlo, Consolas, monospace';
const SANS = 'Inter, system-ui, "Segoe UI", Roboto, sans-serif';

/** Pixel size of one terminal character on the front panel's canvas. */
export const CHAR_PX = 20;
export const LINE_PX = 34;
export const FRONT_COLS = 120;
export const FRONT_ROWS = 32;

export type Light = AgentStatus | 'shell';
export function lightOf(s: Session): Light { return s.agent === null ? 'shell' : s.status; }

/** Colour plus shape, so a state is told at a glance and without colour. */
const LIGHTS: Record<Light, { colour: string; word: string }> = {
  blocked: { colour: AMBER, word: 'waiting' },
  working: { colour: '#46c8e8', word: 'working' },
  done: { colour: '#5ed38a', word: 'done' },
  idle: { colour: '#9aa5b1', word: 'idle' },
  unknown: { colour: '#9aa5b1', word: 'unknown' },
  shell: { colour: '#9aa5b1', word: 'shell' },
};
export function lightWord(light: Light): string { return LIGHTS[light].word; }

export function drawLight(ctx: CanvasRenderingContext2D, light: Light, x: number, y: number, r: number): void {
  const { colour } = LIGHTS[light];
  ctx.save();
  ctx.fillStyle = colour;
  ctx.strokeStyle = colour;
  ctx.lineWidth = Math.max(2, r * 0.22);
  // The states worth noticing glow a little; the quiet ones stay flat.
  if (light === 'blocked' || light === 'working' || light === 'done') { ctx.shadowColor = colour; ctx.shadowBlur = r * 0.9; }
  ctx.beginPath();
  switch (light) {
    case 'blocked':
      ctx.moveTo(x, y - r); ctx.lineTo(x + r * 1.05, y + r * 0.8); ctx.lineTo(x - r * 1.05, y + r * 0.8); ctx.closePath(); ctx.fill();
      ctx.shadowBlur = 0; ctx.fillStyle = INK; ctx.font = `bold ${r * 1.1}px ${SANS}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('!', x, y + r * 0.15);
      break;
    case 'working':
      ctx.arc(x, y, r, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x, y); ctx.arc(x, y, r, -Math.PI / 2, Math.PI / 2); ctx.closePath(); ctx.fill();
      break;
    case 'done':
      ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
      ctx.shadowBlur = 0; ctx.strokeStyle = INK; ctx.beginPath(); ctx.moveTo(x - r * 0.45, y); ctx.lineTo(x - r * 0.1, y + r * 0.38); ctx.lineTo(x + r * 0.5, y - r * 0.35); ctx.stroke();
      break;
    case 'idle':
      ctx.arc(x, y, r * 0.85, 0, Math.PI * 2); ctx.stroke();
      break;
    case 'unknown':
      ctx.setLineDash([r * 0.35, r * 0.3]); ctx.arc(x, y, r * 0.85, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
      ctx.font = `bold ${r}px ${SANS}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('?', x, y + r * 0.05);
      break;
    case 'shell':
      ctx.strokeRect(x - r * 0.9, y - r * 0.75, r * 1.8, r * 1.5);
      ctx.font = `bold ${r * 0.8}px ${FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('>_', x, y + r * 0.05);
      break;
  }
  ctx.restore();
}

// ---- ANSI text --------------------------------------------------------------------------------


interface Span { text: string; fg: string; bg: string | null; bold: boolean; dim: boolean }
const BASIC = ['#3b4450', '#ff6b6b', '#5ed38a', '#f2c94c', '#6cb6ff', '#d38cff', '#46c8e8', '#d7dde4'];
const BRIGHT = ['#6e7b8b', '#ff8f8f', '#7ff0a6', '#ffe08a', '#9ccfff', '#e5b3ff', '#7fe3f7', '#ffffff'];

function colour256(n: number): string {
  if (n < 8) return BASIC[n] as string;
  if (n < 16) return BRIGHT[n - 8] as string;
  if (n >= 232) { const v = 8 + (n - 232) * 10; return `rgb(${v},${v},${v})`; }
  const i = n - 16, steps = [0, 95, 135, 175, 215, 255];
  return `rgb(${steps[Math.floor(i / 36)]},${steps[Math.floor(i / 6) % 6]},${steps[i % 6]})`;
}

/** One terminal line into coloured spans. Escape sequences other than colour are dropped. */
export function parseAnsi(line: string): Span[] {
  const spans: Span[] = [];
  let style = { fg: PAPER, bg: null as string | null, bold: false, dim: false, inverse: false };
  let text = '';
  const flush = () => {
    if (!text) return;
    const fg = style.inverse ? (style.bg ?? INK) : style.fg;
    const bg = style.inverse ? style.fg : style.bg;
    spans.push({ text, fg, bg, bold: style.bold, dim: style.dim });
    text = '';
  };
  const pattern = new RegExp(ANSI.source, 'g');
  let last = 0;
  for (let m = pattern.exec(line); m; m = pattern.exec(line)) {
    text += line.slice(last, m.index);
    last = pattern.lastIndex;
    if (m[2] !== 'm') continue;
    flush();
    const codes = (m[1] ?? '').split(';').map(c => (c === '' ? 0 : Number(c)));
    for (let i = 0; i < codes.length; i += 1) {
      const c = codes[i] as number;
      if (c === 0) style = { fg: PAPER, bg: null, bold: false, dim: false, inverse: false };
      else if (c === 1) style.bold = true;
      else if (c === 2) style.dim = true;
      else if (c === 22) { style.bold = false; style.dim = false; }
      else if (c === 7) style.inverse = true;
      else if (c === 27) style.inverse = false;
      else if (c >= 30 && c <= 37) style.fg = BASIC[c - 30] as string;
      else if (c >= 90 && c <= 97) style.fg = BRIGHT[c - 90] as string;
      else if (c === 39) style.fg = PAPER;
      else if (c >= 40 && c <= 47) style.bg = BASIC[c - 40] as string;
      else if (c >= 100 && c <= 107) style.bg = BRIGHT[c - 100] as string;
      else if (c === 49) style.bg = null;
      else if ((c === 38 || c === 48) && codes[i + 1] === 5) { const v = colour256(codes[i + 2] ?? 0); if (c === 38) style.fg = v; else style.bg = v; i += 2; }
      else if ((c === 38 || c === 48) && codes[i + 1] === 2) { const v = `rgb(${codes[i + 2] ?? 0},${codes[i + 3] ?? 0},${codes[i + 4] ?? 0})`; if (c === 38) style.fg = v; else style.bg = v; i += 4; }
    }
  }
  text += line.slice(last);
  flush();
  return spans.map(s => ({ ...s, text: s.text.replace(CONTROL, '') })).filter(s => s.text);
}

/** A run of this many blank rows or more is drawn as one. */
const BLANK_RUN = 3;

/**
 * Terminal text into lines, for drawing. Without the trailing empty rows a terminal pads with,
 * and with each run of three or more blank rows as one: Claude Code pins its input box to the
 * bottom of a tall pane, so a short answer above it would otherwise sit out of view.
 */
export function terminalLines(text: string): string[] {
  const lines = text.split(/\r?\n/);
  while (lines.length > 0 && isBlank(lines[lines.length - 1] as string)) lines.pop();
  const out: string[] = [];
  for (let i = 0; i < lines.length;) {
    if (!isBlank(lines[i] as string)) { out.push(lines[i] as string); i += 1; continue; }
    let end = i;
    while (end < lines.length && isBlank(lines[end] as string)) end += 1;
    out.push(...(end - i >= BLANK_RUN ? [''] : lines.slice(i, end)));
    i = end;
  }
  return out;
}

function isBlank(line: string): boolean { return plain(line).trim() === ''; }

/** The rows the front panel draws: FRONT_ROWS of them, `scroll` rows back from the latest; `back` is how far back that really is. */
export function frontRows(text: string | undefined, scroll: number): { rows: string[]; back: number; total: number } {
  const lines = terminalLines(text ?? '');
  const back = Math.min(scroll, Math.max(0, lines.length - FRONT_ROWS));
  return { rows: lines.slice(Math.max(0, lines.length - FRONT_ROWS - back), lines.length - back), back, total: lines.length };
}

/** The rows a tile draws: the last few the session shows. */
export function tileRows(text: string | undefined): string[] { return terminalLines(text ?? '').slice(-TILE_ROWS); }

const fonts = new Map<string, string>();
/** Forgets measured fonts, for when the page's own fonts finish loading. */
export function resetFonts(): void { fonts.clear(); }
/** A monospace font sized so one character advances exactly `charPx`: whole spans keep their columns. */
function monoFont(ctx: CanvasRenderingContext2D, charPx: number, bold: boolean): string {
  const key = `${charPx}/${bold}`;
  let font = fonts.get(key);
  if (!font) {
    ctx.font = `${bold ? 'bold ' : ''}100px ${FONT}`;
    const advance = ctx.measureText('MMMMMMMMMM').width / 10 || 60;
    font = `${bold ? 'bold ' : ''}${(100 * charPx / advance).toFixed(2)}px ${FONT}`;
    fonts.set(key, font);
  }
  return font;
}

/** Terminal columns a character takes: two for wide East Asian characters and emoji. */
function cells(codePoint: number): number {
  return codePoint >= 0x1100 && (codePoint <= 0x115f || (codePoint >= 0x2e80 && codePoint <= 0xa4cf) || (codePoint >= 0xac00 && codePoint <= 0xd7a3)
    || (codePoint >= 0xf900 && codePoint <= 0xfaff) || (codePoint >= 0xfe30 && codePoint <= 0xfe4f) || (codePoint >= 0xff00 && codePoint <= 0xff60)
    || (codePoint >= 0xffe0 && codePoint <= 0xffe6) || (codePoint >= 0x1f300 && codePoint <= 0x1faff) || (codePoint >= 0x20000 && codePoint <= 0x3fffd)) ? 2 : 1;
}

function drawLines(ctx: CanvasRenderingContext2D, lines: string[], x: number, y: number, charPx: number, linePx: number, maxCols: number, alpha = 1): void {
  ctx.textBaseline = 'top';
  lines.forEach((line, row) => {
    let col = 0;
    const py = y + row * linePx;
    for (const span of parseAnsi(line)) {
      if (col >= maxCols) break;
      ctx.font = monoFont(ctx, charPx, span.bold);
      // Plain runs are set whole. Any other character is set in its own cell: a symbol the font
      // lacks comes from a fallback font whose width would push the rest of the row off its columns.
      for (const run of span.text.match(/[\x20-\x7e]+|[^\x20-\x7e]/gu) ?? []) {
        if (col >= maxCols) break;
        const code = run.codePointAt(0) as number;
        const plainRun = code >= 0x20 && code <= 0x7e;
        const text = plainRun ? run.slice(0, maxCols - col) : run;
        const width = plainRun ? text.length : cells(code);
        const px = x + col * charPx;
        if (span.bg) { ctx.fillStyle = span.bg; ctx.fillRect(px, py, width * charPx, linePx); }
        ctx.globalAlpha = alpha * (span.dim ? 0.62 : 1);
        ctx.fillStyle = span.fg;
        if (plainRun) ctx.fillText(text, px, py + linePx * 0.12);
        else { ctx.textAlign = 'center'; ctx.fillText(text, px + width * charPx / 2, py + linePx * 0.12, width * charPx); ctx.textAlign = 'left'; }
        ctx.globalAlpha = 1;
        col += width;
      }
    }
  });
}

interface PanelLook { edge?: string; edgeWidth?: number; radius?: number; fill?: number }
/** A panel's ground: near-opaque ink, a touch lighter at the top, with a fine edge. */
function panel(ctx: CanvasRenderingContext2D, w: number, h: number, look: PanelLook = {}): void {
  const { edge = EDGE, edgeWidth = 3, radius = 26, fill = 0.95 } = look;
  ctx.clearRect(0, 0, w, h);
  const ground = ctx.createLinearGradient(0, 0, 0, h);
  ground.addColorStop(0, '#121b27'); ground.addColorStop(0.35, INK); ground.addColorStop(1, '#090d13');
  ctx.fillStyle = ground;
  ctx.globalAlpha = fill;
  roundRect(ctx, 0, 0, w, h, radius); ctx.fill();
  ctx.globalAlpha = 1;
  ctx.strokeStyle = edge; ctx.lineWidth = edgeWidth;
  roundRect(ctx, edgeWidth / 2, edgeWidth / 2, w - edgeWidth, h - edgeWidth, radius - edgeWidth / 2); ctx.stroke();
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const k = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + k, y); ctx.arcTo(x + w, y, x + w, y + h, k); ctx.arcTo(x + w, y + h, x, y + h, k);
  ctx.arcTo(x, y + h, x, y, k); ctx.arcTo(x, y, x + w, y, k); ctx.closePath();
}

function hairline(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number): void {
  ctx.strokeStyle = EDGE; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
}

/** A small rounded tag; returns its width. `align` right places its right edge at `x`. */
function chip(ctx: CanvasRenderingContext2D, text: string, x: number, cy: number, size: number, colour: string, align: 'left' | 'right' = 'left'): number {
  ctx.font = `600 ${size}px ${SANS}`;
  const w = ctx.measureText(text).width + size * 1.3, h = size * 1.75;
  const left = align === 'right' ? x - w : x;
  ctx.fillStyle = RAISED; roundRect(ctx, left, cy - h / 2, w, h, h / 2); ctx.fill();
  ctx.strokeStyle = EDGE; ctx.lineWidth = 2; roundRect(ctx, left, cy - h / 2, w, h, h / 2); ctx.stroke();
  ctx.fillStyle = colour; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  ctx.fillText(text, left + size * 0.65, cy + size * 0.04);
  return w;
}

/** Why a window is not current and what to do, or null when it is. */
export type Staleness = string | null;

function staleBand(ctx: CanvasRenderingContext2D, w: number, h: number, radius: number, reason: string, size: number): void {
  ctx.save();
  roundRect(ctx, 0, 0, w, h, radius); ctx.clip();
  ctx.fillStyle = AMBER;
  ctx.fillRect(0, 0, w, size * 2.2);
  ctx.fillStyle = INK;
  ctx.font = `600 ${size}px ${SANS}`;
  ctx.textBaseline = 'middle';
  ctx.fillText(fit(ctx, reason.startsWith('!') ? reason.slice(1) : `Not current — ${reason}`, w - size * 1.8), size * 0.9, size * 1.14);
  ctx.restore();
}

/** Text broken into at most `lines` lines of `width`, the last one shortened if it must be. */
function wrap(ctx: CanvasRenderingContext2D, text: string, width: number, lines: number): string[] {
  const out: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    const next = line ? `${line} ${word}` : word;
    if (ctx.measureText(next).width <= width || !line) { line = next; continue; }
    out.push(line);
    line = word;
  }
  out.push(line);
  return out.length <= lines ? out : [...out.slice(0, lines - 1), fit(ctx, out.slice(lines - 1).join(' '), width)];
}

function fit(ctx: CanvasRenderingContext2D, text: string, width: number): string {
  if (ctx.measureText(text).width <= width) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(`${t}…`).width > width) t = t.slice(0, -1);
  return `${t}…`;
}

// ---- Surfaces ---------------------------------------------------------------------------------

/** What the front panel says when Herdr has no session in focus. */
export const EMPTY_FRONT = 'No session in front. Bring one forward from the shelf, or say "show" and its number.';
/** What it says when Herdr has no sessions at all. */
export const NO_SESSIONS = 'No sessions open in Herdr. Start one there and it appears here.';

export const FRONT_SIZE = { w: CHAR_PX * FRONT_COLS + 64, h: LINE_PX * FRONT_ROWS + 120 };
const FRONT_RADIUS = 30, HEADER = 88;

/** The session in front, full size. `scroll` is rows back from the latest. */
export function drawFront(canvas: HTMLCanvasElement, s: Session | null, project: string, text: string | undefined, scroll: number, stale: Staleness, empty = EMPTY_FRONT): number {
  const { w, h } = FRONT_SIZE;
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
  if (!s) {
    panel(ctx, w, h, { radius: FRONT_RADIUS });
    // The first sentence says what is so; the rest says what to do.
    const cut = empty.indexOf('. ') + 1;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = PAPER; ctx.font = `600 46px ${SANS}`; ctx.fillText(cut > 0 ? empty.slice(0, cut) : empty, w / 2, h / 2 - 34);
    ctx.fillStyle = DIM; ctx.font = `34px ${SANS}`; ctx.fillText(cut > 0 ? empty.slice(cut + 1) : '', w / 2, h / 2 + 34);
    ctx.textAlign = 'left';
    if (stale) staleBand(ctx, w, h, FRONT_RADIUS, stale, 30);
    return 0;
  }
  const light = lightOf(s);
  // The front session is the receiver: its edge says so, in amber when it waits on the owner.
  panel(ctx, w, h, { radius: FRONT_RADIUS, edge: light === 'blocked' ? AMBER : ACCENT, edgeWidth: light === 'blocked' ? 6 : 4 });
  const { rows: shown, back, total } = frontRows(text, scroll);
  const maxScroll = Math.max(0, total - FRONT_ROWS);
  const top = stale ? 2 * LINE_PX : 0, mid = top + HEADER / 2 + 2;
  drawLight(ctx, light, 58, mid, 17);
  ctx.fillStyle = PAPER; ctx.font = `600 38px ${SANS}`; ctx.textBaseline = 'middle';
  ctx.fillText(fit(ctx, s.name, w * 0.42), 94, mid + 2);
  let right = w - 36;
  if (back > 0) right -= chip(ctx, `${back} rows back`, right, mid, 26, ACCENT, 'right') + 14;
  right -= chip(ctx, lightWord(light), right, mid, 26, light === 'idle' || light === 'unknown' || light === 'shell' ? DIM : LIGHTS[light].colour, 'right') + 18;
  ctx.fillStyle = DIM; ctx.font = `28px ${SANS}`; ctx.textAlign = 'right';
  ctx.fillText(fit(ctx, project, w * 0.34), right, mid + 2);
  ctx.textAlign = 'left';
  if (!stale) hairline(ctx, 28, HEADER, w - 28, HEADER);
  // The band takes two rows' height: the two oldest rows shown make room for it.
  drawLines(ctx, stale ? shown.slice(2) : shown, 32, (stale ? 2 * LINE_PX : 0) + 100, CHAR_PX, LINE_PX, FRONT_COLS, stale ? 0.4 : 1);
  if (maxScroll > 0) {
    // Where the shown rows sit in the session's history.
    const track = h - 100 - 28, thumb = Math.max(48, track * FRONT_ROWS / total);
    const at = 100 + (track - thumb) * (1 - back / maxScroll);
    ctx.fillStyle = back > 0 ? ACCENT : EDGE; ctx.globalAlpha = back > 0 ? 0.85 : 1;
    roundRect(ctx, w - 20, at, 6, thumb, 3); ctx.fill(); ctx.globalAlpha = 1;
  }
  if (text === undefined) { ctx.fillStyle = DIM; ctx.font = `30px ${SANS}`; ctx.textBaseline = 'middle'; ctx.fillText('Reading…', 34, 128); }
  if (stale) staleBand(ctx, w, h, FRONT_RADIUS, stale, 30);
  return back;
}

export const TILE_SIZE = { w: 640, h: 400 };
const TILE_RADIUS = 26, TILE_ROWS = 10;

function badge(ctx: CanvasRenderingContext2D, number: number, x: number, cy: number, colour: string): void {
  ctx.fillStyle = RAISED; roundRect(ctx, x, cy - 24, 48, 48, 13); ctx.fill();
  ctx.strokeStyle = EDGE; ctx.lineWidth = 2; roundRect(ctx, x, cy - 24, 48, 48, 13); ctx.stroke();
  ctx.fillStyle = colour; ctx.font = `600 28px ${SANS}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(String(number), x + 24, cy + 2);
  ctx.textAlign = 'left';
}

export function drawTile(canvas: HTMLCanvasElement, number: number, s: Session, text: string | undefined, inFront: boolean, stale: Staleness): void {
  const { w, h } = TILE_SIZE;
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
  const light = lightOf(s);
  if (inFront) {
    // Its place on the shelf, kept open: the session itself is the large one.
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = INK; ctx.globalAlpha = 0.42; roundRect(ctx, 0, 0, w, h, TILE_RADIUS); ctx.fill(); ctx.globalAlpha = 1;
    ctx.strokeStyle = ACCENT; ctx.globalAlpha = 0.75; ctx.lineWidth = 3; ctx.setLineDash([16, 12]);
    roundRect(ctx, 2, 2, w - 4, h - 4, TILE_RADIUS - 2); ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1;
    badge(ctx, number, 22, 50, DIM);
    ctx.fillStyle = PAPER; ctx.globalAlpha = 0.8; ctx.font = `600 32px ${SANS}`; ctx.textBaseline = 'middle';
    ctx.fillText(fit(ctx, s.name, w - 120), 88, 52); ctx.globalAlpha = 1;
    ctx.fillStyle = ACCENT; ctx.font = `600 26px ${SANS}`; ctx.textAlign = 'center';
    ctx.fillText('in front', w / 2, h / 2 + 34);
    ctx.textAlign = 'left';
    return;
  }
  panel(ctx, w, h, { radius: TILE_RADIUS, edge: light === 'blocked' ? AMBER : EDGE, edgeWidth: light === 'blocked' ? 7 : 3 });
  const top = stale ? 50 : 0;
  // A session that just closed has no number any more.
  if (number > 0) badge(ctx, number, 22, top + 50, DIM);
  drawLight(ctx, light, 104, top + 50, 17);
  ctx.fillStyle = PAPER; ctx.font = `600 32px ${SANS}`; ctx.textBaseline = 'middle';
  ctx.fillText(fit(ctx, s.name, w - 300), 134, top + 52);
  ctx.fillStyle = light === 'idle' || light === 'unknown' || light === 'shell' ? DIM : LIGHTS[light].colour;
  ctx.font = `600 24px ${SANS}`; ctx.textAlign = 'right';
  ctx.fillText(lightWord(light), w - 26, top + 52);
  if (s.role !== 'task') { ctx.fillStyle = ACCENT; roundRect(ctx, 0, 24, 8, h - 48, 4); ctx.fill(); }
  ctx.textAlign = 'left';
  const textTop = top + 100;
  if (!stale) hairline(ctx, 22, textTop - 8, w - 22, textTop - 8);
  const lines = tileRows(text);
  ctx.save(); ctx.beginPath(); ctx.rect(16, textTop, w - 32, h - textTop - 14); ctx.clip();
  drawLines(ctx, lines, 22, textTop + 4, 12.4, 26, 48, stale ? 0.3 : 0.7);
  ctx.restore();
  if (stale) staleBand(ctx, w, h, TILE_RADIUS, stale, 22);
}

/** A project as one card: its name and one light per session; a waiting session makes it stand out. */
export const CHIP_SIZE = { w: 520, h: 150 };
export function drawChip(canvas: HTMLCanvasElement, name: string, sessions: Session[], overview: boolean): void {
  const { w, h } = CHIP_SIZE;
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
  const waiting = sessions.filter(s => lightOf(s) === 'blocked').length;
  panel(ctx, w, h, { radius: 22, edge: waiting ? AMBER : overview ? ACCENT : EDGE, edgeWidth: waiting ? 7 : 3 });
  ctx.fillStyle = PAPER; ctx.font = `600 36px ${SANS}`; ctx.textBaseline = 'middle';
  ctx.fillText(fit(ctx, name, w - (waiting ? 120 : 48)), 24, 44);
  if (waiting) { ctx.fillStyle = AMBER; ctx.font = `700 32px ${SANS}`; ctx.textAlign = 'right'; ctx.fillText(`!${waiting}`, w - 24, 44); ctx.textAlign = 'left'; }
  const lights = sessions.map(lightOf);
  const shown = lights.slice(0, 10);
  shown.forEach((light, i) => drawLight(ctx, light, 42 + i * 46, 106, 17));
  if (lights.length > shown.length) { ctx.fillStyle = DIM; ctx.font = `600 24px ${SANS}`; ctx.fillText(`+${lights.length - shown.length}`, 42 + shown.length * 46 - 8, 108); }
  if (lights.length === 0) { ctx.fillStyle = DIM; ctx.font = `500 24px ${SANS}`; ctx.fillText('no sessions', 24, 108); }
}

export interface StripState {
  receiver: string | null;
  mic: { open: boolean; opening: boolean; mode: 'hold' | 'switch'; problem: string | null };
  /** Why speech cannot be heard on the PC, or null when it can. */
  speech: string | null;
  last: Utterance | null;
  pendingHeard: boolean;
  notice: string | null;
  link: string | null;
  /** Direct sending is on: spoken prompts are sent as soon as they are heard. */
  direct: boolean;
  confirm: PendingClose | null;
}

export const STRIP_SIZE = { w: 2464, h: 150 };
export interface Region { id: string; x: number; y: number; w: number; h: number }

function eyebrow(ctx: CanvasRenderingContext2D, text: string, x: number, y: number): void {
  ctx.font = `600 22px ${SANS}`; ctx.fillStyle = FAINT; ctx.letterSpacing = '3px';
  ctx.fillText(text.toUpperCase(), x, y);
  ctx.letterSpacing = '0px';
}

/** A microphone, drawn: capsule, cradle and stand. */
function micGlyph(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, colour: string): void {
  ctx.save();
  ctx.fillStyle = colour; ctx.strokeStyle = colour; ctx.lineWidth = size * 0.11; ctx.lineCap = 'round';
  roundRect(ctx, x - size * 0.17, y - size * 0.5, size * 0.34, size * 0.62, size * 0.17); ctx.fill();
  ctx.beginPath(); ctx.arc(x, y - size * 0.06, size * 0.32, 0.12 * Math.PI, 0.88 * Math.PI); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(x, y + size * 0.27); ctx.lineTo(x, y + size * 0.46); ctx.moveTo(x - size * 0.17, y + size * 0.46); ctx.lineTo(x + size * 0.17, y + size * 0.46); ctx.stroke();
  ctx.restore();
}

/** Receiver, microphone, last utterance and link; a close waiting for the owner takes it over. */
export function drawStrip(canvas: HTMLCanvasElement, st: StripState): Region[] {
  const { w, h } = STRIP_SIZE;
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
  if (st.confirm) {
    panel(ctx, w, h, { edge: AMBER, edgeWidth: 6, radius: 30 });
    ctx.textBaseline = 'middle';
    ctx.fillStyle = AMBER; ctx.font = `600 44px ${SANS}`;
    ctx.fillText(fit(ctx, `Close ${st.confirm.name}?`, w - 800), 44, 56);
    ctx.fillStyle = DIM; ctx.font = `28px ${SANS}`;
    ctx.fillText('Say “yes” or “no”, or choose here. It stays open until you answer yes.', 44, 106);
    const regions = [{ id: 'confirm', x: w - 716, y: 26, w: 336, h: h - 52 }, { id: 'decline', x: w - 364, y: 26, w: 336, h: h - 52 }];
    button(ctx, regions[0] as Region, 'Yes, close', 34, 'on');
    button(ctx, regions[1] as Region, 'No, keep it', 34, 'plain');
    return regions;
  }
  panel(ctx, w, h, { radius: 30 });
  ctx.textBaseline = 'middle';
  eyebrow(ctx, 'Receiver', 40, 46);
  ctx.font = `600 40px ${SANS}`; ctx.fillStyle = st.receiver ? PAPER : DIM;
  ctx.fillText(fit(ctx, st.receiver ?? 'none', 510), 40, 98);

  // The microphone is a button: select it to listen, or hold it to talk.
  const mic = { id: 'mic', x: 600, y: 18, w: 600, h: h - 36 };
  const problem = st.mic.problem ?? st.speech;
  const state = problem ? AMBER : st.mic.open ? RED : st.mic.opening ? ACCENT : FAINT;
  ctx.fillStyle = st.mic.open ? '#2a1418' : RAISED; roundRect(ctx, mic.x, mic.y, mic.w, mic.h, mic.h / 2); ctx.fill();
  ctx.strokeStyle = problem || st.mic.open || st.mic.opening ? state : EDGE; ctx.lineWidth = st.mic.open ? 4 : 2.5;
  roundRect(ctx, mic.x, mic.y, mic.w, mic.h, mic.h / 2); ctx.stroke();
  const cx = mic.x + mic.h / 2 + 4, cy = h / 2;
  ctx.save();
  if (st.mic.open) { ctx.shadowColor = RED; ctx.shadowBlur = 26; }
  ctx.fillStyle = st.mic.open ? RED : '#1d2835'; ctx.beginPath(); ctx.arc(cx, cy, 40, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
  micGlyph(ctx, cx, cy, 50, st.mic.open ? '#ffffff' : problem ? AMBER : PAPER);
  const tx = cx + 60;
  ctx.font = `600 36px ${SANS}`; ctx.fillStyle = PAPER;
  ctx.fillText(st.mic.problem ? 'Mic unavailable' : st.speech ? 'Speech unavailable' : st.mic.open ? 'Listening' : st.mic.opening ? 'Opening mic…' : 'Mic off', tx, problem ? 42 : 54);
  if (problem) {
    // A problem says what to do, so it gets two lines rather than being cut short.
    ctx.font = `23px ${SANS}`; ctx.fillStyle = AMBER;
    wrap(ctx, problem, mic.x + mic.w - tx - 30, 2).forEach((line, i) => ctx.fillText(line, tx, 80 + i * 28));
  } else {
    ctx.font = `26px ${SANS}`; ctx.fillStyle = DIM;
    ctx.fillText(st.mic.mode === 'hold' ? 'Hold to talk' : 'Keep listening until “stop listening”', tx, 98);
  }

  const sayX = 1250, sayW = w - sayX - (st.link ? 400 : 44) - (st.direct ? 340 : 0);
  ctx.font = `600 34px ${SANS}`; ctx.fillStyle = st.last || st.pendingHeard ? PAPER : DIM;
  const said = st.pendingHeard ? 'Hearing…' : st.last ? `“${st.last.heard || '…'}”` : 'Nothing said yet';
  ctx.fillText(fit(ctx, said, sayW), sayX, 48);
  let x = sayX;
  if (!st.notice && st.last) {
    const tag = { command: 'Command', prompt: 'Prompt', helper: 'Helper order', nothing: 'Not acted on', ignored: 'Ignored' }[st.last.as];
    x += chip(ctx, tag, x, 102, 24, st.last.ok ? ACCENT : AMBER) + 16;
  }
  ctx.font = `28px ${SANS}`; ctx.fillStyle = st.last && !st.last.ok && !st.notice ? AMBER : DIM; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  ctx.fillText(fit(ctx, st.notice ?? st.last?.outcome ?? 'What you say shows here, with where it went.', sayX + sayW - x), x, 103);
  let right = w - 40;
  if (st.link) right -= chip(ctx, st.link, right, h / 2, 28, AMBER, 'right') + 16;
  // Direct sending is a standing exception to "say go": it shows whenever it is on.
  if (st.direct) chip(ctx, 'Sending at once', right, h / 2, 28, AMBER, 'right');
  return [mic];
}

export interface ControlButton { id: string; label: string; on?: boolean; /** A key sent to the session, drawn as a keycap. */ key?: boolean; /** Starts a new group. */ group?: boolean }
export const CONTROLS_SIZE = { w: 2464, h: 110 };

/** One row of buttons across the front panel's width, in groups, each as wide as its label needs. */
export function drawControls(canvas: HTMLCanvasElement, buttons: ControlButton[]): Region[] {
  const { w, h } = CONTROLS_SIZE;
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
  ctx.clearRect(0, 0, w, h);
  const size = 32, gap = 12, groupGap = 44;
  const gaps: number[] = buttons.map((b, i) => (i === 0 ? 0 : b.group ? groupGap : gap));
  const natural = buttons.map(b => { ctx.font = `600 ${size}px ${b.key ? FONT : SANS}`; return Math.max(120, ctx.measureText(b.label).width + 72); });
  const room = w - gaps.reduce((a, b) => a + b, 0), wanted = natural.reduce((a, b) => a + b, 0);
  const scale = room / wanted;
  let x = 0;
  return buttons.map((b, i) => {
    x += gaps[i] as number;
    const r = { id: b.id, x, y: 8, w: (natural[i] as number) * scale, h: h - 16 };
    // Every label in a row is one size: a crowded row shrinks together.
    button(ctx, r, b.label, size * Math.min(1, scale), b.key ? 'key' : b.on ? 'on' : 'plain');
    x += r.w;
    return r;
  });
}

function button(ctx: CanvasRenderingContext2D, r: Region, label: string, size: number, look: 'plain' | 'on' | 'key'): void {
  const radius = look === 'key' ? 16 : r.h / 2;
  const ground = ctx.createLinearGradient(0, r.y, 0, r.y + r.h);
  if (look === 'on') { ground.addColorStop(0, '#234a70'); ground.addColorStop(1, '#1b3a59'); }
  else if (look === 'key') { ground.addColorStop(0, '#0f1620'); ground.addColorStop(1, '#0b1118'); }
  else { ground.addColorStop(0, '#1a2532'); ground.addColorStop(1, '#131c27'); }
  ctx.fillStyle = ground; ctx.globalAlpha = 0.96;
  roundRect(ctx, r.x, r.y, r.w, r.h, radius); ctx.fill(); ctx.globalAlpha = 1;
  ctx.strokeStyle = look === 'on' ? ACCENT : look === 'key' ? '#33414f' : EDGE; ctx.lineWidth = look === 'on' ? 3 : 2.5;
  roundRect(ctx, r.x + 1.25, r.y + 1.25, r.w - 2.5, r.h - 2.5, radius); ctx.stroke();
  ctx.font = `600 ${size}px ${look === 'key' ? FONT : SANS}`;
  ctx.fillStyle = PAPER; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(fit(ctx, label, r.w - 20), r.x + r.w / 2, r.y + r.h / 2 + 2);
  ctx.textAlign = 'left';
}

/** Region under a canvas point, for hand and controller rays. */
export function regionAt(regions: Region[], x: number, y: number): string | null {
  return regions.find(r => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h)?.id ?? null;
}

export type TalkPhase = 'idle' | 'opening' | 'holding' | 'listening' | 'problem';
export const TALK_SIZE = { w: 2464, h: 120 };
const TALK_TEXT: Record<Exclude<TalkPhase, 'problem'>, string> = {
  idle: 'Talk — hold to speak, or tap to keep listening',
  opening: 'Opening mic… start when the dot turns red',
  holding: 'Listening — release to send',
  listening: 'Keep listening — tap to stop',
};

/** The Talk button, wide under the front session: what the microphone is doing, and how to use it. */
export function drawTalk(canvas: HTMLCanvasElement, phase: TalkPhase, problem: string | null): Region[] {
  const { w, h } = TALK_SIZE;
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
  const live = phase === 'holding' || phase === 'listening';
  panel(ctx, w, h, { edge: phase === 'problem' ? AMBER : live ? RED : '#6cb6ff', edgeWidth: 6 });
  ctx.beginPath(); ctx.arc(70, h / 2, 22, 0, Math.PI * 2);
  ctx.fillStyle = phase === 'problem' ? AMBER : live ? RED : phase === 'opening' ? DIM : '#6cb6ff'; ctx.fill();
  ctx.textBaseline = 'middle';
  ctx.fillStyle = PAPER; ctx.font = `600 44px ${SANS}`;
  ctx.fillText(fit(ctx, phase === 'problem' ? `Mic unavailable — ${problem ?? ''}` : TALK_TEXT[phase], w - 150), 116, h / 2);
  return [{ id: 'talk', x: 0, y: 0, w, h }];
}

export interface DraftState {
  /** The session in front holds a draft. */
  inFront: boolean;
  /** The other sessions that hold one, by name. */
  elsewhere: string[];
  /** The name of the session in front. */
  front: string | null;
}
export const DRAFT_SIZE = { w: 2464, h: 100 };

/** A draft that waits: in which session, and the words that send it or clear it. */
export function drawDraft(canvas: HTMLCanvasElement, d: DraftState): void {
  const { w, h } = DRAFT_SIZE;
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
  panel(ctx, w, h, { edge: d.inFront ? ACCENT : AMBER, edgeWidth: 5, radius: 26 });
  ctx.textBaseline = 'middle';
  const where = d.inFront ? d.front ?? 'the session in front' : d.elsewhere.join(', ');
  ctx.fillStyle = PAPER; ctx.font = `600 38px ${SANS}`;
  const title = d.inFront ? `Draft waiting in ${where}` : `Draft waiting in ${where}, not in front`;
  ctx.fillText(fit(ctx, title, 1150), 44, h / 2);
  ctx.fillStyle = d.inFront ? PAPER : DIM; ctx.font = `32px ${SANS}`; ctx.textAlign = 'right';
  const how = d.inFront ? 'Say “go” to send it, “scratch that” to clear it. More words are added to it.' : 'Bring it forward, then say “go”.';
  ctx.fillText(fit(ctx, how, w - 1250 - 44), w - 44, h / 2 + 2);
  ctx.textAlign = 'left';
}
