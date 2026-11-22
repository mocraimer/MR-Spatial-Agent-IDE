/**
 * The page: holds what the bridge reported, draws the shelf, and turns hands, controllers, keys
 * and speech into the actions in `shared/actions.ts`. The link is `link.ts`, where things sit is
 * `layout.ts`, drawing is `panels.ts`, the room is `scene.ts`, the microphone is `mic.ts`.
 */
import { plain } from '../shared/ansi.js';
import { command, COMMANDS, type PageAction } from '../shared/actions.js';
import { parseUtterance, type BridgeEvent, type PendingClose, type Session, type Shelf, type SpeechState, type Utterance } from '../shared/messages.js';
import type { ViewState } from '../shared/view-state.js';
import { arrange, columnFit, CHIP_ARC, FRONT_DISTANCE, FRONT_WIDTH, FRONT_Y, ARC, TOP, type Closed } from './layout.js';
import { BridgeLink } from './link.js';
import { Mic, openMicrophone, type Captured, type OpenSource } from './mic.js';
import {
  CONTROLS_SIZE, LINE_PX, drawChip, drawControls, drawTalk, TALK_SIZE, type TalkPhase, drawFront, drawStrip, drawTile, EMPTY_FRONT, FRONT_SIZE, NO_SESSIONS, frontRows, lightOf, regionAt, resetFonts, terminalLines, tileRows, type ControlButton, type Region, type StripState,
} from './panels.js';
import { onArc, Scene, type Hit, type Pointer, type Rect } from './scene.js';

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
  speech: { ready: false, reason: 'Connecting to the PC…' } as SpeechState,
  scroll: 0,
  scale: 1,
};

const NOTICE_MS = 6000;
const CLOSED_MS = 6000;
const SCROLL_STEP = 10;
/** Transcribing and carrying out one utterance takes well under this. */
const UTTERANCE_TIMEOUT_MS = 20_000;

const canvas = document.getElementById('scene') as HTMLCanvasElement;
const scene = new Scene(canvas, {
  pointer,
  scroll: rows => scrollBy(rows),
  draggable: surface => surface === 'front',
  // The text follows the hand: dragging down brings older lines into view.
  drag: (surface, dy) => { if (surface === 'front') scrollBy(dy / LINE_PX); },
  frame: () => { if (renderWanted) { renderWanted = false; renderNow(); } },
  target: hit => targetRect(hit),
});
let openSource: OpenSource = openMicrophone;
const mic = new Mic(src => openSource(src), () => state.shelf?.focusedId ?? null, sendUtterance, render);
const link = new BridgeLink(apply, render);

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
    case 'speech': state.speech = event.speech; break;
    case 'page': if (isPageAction(event.action)) runPage(event.action); break;
    default: return assertNever(event);
  }
  render();
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

