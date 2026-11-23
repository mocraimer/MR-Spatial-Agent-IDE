/**
 * The page: holds what the bridge reported, draws the shelf, and turns hands, controllers, keys
 * and speech into the actions in `shared/actions.ts`. The link is `link.ts`, where things sit is
 * `layout.ts`, drawing is `panels.ts`, the room is `scene.ts`, the microphone is `mic.ts`.
 */
import { plain } from '../shared/ansi.js';
import { command, COMMANDS, type PageAction } from '../shared/actions.js';
import { parseUtterance, type BridgeEvent, type PendingAsk, type PendingClose, type Picker, type Session, type Shelf, type SpeechState, type Utterance } from '../shared/messages.js';
import type { ViewState } from '../shared/view-state.js';
import { arrange, columnFit, CHIP_ARC, FRONT_DISTANCE, FRONT_WIDTH, FRONT_Y, ARC, TOP, type Closed } from './layout.js';
import { BridgeLink } from './link.js';
import { Mic, openMicrophone, type Captured, type OpenSource } from './mic.js';
import { VoicePlayer } from './voice.js';
import {
  bigScreen, drawPicker, drawWindowFront, drawWindowTile, type Picture,
  CONTROLS_SIZE, LINE_PX, drawChip, drawControls, drawTalk, TALK_SIZE, type TalkPhase, drawDraft, DRAFT_SIZE, drawFront, drawStrip, drawTile, STRIP_SIZE, EMPTY_FRONT, FRONT_SIZE, NO_SESSIONS, frontRows, lightOf, regionAt, resetFonts, terminalLines, tileRows, type ControlButton, type DraftState, type Region, type StripState,
  drawBar,
} from './panels.js';
import { multiply, onArc, pose, Scene, type Hit, type Mat, type Pointer, type Rect } from './scene.js';

const state = {
  shelf: null as Shelf | null,
  texts: new Map<string, string>(),
  textVersion: new Map<string, number>(),
  /** Sessions that just closed, kept a moment so their tile can say so. */
  closed: new Map<string, Closed & { until: number }>(),
  last: null as Utterance | null,
  hearing: 0,
  notice: null as { text: string; until: number } | null,
  confirm: null as PendingClose | null,
  ask: null as PendingAsk | null,
  direct: false,
  voice: { feedback: true, reading: false, trouble: false },
  speech: { ready: false, reason: 'Connecting to the PC…' } as SpeechState,
  scroll: 0,
  scale: 1,
  /** Each window mirror's latest picture, and what it says in place of one. */
  pictures: new Map<string, Picture & { version: number }>(),
  notes: new Map<string, string | null>(),
  picker: null as Picker | null,
  keyboardOpen: false,
};
/** Where the front window mirror's picture is drawn on the front canvas, for mapping a click into the window. */
let windowRect: Rect | null = null;
/** Pictures being decoded, newest wins. */
const decoding = new Map<string, number>();

const NOTICE_MS = 6000;
const CLOSED_MS = 6000;
const SCROLL_STEP = 10;
/** Transcribing and carrying out one utterance takes well under this. */
const UTTERANCE_TIMEOUT_MS = 20_000;

// ---- Two movable groups -------------------------------------------------------------------------

/** Default controls position: 0.6 m away, 0.35 m below eye height, facing the owner. */
const CONTROLS_DEFAULT_DISTANCE = 0.6;
const CONTROLS_DEFAULT_Y = -0.35;

/**
 * Group positions: azimuth in radians (positive = right of centre) and height delta in metres.
 * Both start at zero — no offset from their natural positions.
 * pose(0, dy, 0, -az) gives the group-offset matrix: rotates the group around Y, shifts height.
 */
let screensAz = 0, screensDy = 0;
let controlsAz = 0, controlsDy = 0;

/** State captured at bar-grab start: initial cylinder hit and group state. */
let barGrabState: { surface: string; az0: number; y0: number; groupAz: number; groupDy: number } | null = null;

const GROUP_STORAGE_KEY = 'spatial-view-group-offsets';

function loadGroupOffsets(): void {
  try {
    const raw = localStorage.getItem(GROUP_STORAGE_KEY);
    if (!raw) return;
    const data = JSON.parse(raw) as unknown;
    if (!Array.isArray(data) || data.length !== 2) return;
    const [s, c] = data as [[number, number], [number, number]];
    if (Array.isArray(s) && s.length >= 2) { screensAz = Number(s[0]) || 0; screensDy = Number(s[1]) || 0; }
    if (Array.isArray(c) && c.length >= 2) { controlsAz = Number(c[0]) || 0; controlsDy = Number(c[1]) || 0; }
  } catch { /* corrupted — use defaults */ }
}

function saveGroupOffsets(): void {
  try {
    localStorage.setItem(GROUP_STORAGE_KEY, JSON.stringify([[screensAz, screensDy], [controlsAz, controlsDy]]));
  } catch { /* storage unavailable */ }
}

function resetGroupOffsets(): void {
  screensAz = 0; screensDy = 0;
  controlsAz = 0; controlsDy = 0;
  saveGroupOffsets();
}

loadGroupOffsets();

const canvas = document.getElementById('scene') as HTMLCanvasElement;
const scene = new Scene(canvas, {
  pointer,
  scroll: rows => { if (frontSession()?.window && !state.picker) windowScroll(rows); else scrollBy(rows); },
  draggable: surface => surface === 'front',
  // The text follows the hand: dragging down brings older lines into view.
  drag: (surface, dy) => { if (surface !== 'front') return; if (frontSession()?.window && !state.picker) windowScroll(dy / LINE_PX); else scrollBy(dy / LINE_PX); },
  groupBar: surface => surface === 'bar:screens' || surface === 'bar:controls',
  groupBarStart: (surface, pos) => {
    // pos is the bar centre in anchor-local space.  Derive its azimuth for delta tracking.
    barGrabState = {
      surface,
      az0: Math.atan2(pos[0], -pos[2]),
      y0: pos[1],
      groupAz: surface === 'bar:screens' ? screensAz : controlsAz,
      groupDy: surface === 'bar:screens' ? screensDy : controlsDy,
    };
  },
  groupMove: (surface, pos) => {
    // pos is the ray's cylinder intersection in anchor-local space.
    if (!barGrabState || barGrabState.surface !== surface) return;
    const az = Math.atan2(pos[0], -pos[2]);
    const newAz = barGrabState.groupAz + (az - barGrabState.az0);
    const newDy = barGrabState.groupDy + (pos[1] - barGrabState.y0);
    if (surface === 'bar:screens') { screensAz = newAz; screensDy = newDy; }
    else { controlsAz = newAz; controlsDy = newDy; }
    saveGroupOffsets();
    render();
  },
  frame: () => { if (renderWanted) { renderWanted = false; renderNow(); } },
  target: hit => targetRect(hit),
  visibilityChange: state => { bridgeLog({ event: 'visibility', state: state as 'visible' | 'visible-blurred' | 'hidden' }); },
});
let openSource: OpenSource = openMicrophone;
const mic = new Mic(src => openSource(src), () => state.shelf?.focusedId ?? null, sendUtterance, render);
const link = new BridgeLink(apply, render);
/** The voice: phrases the bridge made, fetched and played. The microphone hears nothing while one plays. */
const player = new VoicePlayer(
  async id => { const r = await fetch(`/api/say/${id}`, { credentials: 'same-origin' }); return r.ok ? await r.arrayBuffer() : null; },
  () => { mic.setSuspended(player.playing); render(); },
);
// Sound may start only after a tap or key press: take every one as the chance to allow it.
for (const type of ['pointerdown', 'keydown'] as const) window.addEventListener(type, () => player.unlock(), { capture: true });

setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const [id, c] of state.closed) if (c.until < now) { state.closed.delete(id); changed = true; }
  if (state.notice && state.notice.until < now) { state.notice = null; changed = true; }
  if (changed) render();
}, 1000);

function isPageAction(action: string): action is PageAction {
  return COMMANDS.some(c => 'page' in c.run && c.run.page === action);
}

function apply(event: BridgeEvent): void {
  switch (event.type) {
    case 'shelf': {
      const before = state.shelf;
      if (before) {
        const ids = new Set(event.shelf.sessions.map(s => s.id));
        for (const s of before.sessions) {
          if (ids.has(s.id)) continue;
          state.closed.set(s.id, { session: s, projectId: s.workspaceId, project: projectLabel(before, s), until: Date.now() + CLOSED_MS });
          state.texts.delete(s.id);
          state.textVersion.delete(s.id);
          // A closed mirror's last picture holds GPU memory: free it now.
          const picture = state.pictures.get(s.id);
          if (picture && 'close' in picture.image) (picture.image as ImageBitmap).close();
          state.pictures.delete(s.id);
          state.notes.delete(s.id);
          decoding.delete(s.id);
          notice(`${s.name} closed in Herdr.`);
        }
        if (before.focusedId !== event.shelf.focusedId) { state.scroll = 0; scrollExact = 0; }
      }
      state.shelf = event.shelf;
      break;
    }
    case 'text':
      state.texts.set(event.id, event.text);
      state.textVersion.set(event.id, (state.textVersion.get(event.id) ?? 0) + 1);
      break;
    case 'utterance': state.last = event.utterance; break;
    case 'notice': notice(event.text); break;
    case 'confirm': state.confirm = event.pending; break;
    case 'ask': state.ask = event.ask; break;
    case 'direct': state.direct = event.on; break;
    case 'voice': state.voice = { feedback: event.feedback, reading: event.reading, trouble: event.trouble }; break;
    case 'say': player.enqueue(event.id); break;
    case 'say-stop': player.stop(); break;
    case 'speech': state.speech = event.speech; break;
    case 'page': if (isPageAction(event.action)) runPage(event.action); break;
    case 'frame': { decodeFrame(event); return; }
    case 'window': state.notes.set(event.id, event.note); break;
    case 'picker': state.picker = event.picker; break;
    default: return assertNever(event);
  }
  render();
}

function decodeFrame(event: Extract<BridgeEvent, { type: 'frame' }>): void {
  const seq = (decoding.get(event.id) ?? 0) + 1;
  decoding.set(event.id, seq);
  const bytes = Uint8Array.from(atob(event.data), c => c.charCodeAt(0));
  void createImageBitmap(new Blob([bytes], { type: event.mime })).then(image => {
    if (decoding.get(event.id) !== seq) { image.close(); return; }
    const before = state.pictures.get(event.id);
    if (before && 'close' in before.image) (before.image as ImageBitmap).close();
    state.pictures.set(event.id, { image, w: event.w, h: event.h, version: (before?.version ?? 0) + 1 });
    render();
  }, () => undefined);
}

function frontSession(): Session | null {
  const shelf = state.shelf;
  return shelf?.sessions.find(s => s.id === shelf.focusedId) ?? null;
}

/** A click or scroll in the front window mirror, at a point of the front canvas (or its middle). */
function windowInput(input: { type: 'click' } | { type: 'wheel'; delta: number }, at?: { x: number; y: number }): void {
  const s = frontSession();
  if (!s?.window || !windowRect) return;
  const x = at ? (at.x - windowRect.x) / windowRect.w : 0.5, y = at ? (at.y - windowRect.y) / windowRect.h : 0.5;
  if (x < 0 || x > 1 || y < 0 || y > 1) return;
  void link.post('/api/action', { window: s.id, input: { ...input, x, y } }).then(r => { if (!r.ok) { notice(said(r, 'The window did not take that.')); render(); } });
}