function runPage(action: PageAction): void {
  switch (action) {
    case 'scroll-up': scroll(1); return;
    case 'scroll-down': scroll(-1); return;
    case 'scroll-bottom': state.scroll = 0; scrollExact = 0; break;
    case 'recenter': scene.recenter(); notice('Shelf recentred in front of you.'); break;
    case 'listening-off': stopListening(); break;
    case 'mode-hold': stopListening(); mic.setMode('hold'); notice('Hold Talk to speak; tap it to keep listening.'); break;
    case 'mode-switch': mic.setMode('switch'); void mic.switchOn(); notice('Keep listening: tap Talk or say "stop listening" to stop.'); break;
    case 'text-bigger': state.scale = Math.min(1.6, Math.round((state.scale + 0.1) * 10) / 10); break;
    case 'text-smaller': state.scale = Math.max(0.7, Math.round((state.scale - 0.1) * 10) / 10); break;
    case 'exit-mr': void scene.exit(); break;
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
    const query = new URLSearchParams({ id: c.id, ...(c.receiver ? { receiver: c.receiver } : {}) });
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
  if (!target || target === 'talk' || target === 'mic') return;
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
  if (e.target instanceof HTMLInputElement) return;
  if (e.code === 'Backquote' && !e.repeat) { talkStart('key'); e.preventDefault(); return; }
  if (state.confirm && (e.key === 'y' || e.key === 'Y')) void runCommand('confirm');
  if (state.confirm && (e.key === 'n' || e.key === 'N' || e.key === 'Escape')) void runCommand('decline');
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

const EMPTY_SHELF: Shelf = { herdr: { state: 'up' }, projects: [], sessions: [], focusedId: null, overviewId: null, starting: [], failed: [] };

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
  surface('front', JSON.stringify([front, front && state.textVersion.get(front.id), state.scroll, frontStale, empty, placeName]), frontWidth, onArc(0, FRONT_Y, FRONT_DISTANCE), c => {
    state.scroll = drawFront(c, front, placeName, frontText, state.scroll, frontStale, empty);
    // At the top of what the session holds, further scrolling back adds nothing.
    if (scrollExact > state.scroll) scrollExact = state.scroll;
  });
  used.add('front');

  const stripWidth = Math.max(FRONT_WIDTH, frontWidth);
  const strip: StripState = {
    receiver: front?.name ?? null,
    mic: { open: mic.open, opening: mic.isOpening, mode: mic.mode, problem: mic.problem },
    speech: state.speech.ready ? null : state.speech.reason,
    last: state.last,
    pendingHeard: state.hearing > 0,
    notice: state.notice?.text ?? null,
    link: stale && link.state !== 'live' ? 'No link to the PC' : stale ? 'Herdr unavailable' : null,
    confirm: state.confirm,
  };
  surface('strip', JSON.stringify(strip), stripWidth, onArc(0, FRONT_Y + frontHeight / 2 + 0.06, FRONT_DISTANCE), c => { regions.set('strip', drawStrip(c, strip)); });
  used.add('strip');

  // Each inner list is a group: what belongs together sits together.
  const row = (groups: string[][], key: boolean): ControlButton[] => groups.flatMap(ids => ids.map((id, i) => ({ id, label: command(id).label, key, group: i === 0 })));
  const rows: ControlButton[][] = [
    row([['next', 'back'], ['scroll-up', 'scroll-down', 'bottom'], ['smaller', 'bigger', 'recenter'], ['overview'], ['exit']], false),
    row([['enter', 'escape', 'interrupt'], ['up', 'down', 'tab'], ['y', 'n'], ['one', 'two', 'three']], true),
  ];
  // Talk, wide and first under the front session: the way in to speaking.
  const phase: TalkPhase = mic.problem ?? (state.speech.ready ? null : state.speech.reason) ? 'problem'
    : mic.open ? (mic.mode === 'hold' ? 'holding' : 'listening') : mic.isOpening ? 'opening' : 'idle';
  const talkProblem = mic.problem ?? (state.speech.ready ? null : state.speech.reason);
  const talkHeight = stripWidth * TALK_SIZE.h / TALK_SIZE.w;
  const talkY = FRONT_Y - frontHeight / 2 - 0.02 - talkHeight / 2;
  surface('talk', JSON.stringify([phase, talkProblem]), stripWidth, onArc(0, talkY, FRONT_DISTANCE), c => { regions.set('talk', drawTalk(c, phase, talkProblem)); });
  used.add('talk');
  const controlsHeight = stripWidth * CONTROLS_SIZE.h / CONTROLS_SIZE.w;
  rows.forEach((buttons, i) => {
    const id = `controls-${i}`;
    const y = talkY - talkHeight / 2 - 0.012 - controlsHeight / 2 - i * (controlsHeight + 0.008);
    surface(id, JSON.stringify(buttons), stripWidth, onArc(0, y, FRONT_DISTANCE), c => { regions.set(id, drawControls(c, buttons)); });
    used.add(id);
  });

  chipTargets.clear();
  for (const chip of chips) {
    const id = `chip:${chip.projectId}`;
    chipTargets.set(id, chip.overview ? 'overview' : `go:${chip.projectId}`);
    surface(id, JSON.stringify([chip.project, chip.overview, chip.sessions.map(s => [s.agent, s.status])]), chip.width, onArc(chip.angle, chip.y, CHIP_ARC), c => drawChip(c, chip.project, chip.sessions, chip.overview));
    used.add(id);
  }

  for (const column of columns) {
    const { step, width } = columnFit(column.tiles.length);
    column.tiles.forEach((t, i) => {
      const id = `tile:${t.session.id}`;
      const tileStale = t.closed ? 'Closed in Herdr — nothing to do.' : stale ?? agentNote(shelf, t.session);
      const inFront = t.session.id === front?.id;
      surface(id, JSON.stringify([t.n, t.session, inFront, tileStale, inFront ? 0 : state.textVersion.get(t.session.id)]), width, onArc(column.angle, TOP - i * step, ARC), c => {
        drawTile(c, t.n, t.session, state.texts.get(t.session.id), inFront, tileStale);
      });
      used.add(id);
    });
  }
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
    try { await scene.enter(() => { stopListening(); updatePage(); }); scene.recenter(); } catch (error) { enterProblem = `Mixed reality did not start: ${(error as Error).message}`; }
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
    frontText: front ? frontRows(plain(state.texts.get(front.id) ?? ''), state.scroll).rows : [],
    place: place.overview ? { overview: true } : { overview: false, projectId: place.projectId, project: place.project },
    agentNote: shelf ? agentNote(shelf, front)?.replace(/^!/, '') ?? null : null,
    chips: chips.map(c => ({ projectId: c.projectId, project: c.project, overview: c.overview, sessions: c.sessions.map(s => ({ id: s.id, light: lightOf(s) })), angle: c.angle, width: c.width })),
    columns: columns.map(c => ({ projectId: c.projectId, project: c.project, side: c.angle < 0 ? 'left' as const : 'right' as const, width: columnFit(c.tiles.length).width, tiles: c.tiles.map(t => ({ n: t.n, id: t.session.id, name: t.session.name, role: t.session.role, light: lightOf(t.session), closed: t.closed, inFront: t.session.id === front?.id, text: tileRows(plain(state.texts.get(t.session.id) ?? '')) })) })),
    scroll: state.scroll,
    scale: state.scale,
    mic: { mode: mic.mode, open: mic.open, problem: mic.problem },
    speech: state.speech,
    last: state.last,
    hearing: state.hearing,
    notice: state.notice?.text ?? null,
    confirm: state.confirm,
    immersive: scene.immersive,
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