/** Scroll amounts gathered until they make whole wheel steps for a window mirror. */
let wheelRows = 0;
let lastFrontPoint: { x: number; y: number } | undefined;
function windowScroll(rows: number): void {
  wheelRows += rows;
  const steps = Math.trunc(wheelRows / 3);
  if (steps === 0) return;
  wheelRows -= steps * 3;
  windowInput({ type: 'wheel', delta: steps }, lastFrontPoint);
}

function assertNever(value: never): never { throw new Error(`Unhandled ${JSON.stringify(value)}`); }

function notice(text: string): void { state.notice = { text, until: Date.now() + NOTICE_MS }; }

function said(reply: { body: Record<string, unknown> }, fallback: string): string {
  const { outcome, error } = reply.body;
  return typeof outcome === 'string' ? outcome : typeof error === 'string' ? error : fallback;
}

// ---- Actions ------------------------------------------------------------------------------------

async function runCommand(id: string): Promise<void> {
  const c = command(id);
  if ('page' in c.run) { runPage(c.run.page); return; }
  // The voice stops at once; the bridge is told to drop what waits behind it.
  if (id === 'voice-stop') player.stop();
  notice(said(await link.post('/api/action', { command: id }), c.label));
  render();
}

async function go(projectId: string): Promise<void> {
  const r = await link.post('/api/action', { go: projectId });
  notice(said(r, r.ok ? 'Going there.' : 'Could not go there.'));
  render();
}

async function focus(sessionId: string): Promise<void> {
  const r = await link.post('/api/action', { focus: sessionId });
  if (!r.ok) notice(said(r, 'Could not bring it forward.'));
  render();
}

// ---- Headset keyboard (AC-5.1 / AC-5.2 / AC-5.3) -----------------------------------------------

type LogEvent =
  | { event: 'visibility'; state: 'visible' | 'visible-blurred' | 'hidden' }
  | { event: 'keyboard'; open: boolean }
  | { event: 'keys'; count: number };

/** Posts a structured diagnostic event to the bridge log (terminal + log file). Never includes typed text. */
function bridgeLog(ev: LogEvent): void {
  void link.post('/api/log', ev);
}

/** Reusable hidden input for the Quest system keyboard. Created once; always in the DOM. */
let keyboardInput: HTMLInputElement | null = null;

/** Tracks the last value seen from the keyboard input, to compute character diffs. */
let lastKeyboardValue = '';

/** Text queued for typing: batched while a request is in flight. */
let typeQueue = '';
let typeInFlight = false;

/** Timestamps of recent key events for once-per-minute count diagnostics. */
const keyTimestamps: number[] = [];
let lastKeyCountMinute = 0;

function updateKeyCount(n: number): void {
  const now = Date.now();
  for (let i = 0; i < n; i++) keyTimestamps.push(now);
  while (keyTimestamps.length > 0 && keyTimestamps[0] !== undefined && now - keyTimestamps[0] > 60_000) keyTimestamps.shift();
  const bucket = Math.floor(now / 60_000);
  if (bucket !== lastKeyCountMinute) {
    lastKeyCountMinute = bucket;
    bridgeLog({ event: 'keys', count: keyTimestamps.length });
  }
}

async function flushTypeQueue(): Promise<void> {
  if (typeInFlight || typeQueue === '') return;
  typeInFlight = true;
  const text = typeQueue;
  typeQueue = '';
  await link.post('/api/action', { type_text: text });
  typeInFlight = false;
  if (typeQueue !== '') void flushTypeQueue();
}

function queueText(text: string): void {
  if (!text) return;
  updateKeyCount(text.length);
  typeQueue += text;
  void flushTypeQueue();
}

function getOrCreateKeyboardInput(): HTMLInputElement {
  if (keyboardInput) return keyboardInput;
  const el = document.createElement('input');
  el.id = 'keyboard-input';
  el.type = 'text';
  el.setAttribute('enterkeyhint', 'send');
  // Visually hidden but focusable: width/height must be >0 for some browsers.
  el.style.cssText = 'position:fixed;opacity:0.001;pointer-events:none;left:-9999px;top:0;width:1px;height:1px;';
  document.body.appendChild(el);

  // AC-5.3: Track focus/blur for state changes.
  el.addEventListener('focus', () => {
    if (!state.keyboardOpen) { state.keyboardOpen = true; bridgeLog({ event: 'keyboard', open: true }); render(); }
  });
  el.addEventListener('blur', () => {
    if (state.keyboardOpen) { state.keyboardOpen = false; bridgeLog({ event: 'keyboard', open: false }); render(); }
  });

  // AC-5.1: Characters from the system keyboard arrive via input events.
  // Physical keydowns call e.preventDefault(), so the field never changes for them and no
  // input event follows — no extra flag is needed.
  // Use a common-prefix diff so deletes and replacements are forwarded correctly.
  el.addEventListener('input', () => {
    const prev = lastKeyboardValue;
    const curr = el.value;
    // Common prefix: how many chars match from the left.
    let pfx = 0;
    while (pfx < prev.length && pfx < curr.length && prev[pfx] === curr[pfx]) pfx++;
    // Send a backspace for each character deleted after the common prefix.
    const deleted = prev.length - pfx;
    for (let i = 0; i < deleted; i++) forwardKey('backspace');
    // Queue the new suffix.
    const added = curr.slice(pfx);
    if (added) queueText(added);
    lastKeyboardValue = curr;
  });

  keyboardInput = el;
  return el;
}

/** AC-5.1: Toggle the Quest system keyboard for the session in front. */
function openKeyboard(): void {
  const el = getOrCreateKeyboardInput();
  if (state.keyboardOpen) {
    state.keyboardOpen = false;
    bridgeLog({ event: 'keyboard', open: false });
    el.blur();
    render();
  } else {
    // AC-5.1: When in XR, check whether the system keyboard is available.
    if (scene.immersive && scene.sessionKeyboardSupported !== true) {
      notice('This headset\'s browser cannot show its keyboard here. Use physical keys to type.');
      render();
      return;
    }
    state.keyboardOpen = true;
    // Reset field and value tracker so the next show starts from empty.
    el.value = '';
    lastKeyboardValue = '';
    bridgeLog({ event: 'keyboard', open: true });
    el.focus();
    render();
    // Quest: request virtual keyboard explicitly when available.
    if ('virtualKeyboard' in navigator) {
      const vk = (navigator as unknown as { virtualKeyboard: { show?: () => void } }).virtualKeyboard;
      if (typeof vk.show === 'function') vk.show();
    }
  }
}

/** AC-5.2: Post a named key (from a physical keyboard) to the session in front. */
function forwardKey(key: 'enter' | 'escape' | 'backspace' | 'tab' | 'up' | 'down' | 'left' | 'right' | 'ctrl+c'): void {
  void link.post('/api/action', { key });
}

function runPage(action: PageAction): void {
  switch (action) {
    case 'scroll-up': if (frontSession()?.window) windowInput({ type: 'wheel', delta: 3 }); else scroll(1); return;
    case 'scroll-down': if (frontSession()?.window) windowInput({ type: 'wheel', delta: -3 }); else scroll(-1); return;
    case 'scroll-bottom': state.scroll = 0; scrollExact = 0; break;
    case 'recenter': scene.recenter(); resetGroupOffsets(); notice('Shelf recentred in front of you.'); break;
    case 'listening-off': stopListening(); break;
    case 'mode-hold': stopListening(); mic.setMode('hold'); notice('Hold Talk to speak; tap it to keep listening.'); break;
    case 'mode-switch': mic.setMode('switch'); void mic.switchOn(); notice('Keep listening: tap Talk or say "stop listening" to stop.'); break;
    case 'text-bigger': state.scale = Math.min(1.6, Math.round((state.scale + 0.1) * 10) / 10); break;
    case 'text-smaller': state.scale = Math.max(0.7, Math.round((state.scale - 0.1) * 10) / 10); break;
    case 'exit-mr': void scene.exit(); break;
    case 'keyboard': openKeyboard(); break;
    default: return assertNever(action);
  }
  render();
}

function scroll(direction: 1 | -1): void { scrollBy(direction * SCROLL_STEP); }

/** Rows back from the latest, kept fractional so slow thumbstick and drag movements add up. */
let scrollExact = 0;
function scrollBy(rows: number): void {
  scrollExact = Math.max(0, scrollExact + rows);
  const whole = Math.round(scrollExact);
  if (whole !== state.scroll) { state.scroll = whole; render(); }
}

let utterances: Promise<void> = Promise.resolve();
function sendUtterance(c: Captured): void {
  state.hearing += 1;
  render();
  utterances = utterances.then(async () => {
    const query = new URLSearchParams({ id: c.id, ...(c.receiver ? { receiver: c.receiver } : {}), ...(c.standby ? { standby: '1' } : {}) });
    // The same id may be sent again after a drop: the bridge carries each utterance out once.
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const r = await link.post(`/api/utterance?${query.toString()}`, c.audio.slice().buffer, UTTERANCE_TIMEOUT_MS);
      if (r.status !== 0) {
        const u = parseUtterance(r.body);
        if (u) state.last = u; else notice(said(r, 'The PC could not take that utterance.'));
        break;
      }
      if (attempt === 3) notice('Not sent: no link to the PC.');
      else await new Promise(resolve => setTimeout(resolve, 1000));
    }
    state.hearing -= 1;
    render();
  });
}

/**
 * Talk: hold to speak (release sends), or tap to turn "keep listening" on or off. The Talk
 * button, a controller's A/X button or grip, and the ` key all work the same way.
 */
const TAP_MS = 350;
type TalkBy = 'pointer' | 'squeeze' | 'button' | 'key';
let talking: { by: TalkBy; at: number; stopsListening: boolean } | null = null;

function talkStart(by: TalkBy): void {
  // The mic may have ended a hold by itself (the length limit); a new press starts afresh.
  if (talking && mic.isHolding) return;
  const listening = mic.mode === 'switch' && (mic.open || mic.isOpening);
  talking = { by, at: Date.now(), stopsListening: listening };
  if (listening) return;
  if (mic.mode !== 'hold') mic.setMode('hold');
  void mic.holdStart();
}

function talkEnd(by: TalkBy): void {
  if (talking?.by !== by) return;
  const { at, stopsListening } = talking;
  talking = null;
  if (stopsListening) { stopListening(); mic.setMode('hold'); notice('Stopped listening.'); return; }
  if (Date.now() - at < TAP_MS) {
    // A tap, not a hold: drop the moment just recorded and keep listening instead.
    mic.setMode('switch');
    void mic.switchOn();
    notice('Keep listening: tap Talk again, or say "stop listening", to stop.');
    return;
  }
  mic.holdEnd();
}

/** Listening off, and a hold whose release may never come is dropped, not sent later. */
function stopListening(): void {
  talking = null;
  mic.stop();
}

function pointer(event: Pointer, hit: Hit | null): void {
  const target = hit ? targetOf(hit) : null;
  if (event === 'squeeze-start') { talkStart('squeeze'); return; }
  if (event === 'squeeze-end') { talkEnd('squeeze'); return; }
  if (event === 'button-start') { talkStart('button'); return; }
  if (event === 'button-end') { talkEnd('button'); return; }
  if (event === 'select-start') { if (target === 'talk' || target === 'mic') talkStart('pointer'); return; }
  if (event === 'select-end') { talkEnd('pointer'); return; }
  if (hit?.surface === 'front') lastFrontPoint = { x: hit.x, y: hit.y };
  if (!target && hit?.surface === 'front' && !state.picker && frontSession()?.window) { windowInput({ type: 'click' }, { x: hit.x, y: hit.y }); return; }
  if (!target || target === 'talk' || target === 'mic') return;
  if (target.startsWith('pick:')) { void link.post('/api/action', { pick: Number(target.slice(5)) }).then(r => { notice(said(r, 'Picked.')); render(); }); return; }
  if (target.startsWith('session:')) { const id = target.slice(8); if (id !== state.shelf?.focusedId) void focus(id); return; }
  if (target.startsWith('go:')) { void go(target.slice(3)); return; }
  if (COMMANDS.some(c => c.id === target)) void runCommand(target);
}

const regions = new Map<string, Region[]>();
/** What selecting each chip does: go into its project, or to the overview. */
const chipTargets = new Map<string, string>();
function targetOf(hit: Hit): string | null {
  if (hit.surface.startsWith('tile:')) return `session:${hit.surface.slice(5)}`;
  if (hit.surface.startsWith('chip:')) return chipTargets.get(hit.surface) ?? null;
  return regionAt(regions.get(hit.surface) ?? [], hit.x, hit.y);
}
/** The rectangle to highlight under a pointer: a whole tile, or the button it is on. */
function targetRect(hit: Hit): Rect | null {
  if (hit.surface.startsWith('chip:')) { const c = canvases.get(hit.surface); return c ? { x: 0, y: 0, w: c.width, h: c.height } : null; }
  if (hit.surface.startsWith('tile:')) {
    const c = canvases.get(hit.surface);
    return c && hit.surface.slice(5) !== state.shelf?.focusedId ? { x: 0, y: 0, w: c.width, h: c.height } : null;
  }
  return regions.get(hit.surface)?.find(r => hit.x >= r.x && hit.x <= r.x + r.w && hit.y >= r.y && hit.y <= r.y + r.h) ?? null;
}

addEventListener('keydown', e => {
  // Skip forwarding for inputs OTHER than the hidden keyboard input.
  if (e.target instanceof HTMLInputElement && e.target !== keyboardInput) return;
  if (e.code === 'Backquote' && !e.repeat) { talkStart('key'); e.preventDefault(); return; }
  const asked = state.confirm !== null || state.ask !== null;
  if (asked && (e.key === 'y' || e.key === 'Y')) { void runCommand('confirm'); return; }
  if (asked && (e.key === 'n' || e.key === 'N' || e.key === 'Escape')) { void runCommand('decline'); return; }

  // AC-5.2: forward physical keys to the session in front when in XR.
  // Works even when the hidden keyboard input is focused (system keyboard open): preventDefault
  // stops the key from modifying the field, so the input event does not re-fire for it.
  if (!scene.immersive) return;
  e.preventDefault();
  switch (e.key) {
    case 'Enter': forwardKey('enter'); break;
    case 'Escape': forwardKey('escape'); break;
    case 'Backspace': forwardKey('backspace'); break;
    case 'Tab': forwardKey('tab'); break;
    case 'ArrowUp': forwardKey('up'); break;
    case 'ArrowDown': forwardKey('down'); break;
    case 'ArrowLeft': forwardKey('left'); break;
    case 'ArrowRight': forwardKey('right'); break;
    default:
      if (e.ctrlKey && e.key === 'c') { forwardKey('ctrl+c'); break; }
      // Printable characters: forward via the serialised queue.
      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) queueText(e.key);
      break;
  }
});
addEventListener('keyup', e => { if (e.code === 'Backquote') talkEnd('key'); });
// A key released in another window never reaches this one.
addEventListener('blur', () => { if (talking?.by === 'key') stopListening(); });

// ---- The shelf --------------------------------------------------------------------------------

const canvases = new Map<string, HTMLCanvasElement>();
const drawn = new Map<string, string>();
/** Redraws a surface only when what it shows has changed. */
function surface(id: string, key: string, width: number, at: Float32Array, draw: (c: HTMLCanvasElement) => void): void {
  let c = canvases.get(id);
  if (!c) { c = document.createElement('canvas'); canvases.set(id, c); }
  if (drawn.get(id) !== key) { draw(c); drawn.set(id, key); scene.set(id, c, width, at); return; }
  const s = scene.surfaces.get(id);
  if (s) { s.pose = at; s.width = width; } else scene.set(id, c, width, at);
}

function staleness(): string | null {
  switch (link.state) {
    case 'connecting': return 'Connecting to the PC…';
    case 'unpaired': return 'This headset is not paired. Leave mixed reality and pair with a new code from the PC.';
    case 'lost': return navigator.onLine === false
      ? 'This headset is offline. Check its Wi-Fi; the view reconnects by itself.'
      : `No link to the view bridge on the PC (${link.why || 'connecting'}). Check \`npm run view\` is running there; reconnecting…`;
    case 'live': return state.shelf?.herdr.state === 'down' ? state.shelf.herdr.reason : null;
  }
}

function projectLabel(shelf: Shelf, s: Session): string { return shelf.projects.find(p => p.id === s.workspaceId)?.label ?? ''; }

const EMPTY_SHELF: Shelf = { herdr: { state: 'up' }, projects: [], sessions: [], focusedId: null, overviewId: null, starting: [], failed: [], drafts: [] };

/** A level agent that is not up yet says so on its window, with what to do. */
function agentNote(shelf: Shelf, s: Session | null): string | null {
  if (!s || s.role === 'task') return null;
  const failed = shelf.failed.find(f => f.id === s.id);
  // A leading ! marks a band that is about the agent, not about the window being out of date.
  if (failed) return `!${failed.reason}`;
  if (shelf.starting.includes(s.id)) return `!${s.role === 'overview-agent' ? 'The helper' : 'This project\'s agent'} is starting. Speak to it once this band is gone.`;
  return null;
}

/**
 * Asks for a redraw on the next frame. The scene's frame callback does it, in or out of the
 * headset: on a Quest the window's own frames stop in immersive mode.
 */
let renderWanted = true;
function render(): void { renderWanted = true; }

function renderNow(): void {
  const stale = staleness();
  const shelf = state.shelf ?? EMPTY_SHELF;
  const { front, place, columns, chips } = arrange(shelf, state.closed.values());
  const placeName = place.overview ? 'Overview' : place.project;
  const frontStale = stale ?? agentNote(shelf, front);
  const used = new Set<string>();
  const frontWidth = FRONT_WIDTH * state.scale;
  const frontHeight = frontWidth * FRONT_SIZE.h / FRONT_SIZE.w;
  const frontText = front ? state.texts.get(front.id) : undefined;
  const empty = shelf.sessions.length === 0 ? NO_SESSIONS : EMPTY_FRONT;
  const picture = front?.window ? state.pictures.get(front.id) ?? null : null;
  const windowNote = front?.window ? state.notes.get(front.id) ?? null : null;
  const frontKey = state.picker ? ['picker', state.picker, frontStale]
    : front?.window ? ['window', front, picture?.version, windowNote, frontStale, placeName]
    : [front, front && state.textVersion.get(front.id), state.scroll, frontStale, empty, placeName];
  /** Place a surface with a group offset applied to its base pose. */
  const inGroup = (id: string, key: string, width: number, basePose: Mat, groupOff: Mat, draw: (c: HTMLCanvasElement) => void) => {
    surface(id, key, width, multiply(groupOff, basePose), draw);
  };

  // Derive offset matrices from the stored azimuth/height scalars.
  // pose(0, dy, 0, -az) rotates surfaces around the owner's Y axis and shifts height.
  const screensOffset = pose(0, screensDy, 0, -screensAz);
  const controlsOffset = pose(0, controlsDy, 0, -controlsAz);

  // ---- Screens group: front session, strip (above), tiles and chips ----
  inGroup('front', JSON.stringify(frontKey), frontWidth, onArc(0, FRONT_Y, FRONT_DISTANCE), screensOffset, c => {
    if (state.picker) { regions.set('front', drawPicker(c, state.picker)); windowRect = null; return; }
    regions.delete('front');
    if (front?.window) { windowRect = drawWindowFront(c, front, placeName, picture, windowNote, frontStale); return; }
    windowRect = null;
    state.scroll = drawFront(c, front, placeName, frontText, state.scroll, frontStale, empty);
    // At the top of what the session holds, further scrolling back adds nothing.
    if (scrollExact > state.scroll) scrollExact = state.scroll;
  });
  used.add('front');

  const stripWidth = Math.max(FRONT_WIDTH, frontWidth);
  const strip: StripState = {
    receiver: front?.name ?? null,
    mic: { open: mic.open, opening: mic.isOpening, standby: mic.standby, mode: mic.mode, problem: mic.problem },
    speech: state.speech.ready ? null : state.speech.reason,
    last: state.last,
    pendingHeard: state.hearing > 0,
    notice: state.notice?.text ?? null,
    link: stale && link.state !== 'live' ? 'No link to the PC' : stale ? 'Herdr unavailable' : null,
    direct: state.direct,
    voiceOff: !state.voice.feedback,
    voiceProblem: state.voice.trouble || player.problem !== null,
    reading: state.voice.reading,
    confirm: state.confirm,
    ask: state.ask,
  };
  inGroup('strip', JSON.stringify(strip), stripWidth, onArc(0, FRONT_Y + frontHeight / 2 + 0.06, FRONT_DISTANCE), screensOffset, c => { regions.set('strip', drawStrip(c, strip)); });
  used.add('strip');

  // A draft that waits says where, and the words that send or clear it, just above the strip.
  const stripHeight = stripWidth * STRIP_SIZE.h / STRIP_SIZE.w;
  const draft: DraftState | null = shelf.drafts.length === 0 ? null : {
    inFront: front !== null && shelf.drafts.includes(front.id),
    elsewhere: shelf.drafts.filter(id => id !== front?.id).map(id => shelf.sessions.find(s => s.id === id)?.name ?? id),
    front: front?.name ?? null,
  };
  if (draft) {
    const barHeight = stripWidth * DRAFT_SIZE.h / DRAFT_SIZE.w;
    inGroup('draft', JSON.stringify(draft), stripWidth, onArc(0, FRONT_Y + frontHeight / 2 + 0.06 + stripHeight / 2 + 0.014 + barHeight / 2, FRONT_DISTANCE), screensOffset, c => drawDraft(c, draft));
    used.add('draft');
  }

  chipTargets.clear();
  for (const chip of chips) {
    const id = `chip:${chip.projectId}`;
    chipTargets.set(id, chip.overview ? 'overview' : `go:${chip.projectId}`);
    inGroup(id, JSON.stringify([chip.project, chip.overview, chip.sessions.map(s => [s.agent, s.status])]), chip.width, onArc(chip.angle, chip.y, CHIP_ARC), screensOffset, c => drawChip(c, chip.project, chip.sessions, chip.overview));
    used.add(id);
  }

  for (const column of columns) {
    const { step, width } = columnFit(column.tiles.length);
    column.tiles.forEach((t, i) => {
      const id = `tile:${t.session.id}`;
      const tileStale = t.closed ? 'Closed in Herdr — nothing to do.' : stale ?? agentNote(shelf, t.session);
      const inFront = t.session.id === front?.id;
      const tilePicture = t.session.window && !inFront ? state.pictures.get(t.session.id) ?? null : null;
      const tileNote = t.session.window ? state.notes.get(t.session.id) ?? null : null;
      inGroup(id, JSON.stringify([t.n, t.session, inFront, tileStale, inFront ? 0 : t.session.window ? [tilePicture?.version, tileNote] : state.textVersion.get(t.session.id)]), width, onArc(column.angle, TOP - i * step, ARC), screensOffset, c => {
        if (t.session.window && !inFront) drawWindowTile(c, t.n, t.session, tilePicture, tileNote, tileStale);
        else drawTile(c, t.n, t.session, state.texts.get(t.session.id), inFront, tileStale);
      });
      used.add(id);
    });
  }

  // Grab bar for the screens group: at the bottom of the front panel.
  const barPhysH = stripWidth * 80 / 2464; // 80px canvas height at stripWidth metres wide
  inGroup('bar:screens', JSON.stringify('screens'), stripWidth, onArc(0, FRONT_Y - frontHeight / 2 - 0.012 - barPhysH / 2, FRONT_DISTANCE), screensOffset, c => drawBar(c, 'Screens'));
  used.add('bar:screens');

  // ---- Controls group: Talk, button rows, draft bar ----
  // Each inner list is a group: what belongs together sits together.
  const row = (groups: string[][], key: boolean): ControlButton[] => groups.flatMap(ids => ids.map((id, i) => ({ id, label: command(id).label, key, group: i === 0 })));
  const rows: ControlButton[][] = [
    row([['next', 'back'], ['scroll-up', 'scroll-down', 'bottom'], ['smaller', 'bigger', 'recenter'], ['overview', 'mirror', 'new-project'], ['keyboard', 'exit']], false),
    row([['enter', 'escape', 'interrupt'], ['up', 'down', 'tab'], ['y', 'n'], ['one', 'two', 'three']], true),
    // Words: send or clear the draft in front, and how spoken prompts are sent. The one in force is lit.
    row([['send', 'scratch'], ['direct-on', 'direct-off']], false).map(b => ({ ...b, on: b.id === (state.direct ? 'direct-on' : 'direct-off') })),
    // Words for the session in front: its model and effort (typed into it as /model and /effort).
    row([['model-haiku', 'model-sonnet', 'model-opus'], ['effort-low', 'effort-medium', 'effort-high', 'effort-xhigh', 'effort-max']], false),
    // The voice: whether answers are spoken and replies read, reading the last reply now, and stopping.
    row([['voice-on', 'voice-off'], ['read-on', 'read-off'], ['read-last', 'voice-stop']], false).map(b => ({ ...b, on: b.id === (state.voice.feedback ? 'voice-on' : 'voice-off') || b.id === (state.voice.reading ? 'read-on' : 'read-off') })),
  ].map((btns, i) => i === 0 ? btns.map(b => b.id === 'keyboard' ? { ...b, on: state.keyboardOpen } : b) : btns);

  // Controls group: Talk at the natural default position, rows stacking below it.
  // Base poses use absolute world-space positions (CONTROLS_DEFAULT_Y, CONTROLS_DEFAULT_DISTANCE).
  // controlsOffset (derived above) rotates and shifts the whole group from these defaults.
  const phase: TalkPhase = mic.problem ?? (state.speech.ready ? null : state.speech.reason) ? 'problem'
    : mic.open ? (mic.mode === 'hold' ? 'holding' : 'listening') : mic.standby ? 'standby' : mic.isOpening ? 'opening' : 'idle';
  const talkProblem = mic.problem ?? (state.speech.ready ? null : state.speech.reason);
  const talkHeight = stripWidth * TALK_SIZE.h / TALK_SIZE.w;
  const talkY = CONTROLS_DEFAULT_Y;
  inGroup('talk', JSON.stringify([phase, talkProblem]), stripWidth, onArc(0, talkY, CONTROLS_DEFAULT_DISTANCE), controlsOffset, c => { regions.set('talk', drawTalk(c, phase, talkProblem)); });
  used.add('talk');
  const controlsHeight = stripWidth * CONTROLS_SIZE.h / CONTROLS_SIZE.w;
  rows.forEach((buttons, i) => {
    const id = `controls-${i}`;
    const y = talkY - talkHeight / 2 - 0.012 - controlsHeight / 2 - i * (controlsHeight + 0.008);
    inGroup(id, JSON.stringify(buttons), stripWidth, onArc(0, y, CONTROLS_DEFAULT_DISTANCE), controlsOffset, c => { regions.set(id, drawControls(c, buttons)); });
    used.add(id);
  });

  // Grab bar for the controls group: below the last controls row.
  const lastControlY = talkY - talkHeight / 2 - 0.012 - controlsHeight / 2 - (rows.length - 1) * (controlsHeight + 0.008);
  const ctrlBarY = lastControlY - controlsHeight / 2 - 0.012 - barPhysH / 2;
  inGroup('bar:controls', JSON.stringify('controls'), stripWidth, onArc(0, ctrlBarY, CONTROLS_DEFAULT_DISTANCE), controlsOffset, c => drawBar(c, 'Controls'));
  used.add('bar:controls');
  for (const id of [...scene.surfaces.keys()]) if (!used.has(id)) { scene.remove(id); canvases.delete(id); drawn.delete(id); }
  updatePage();
}

// ---- The flat page: pairing and entering mixed reality ----------------------------------------

const pairForm = document.getElementById('pair') as HTMLFormElement;
const codeInput = document.getElementById('code') as HTMLInputElement;
const enterButton = document.getElementById('enter') as HTMLButtonElement;
const status = document.getElementById('status') as HTMLParagraphElement;
let enterProblem: string | null = null;

pairForm.addEventListener('submit', e => {
  e.preventDefault();
  void (async () => {
    const r = await link.post('/api/pair', { code: codeInput.value });
    if (r.ok) { codeInput.value = ''; await link.connect(); return; }
    status.textContent = said(r, 'Pairing failed.');
  })();
});
(document.getElementById('newcode') as HTMLButtonElement).addEventListener('click', () => {
  void link.post('/api/pair/new', {}).then(r => { status.textContent = r.ok ? 'A new code is shown in the terminal where the view runs on the PC.' : said(r, 'No link to the PC.'); });
});
enterButton.addEventListener('click', () => {
  void (async () => {
    enterProblem = null;
    // Leaving mixed reality turns listening off: the owner can no longer see the microphone.
    // In mixed reality the microphone stays open for commands while listening is off; leaving closes it.
    try { await scene.enter(() => { stopListening(); mic.disarm(); updatePage(); }); scene.recenter(); void mic.arm(); } catch (error) { enterProblem = `Mixed reality did not start: ${(error as Error).message}`; }
    updatePage();
  })();
});

function updatePage(): void {
  const unpaired = link.state === 'unpaired';
  pairForm.hidden = !unpaired;
  enterButton.hidden = unpaired || scene.immersive;
  (document.querySelector('main') as HTMLElement).hidden = scene.immersive;
  document.body.dataset.link = link.state;
  status.textContent = enterProblem ?? (unpaired ? 'Pair this headset with the code shown on the PC.' : staleness() ?? 'Connected. Put the view around you with "Enter mixed reality".');
}

// ---- What tests and agents can read and drive -------------------------------------------------

declare global {
  interface Window {
    viewState(): ViewState;
    viewTest: { text(id: string): string[]; feed(samples: number[]): void; fakeMic(refuse?: boolean): void; worldPoint(id: string, x: number, y: number): [number, number, number] | null; region(surface: string, id: string): { x: number; y: number } | null };
  }
}
window.viewState = () => {
  const shelf = state.shelf;
  const { front, place, columns, chips } = arrange(shelf ?? EMPTY_SHELF, state.closed.values());
  return {
    link: link.state,
    stale: staleness(),
    herdr: shelf?.herdr ?? null,
    front: front?.id ?? null,
    emptyHint: front ? null : shelf && shelf.sessions.length > 0 ? EMPTY_FRONT : NO_SESSIONS,
    receiver: shelf?.focusedId ?? null,
    frontText: front && !front.window ? frontRows(plain(state.texts.get(front.id) ?? ''), state.scroll, bigScreen(front)).rows : [],
    frontWindow: front?.window ? { note: state.notes.get(front.id) ?? null, picture: state.pictures.get(front.id) ? { w: state.pictures.get(front.id)?.w ?? 0, h: state.pictures.get(front.id)?.h ?? 0, version: state.pictures.get(front.id)?.version ?? 0 } : null, rect: windowRect } : null,
    picker: state.picker,
    place: place.overview ? { overview: true } : { overview: false, projectId: place.projectId, project: place.project },
    agentNote: shelf ? agentNote(shelf, front)?.replace(/^!/, '') ?? null : null,
    chips: chips.map(c => ({ projectId: c.projectId, project: c.project, overview: c.overview, sessions: c.sessions.map(s => ({ id: s.id, light: lightOf(s) })), angle: c.angle, width: c.width })),
    columns: columns.map(c => ({ projectId: c.projectId, project: c.project, side: c.angle < 0 ? 'left' as const : 'right' as const, width: columnFit(c.tiles.length).width, tiles: c.tiles.map(t => ({ n: t.n, id: t.session.id, name: t.session.name, role: t.session.role, window: t.session.window, picture: state.pictures.get(t.session.id)?.version ?? 0, light: lightOf(t.session), closed: t.closed, inFront: t.session.id === front?.id, text: tileRows(plain(state.texts.get(t.session.id) ?? '')) })) })),
    scroll: state.scroll,
    scale: state.scale,
    mic: { mode: mic.mode, open: mic.open, standby: mic.standby, problem: mic.problem },
    speech: state.speech,
    last: state.last,
    hearing: state.hearing,
    notice: state.notice?.text ?? null,
    confirm: state.confirm,
    ask: state.ask,
    drafts: shelf?.drafts ?? [],
    direct: state.direct,
    voice: { feedback: state.voice.feedback, reading: state.voice.reading, trouble: state.voice.trouble, playing: player.playing, played: player.played, problem: player.problem },
    immersive: scene.immersive,
    keyboardOpen: state.keyboardOpen,
    surfaces: [...scene.surfaces.keys()],
  };
};
window.viewTest = {
  text: id => terminalLines(plain(state.texts.get(id) ?? '')),
  feed: samples => mic.feed(Float32Array.from(samples)),
  fakeMic: refuse => {
    openSource = async () => {
      if (refuse) { const e = new Error('Permission denied'); e.name = 'NotAllowedError'; throw e; }
      return { close() { /* nothing to release */ } };
    };
  },
  worldPoint: (id, x, y) => scene.worldPoint(id, x, y),
  region: (surface, id) => {
    const r = regions.get(surface)?.find(x => x.id === id);
    const c = canvases.get(surface);
    return r && c ? { x: (r.x + r.w / 2) / c.width, y: (r.y + r.h / 2) / c.height } : null;
  },
};

render();
// A canvas draws with the page's own fonts only once they have loaded: draw everything again then.
void Promise.all(['400 16px "JetBrains Mono"', '700 16px "JetBrains Mono"', '400 16px Inter', '600 16px Inter'].map(f => document.fonts.load(f)))
  .then(() => { resetFonts(); drawn.clear(); render(); }, () => undefined);
void link.connect();
// Create the hidden keyboard input at page load so tests can find it immediately.
getOrCreateKeyboardInput();
