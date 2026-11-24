/**
 * What the view does, apart from how it is reached: the shelf, the actions, speech routing and
 * the yes before a close. The HTTP server (server.ts) only authenticates and forwards here.
 */
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { claudeSettingsPath, saveDefaults, restoreDefaults } from './claude-settings.js';
import { shelfOrder, type BridgeAction, type Command, type EffortLevel, type KeyName, type ModelName } from '../shared/actions.js';
import { plain } from '../shared/ansi.js';
import { currentProject, type BridgeEvent, type Picker, type Project, type Session, type Shelf, type SpeechState, type Utterance } from '../shared/messages.js';
import { OVERVIEW, type Level, type LevelAgents } from './agents.js';
import { Drafts, typeable } from './drafts.js';
import { classify, type Heard } from './heard.js';
import { HerdrError, type HerdrClient } from './herdr.js';
import type { Mirror } from './mirror.js';
import { Questions } from './question.js';
import { Say } from './say.js';
import { Settings } from './settings.js';
import { feedbackFor, replyPhrase } from './spoken.js';
import { lastReply, TRANSCRIPT_ROOT } from './transcript.js';
import type { Voice } from './tts.js';
import { Mirrors } from './mirrors.js';
import { addProject, folders, loose as squeezed, makeProject, newProjectRoot, projectRoots, takenFolders } from './projects.js';
import type { Frame, Windows } from './windows.js';
import { fitWindow, restoreWindow, newFitState, RESTORE_GRACE_MS, type FitState } from './window-fit.js';
import { FRONT_COLS } from '../shared/front-cols.js';

export interface Transcriber { state(): SpeechState; transcribe(audio: Float32Array): Promise<string> }

type Send = (event: BridgeEvent) => void;
export type CloseAnswer = 'closed' | 'declined' | 'no-answer' | 'unknown-session' | 'ambiguous' | 'busy' | 'failed';

/** How long a close waits for the owner's answer before it lapses. */
export const CLOSE_ANSWER_MS = 120_000;
/** How long a command heard while listening is off waits for its "yes". */
export const STANDBY_ANSWER_MS = 15_000;
export interface BridgeOptions {
  closeAnswerMs?: number | undefined;
  standbyAnswerMs?: number | undefined;
  /** Where the view's log lines go. Lines name sessions and say what happened; they never hold speech or session text. */
  log?: (line: string) => void;
  /** The owner's settings; by default in memory, with direct sending off. */
  settings?: Settings;
  /** The voice that makes spoken answers; by default none, and the bridge speaks nothing. */
  voice?: Voice;
  /** Where Claude Code's transcripts are, for reading a reply aloud. */
  transcripts?: string;
  /** How long a model or effort command waits for the session to show it took effect. */
  confirmMs?: number;
  /** The Claude Code session id of a pane, for finding its transcript; by default Herdr is asked. */
  sessionOf?: (paneId: string) => Promise<string | null>;
  /** How long a list to pick from stays open without use (tests make it short). */
  pickerIdleMs?: number | undefined;
  /** The window mirrors; without them, the PC's windows are not offered. */
  mirrors?: Mirrors | undefined;
  /**
   * Path to the Claude Code settings file. Used to restore the owner's default model and effort
   * after /model or /effort. Tests use a temp file. Defaults to ~/.claude/settings.json (or
   * CLAUDE_CONFIG_DIR). Pass null to skip the restore entirely (no settings file available).
   */
  claudeSettingsPath?: string | null;
}
/** What a command came to; `silent` marks one whose own speech is the answer. */
type Result = { ok: boolean; outcome: string; silent?: true; say?: string };
/** Words a session prints when it takes a model or effort command. */
const CONFIRMATION = { model: /(?:Set model to|Kept model as) [^\n]*/g, effort: /Set effort level to [^\n]*/g } as const;
/**
 * Builds the outcome for a /model or /effort command from the session's raw confirmation line.
 * Drops the "saved as your default" clause so the owner hears only what changed in this session.
 * Appends a note about the default for new sessions (kept, or may have changed on error).
 *
 * Real Claude Code examples:
 *   model: "Set model to Sonnet 4.6 and saved as your default for new sessions"
 *   effort: "Set effort level to high (saved as your default for new sessions): Comprehensive…"
 *   effort: "Set effort level to high (this session only): ready"
 */
function settingOutcome(what: 'model' | 'effort', rawLine: string, restoreError: string | null): string {
  let sessionPart: string;
  if (what === 'model') {
    // "Set model to <name> and saved as…" → "Set model to <name> in this session."
    // "Kept model as <name>" → "Model <name> was already set in this session."
    const kept = /^Kept model as (.+)$/.exec(rawLine.trim());
    if (kept) {
      sessionPart = `Model ${kept[1]!.trim()} was already set in this session.`;
    } else {
      const m = /^Set model to (.+?) (?:and |in )/.exec(rawLine.trim()) ?? /^Set model to (.+)$/.exec(rawLine.trim());
      const name = m ? m[1]!.trim() : rawLine.trim();
      sessionPart = `Set model to ${name} in this session.`;
    }
  } else {
    // "Set effort level to <level> (saved as…): …" or "Set effort level to <level> (this session only): …"
    const m = /^Set effort level to ([^\s(]+)/.exec(rawLine.trim());
    const level = m ? m[1]!.trim() : rawLine.trim();
    sessionPart = `Set effort level to ${level} in this session.`;
  }
  if (restoreError) return `${sessionPart} The default for new sessions may have changed: ${restoreError}`;
  return `${sessionPart} Your default for new sessions was kept.`;
}
/** How long after a turn ends the transcript is read, so its last line is written. */
const SETTLE_MS = 400;
/** Where no window helper is set up: every request says so. */
const NO_WINDOWS: Windows = {
  list: () => Promise.reject(new Error('Window mirrors are not set up in this view.')),
  capture: () => Promise.reject(new Error('Window mirrors are not set up in this view.')),
  stop: () => Promise.resolve(),
  input: () => Promise.reject(new Error('Window mirrors are not set up in this view.')),
  open: () => Promise.reject(new Error('Window mirrors are not set up in this view.')),
  findWindow: () => Promise.reject(new Error('Window mirrors are not set up in this view.')),
  getRect: () => Promise.reject(new Error('Window mirrors are not set up in this view.')),
  setRect: () => Promise.reject(new Error('Window mirrors are not set up in this view.')),
  maximize: () => Promise.reject(new Error('Window mirrors are not set up in this view.')),
  listen: () => undefined,
  close: () => undefined,
};
const UTTERANCES_KEPT = 200;
/** Items on one page of a list to pick from. */
export const PICKER_PAGE = 12;
/** A list left open this long closes by itself, so it does not go on taking speech as a filter. */
export const PICKER_IDLE_MS = 180_000;
/** The session in front gets a window's picture this often at most; other mirrors' tiles less often. */
const FRONT_FRAME_MS = 66;
/** How long after /model or /effort confirmation to keep watching for delayed settings writes. */
const RESTORE_WATCH_MS = 4_000;
/** How often to check whether the front pane width changed while in mixed reality. */
const LAYOUT_POLL_MS = 2_000;
/** Lower bound for pane-width polling: re-fit when below this. */
const MIN_FIT_COLS_POLL = FRONT_COLS - 4; // 116 when FRONT_COLS=120
const TILE_FRAME_MS = 1000;

type PickerEntry = { kind: 'windows'; label: string; detail: string; hwnd: number } | { kind: 'folders'; label: string; detail: string; path: string };
interface PickerState { kind: Picker['kind']; filter: string; page: number; entries: PickerEntry[]; timer: NodeJS.Timeout }


export class Bridge {
  private readonly clients = new Set<Send>();
  /** Unique id for this bridge instance; the page uses it to detect a restart. */
  readonly instanceId = randomUUID();
  /** Where "back" returns to, and the session the last jump brought to the front. */
  private jump: { origin: string; current: string } | null = null;
  /** The one question that waits for the owner's yes: a close, or a command heard while listening is off. */
  private readonly questions: Questions;
  private readonly heard = new Map<string, Promise<Utterance>>();
  private queue: Promise<unknown> = Promise.resolve();
  private readonly closeAnswerMs: number;
  private readonly standbyAnswerMs: number;
  private readonly log: (line: string) => void;
  private readonly settings: Settings;
  private readonly drafts = new Drafts();
  /** Null when the bridge has no voice: it then speaks nothing and says nothing about it. */
  private readonly say: Say | null;
  private readonly transcripts: string;
  private readonly confirmMs: number;
  private readonly sessionOf: (paneId: string) => Promise<string | null>;
  /** Each session's last state, to see a turn end; and the last reply read aloud for each, so one is read once. */
  private readonly states = new Map<string, string>();
  private readonly read = new Map<string, string>();
  /** The level agents' starts as last logged, so each change is logged once. */
  private logged = { starting: new Set<string>(), failed: new Map<string, string>() };
  private picker: PickerState | null = null;
  /** Each mirror's latest picture, when it was last sent, and a later send waiting for its turn. */
  private readonly frames = new Map<string, { frame: Frame; sent: number; timer: NodeJS.Timeout | null }>();
  /** What each mirror session last said in place of its picture. */
  private readonly notes = new Map<string, string | null>();
  private readonly noteTimer: NodeJS.Timeout;
  private readonly mirrors: Mirrors;
  private readonly pickerIdleMs: number;
  /** Path to the Claude Code settings file for restoring model/effort defaults; null to skip. */
  private readonly settingsFilePath: string | null;
  /** State for the terminal window fitting (Deliverable 1). */
  private readonly fitState: FitState = newFitState();
  /** Timer that restores the terminal window after all pages leave mixed reality. */
  private restoreTimer: NodeJS.Timeout | null = null;
  /** Pages currently in mixed reality, by per-connection pageId. */
  private readonly mrPages = new Set<string>();
  /** The last focused session id during a fit session, so re-fits happen on change. */
  private lastFitFocusId: string | null = null;
  /** Serialization: the pending fit promise (newer call supersedes an in-flight one). */
  private fitSeq = 0;
  /** Interval timer that polls front-pane width while in mixed reality to catch layout changes. */
  private layoutPollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly herdr: HerdrClient,
    private readonly mirror: Mirror,
    private readonly speech: Transcriber,
    private readonly agents: LevelAgents,
    options: BridgeOptions = {},
  ) {
    this.closeAnswerMs = options.closeAnswerMs ?? CLOSE_ANSWER_MS;
    this.standbyAnswerMs = options.standbyAnswerMs ?? STANDBY_ANSWER_MS;
    this.questions = new Questions(() => this.broadcastQuestion());
    this.log = options.log ?? (() => undefined);
    this.settings = options.settings ?? new Settings();
    this.transcripts = options.transcripts ?? TRANSCRIPT_ROOT;
    this.confirmMs = options.confirmMs ?? 2500;
    this.sessionOf = options.sessionOf ?? (paneId => this.herdrSessionOf(paneId));
    this.say = options.voice ? new Say(options.voice, event => this.broadcast(event), text => this.broadcast({ type: 'notice', text }), this.log, () => this.announceVoice()) : null;
    this.mirrors = options.mirrors ?? new Mirrors(herdr, NO_WINDOWS, '');
    this.settingsFilePath = options.claudeSettingsPath !== undefined ? options.claudeSettingsPath : claudeSettingsPath();
    this.pickerIdleMs = options.pickerIdleMs ?? PICKER_IDLE_MS;
    agents.onChange(() => { this.logAgentStarts(); this.broadcast({ type: 'shelf', shelf: this.shelf() }); });
    mirror.listen({
      shelf: shelf => {
        if (this.jump && shelf.focusedId !== this.jump.current) this.jump = null;
        this.drafts.prune(new Set(shelf.sessions.map(x => x.id)));
        this.watchTurns(shelf);
        this.mirrors.sweep(new Set(shelf.sessions.map(s => s.id)));
        for (const id of [...this.frames.keys()]) if (!shelf.sessions.some(s => s.id === id)) { const f = this.frames.get(id); if (f?.timer) clearTimeout(f.timer); this.frames.delete(id); }
        this.broadcast({ type: 'shelf', shelf: this.shelf() });
        this.refreshNotes();
        // B.1: Re-fit when the focused session changes while in MR.
        if (this.mrPages.size > 0 && shelf.focusedId !== this.lastFitFocusId) {
          this.lastFitFocusId = shelf.focusedId ?? null;
          void this.doFit().catch(() => undefined);
        }
      },
      text: (id, text) => this.broadcast({ type: 'text', id, text }),
    });
    this.mirrors.listen({
      frame: (id, frame) => this.frame(id, frame),
      problem: () => this.refreshNotes(),
      notice: text => this.broadcast({ type: 'notice', text }),
    });
    // A new mirror that never attaches says so once its time is up.
    this.noteTimer = setInterval(() => this.refreshNotes(), 3000);
    this.noteTimer.unref();
  }

  /** Clears the bridge's own timers. The view stops the mirror and the window mirrors itself. */
  stop(): void {
    clearInterval(this.noteTimer);
    if (this.picker) clearTimeout(this.picker.timer);
    for (const f of this.frames.values()) if (f.timer) clearTimeout(f.timer);
  }

  /** Herdr's sessions as the mirror holds them, with which level agents are starting or failed. */
  shelf(): Shelf {
    const shelf = this.mirror.shelf();
    const pending = this.agents.pending();
    // A start that failed only because the agent asked something is over once Herdr sees the agent running.
    const running = new Set(shelf.sessions.filter(s => s.agent !== null).map(s => s.id));
    return { ...shelf, starting: pending.starting, failed: pending.failed.filter(f => !running.has(f.id)), drafts: this.drafts.ids() };
  }

  /** Adds a page. It first gets everything it needs to draw, then each change. */
  connect(send: Send): () => void {
    const pageId = randomUUID();
    send({ type: 'instance', id: this.instanceId, pageId });
    const shelf = this.shelf();
    send({ type: 'shelf', shelf });
    for (const s of shelf.sessions) { const text = this.mirror.text(s.id); if (text !== undefined) send({ type: 'text', id: s.id, text }); }
    send({ type: 'confirm', pending: this.questions.closeView() });
    send({ type: 'ask', ask: this.questions.commandView() });
    send({ type: 'direct', on: this.settings.direct });
    send({ type: 'voice', feedback: this.settings.voice, reading: this.settings.readReplies, trouble: this.say?.failed ?? false });
    send({ type: 'speech', speech: this.speech.state() });
    send({ type: 'picker', picker: this.pickerView() });
    for (const s of shelf.sessions.filter(x => x.window)) {
      send({ type: 'window', id: s.id, note: this.mirrors.note(s.id) });
      const f = this.frames.get(s.id);
      if (f) send({ type: 'frame', id: s.id, w: f.frame.w, h: f.frame.h, mime: f.frame.mime, data: f.frame.data });
    }
    this.clients.add(send);
    return () => {
      this.clients.delete(send);
      // A page that disconnects without calling /api/mr false may have crashed: give it a grace
      // period (RESTORE_GRACE_MS) in case the XR session reconnects before restoring the window.
      if (this.mrPages.delete(pageId) && this.mrPages.size === 0) {
        this.stopLayoutPoll();
        this.scheduleMrRestore();
      }
    };
  }

  broadcast(event: BridgeEvent): void { for (const send of this.clients) send(event); }

  /**
   * Called by the server when a page enters or leaves mixed reality. Tracks per-page MR state.
   * Fits while any page is in MR; restores when none are.
   * Explicit leave (/api/mr false) restores promptly; a disconnect (page gone without leaving) uses
   * a grace period in case the XR session reconnects.
   * Re-entering within grace period cancels any pending restore.
   * Re-fits when the focused session changes while in MR; also polls for layout changes every 2 s.
   */
  setMixedReality(pageId: string, inMR: boolean): void {
    if (inMR) {
      const wasInMR = this.mrPages.size > 0;
      this.mrPages.add(pageId);
      // Cancel any pending restore.
      if (this.restoreTimer) { clearTimeout(this.restoreTimer); this.restoreTimer = null; }
      void this.doFit().catch(() => undefined);
      if (!wasInMR) {
        this.lastFitFocusId = this.shelf().focusedId ?? null;
        this.startLayoutPoll();
      }
    } else {
      this.mrPages.delete(pageId);
      if (this.mrPages.size === 0) {
        this.stopLayoutPoll();
        // Explicit leave: restore promptly (no grace period needed).
        if (this.restoreTimer) { clearTimeout(this.restoreTimer); this.restoreTimer = null; }
        this.lastFitFocusId = null;
        void restoreWindow(this.fitState, { log: this.log, windows: this.mirrors.windowHelper() }).catch(() => undefined);
      }
    }
  }

  /** Schedules a window restore after the grace period (used when a page disconnects without leaving). */
  private scheduleMrRestore(): void {
    if (this.restoreTimer) clearTimeout(this.restoreTimer);
    this.restoreTimer = setTimeout(() => {
      this.restoreTimer = null;
      this.lastFitFocusId = null;
      void restoreWindow(this.fitState, { log: this.log, windows: this.mirrors.windowHelper() }).catch(() => undefined);
    }, RESTORE_GRACE_MS);
    this.restoreTimer.unref();
  }

  /**
   * Starts a periodic timer that polls the front pane's column width every LAYOUT_POLL_MS.
   * When the width is outside the fit range (> FRONT_COLS or < MIN_FIT_COLS_POLL), re-fits.
   * This catches layout changes that the focus-change listener does not cover (e.g. tab splits).
   */
  private startLayoutPoll(): void {
    if (this.layoutPollTimer) return; // already running
    this.layoutPollTimer = setInterval(() => {
      if (this.mrPages.size === 0) { this.stopLayoutPoll(); return; }
      const shelf = this.shelf();
      const front = shelf.sessions.find(s => s.id === shelf.focusedId);
      if (!front) return;
      void this.herdr.call('pane.layout', { pane_id: front.id }).then(layout => {
        const panes = (layout.layout as { panes?: { pane_id?: unknown; rect?: { width?: unknown } }[] } | undefined)?.panes ?? [];
        const rect = panes.find(p => p.pane_id === front.id)?.rect;
        const cols = typeof rect?.width === 'number' ? rect.width : null;
        if (cols !== null && (cols > FRONT_COLS || cols < MIN_FIT_COLS_POLL)) {
          void this.doFit().catch(() => undefined);
        }
      }).catch(() => undefined);
    }, LAYOUT_POLL_MS);
    if (this.layoutPollTimer.unref) this.layoutPollTimer.unref();
  }

  /** Stops the layout-change polling timer. */
  private stopLayoutPoll(): void {
    if (this.layoutPollTimer) { clearInterval(this.layoutPollTimer); this.layoutPollTimer = null; }
  }

  /**
   * Runs a window fit for the current focused session. Serialized: each call gets a sequence
   * number; the promise abandons work if superseded by a newer call.
   */
  private async doFit(): Promise<void> {
    if (this.mrPages.size === 0) return;
    const seq = ++this.fitSeq;
    const shelf = this.shelf();
    const front = shelf.sessions.find(s => s.id === shelf.focusedId);
    if (!front) return;
    if (seq !== this.fitSeq) return; // Superseded.
    const workspaceLabel = shelf.projects.find(p => p.id === front.workspaceId)?.label ?? '';
    const notice = (text: string) => this.broadcast({ type: 'notice', text });
    await fitWindow(front.id, workspaceLabel, this.fitState, { log: this.log, notice, herdr: this.herdr, windows: this.mirrors.windowHelper() });
  }

  /** The audio of a spoken phrase, for the page to fetch. */
  clip(id: string): Buffer | undefined { return this.say?.clip(id); }

  /** Carries out one action; the answer is what to tell the owner. */
  async act(action: BridgeAction): Promise<Result> {
    const shelf = this.shelf();
    try {
      switch (action.kind) {
        case 'focus': {
          const s = shelf.sessions.find(x => x.id === action.sessionId);
          if (!s) return { ok: false, outcome: 'That session is no longer open.' };
          await this.focus(s.id);
          return { ok: true, outcome: `Showing ${s.name}` };
        }
        case 'next-waiting': return await this.nextWaiting(shelf);
        case 'back': {
          if (!this.jump) return { ok: false, outcome: 'Nothing to go back to: "back" returns after "next waiting".' };
          const origin = this.jump.origin;
          if (!shelf.sessions.some(s => s.id === origin)) { this.jump = null; return { ok: false, outcome: 'The session you came from has closed.' }; }
          // Kept until the focus lands, so a failed "back" can be said again.
          await this.focus(origin);
          this.jump = null;
          return { ok: true, outcome: `Back to ${name(shelf, origin)}` };
        }
        case 'key': return await this.key(shelf, shelf.focusedId, action.key);
        case 'send': return await this.sendDraft(shelf, shelf.focusedId);
        case 'scratch': return await this.scratchDraft(shelf, shelf.focusedId);
        case 'direct': return this.setDirect(action.on);
        case 'model': return await this.typeSetting(shelf, shelf.focusedId, 'model', action.name);
        case 'effort': return await this.typeSetting(shelf, shelf.focusedId, 'effort', action.level);
        case 'voice': return this.setVoice(action.on);
        case 'read-replies': return this.setReading(action.on);
        case 'read-last': return await this.readLast(shelf, shelf.focusedId);
        case 'voice-stop': this.say?.stop(); return { ok: true, outcome: 'The voice is stopped.', silent: true };
        case 'answer': return await this.answer(action.answer);
        case 'go': {
          if (action.projectId === shelf.overviewId) return await this.goTo(OVERVIEW, 'the overview', 'The helper');
          const project = shelf.projects.find(p => p.id === action.projectId);
          if (!project) return { ok: false, outcome: 'That project is no longer open.' };
          return await this.goTo({ project: project.id }, project.label, `${project.label}'s agent`);
        }
        case 'overview': return await this.goTo(OVERVIEW, 'the overview', 'The helper');
        case 'picker': return await this.openPicker(shelf, action.list);
        case 'picker-cancel': {
          if (!this.picker) return { ok: false, outcome: 'No list is open.' };
          this.closePicker();
          return { ok: true, outcome: 'List closed; nothing was made.' };
        }
        case 'picker-page': {
          if (!this.picker) return { ok: false, outcome: 'No list is open.' };
          const pages = Math.max(1, Math.ceil(this.filtered().length / PICKER_PAGE));
          const page = this.picker.page + action.delta;
          if (page < 0 || page >= pages) return { ok: false, outcome: action.delta > 0 ? 'This is the last page.' : 'This is the first page.' };
          this.picker.page = page;
          this.touchPicker();
          return { ok: true, outcome: `Page ${page + 1} of ${pages}` };
        }
        case 'picker-make': return await this.makeFromPicker(null);
        case 'pick': return await this.pick(shelf, action.n);
        case 'window-input': {
          const s = shelf.sessions.find(x => x.id === action.sessionId);
          if (!s?.window) return { ok: false, outcome: 'That session is not a window mirror.' };
          const problem = await this.mirrors.input(s.id, action.events);
          return problem ? { ok: false, outcome: problem } : { ok: true, outcome: action.events[0]?.type === 'wheel' ? `Scrolled ${s.name}` : `Clicked in ${s.name}` };
        }
        case 'type-text': return await this.typeText(shelf, shelf.focusedId, action.text);
        default: return assertNever(action);
      }
    } catch (error) {
      return { ok: false, outcome: this.problem(`the ${action.kind} action`, error) };
    }
  }

  /**
   * One utterance, transcribed and carried out in arrival order. `receiver` is the session that
   * was in front when the speech began; a prompt goes there even if focus has moved since.
   * `standby` marks speech heard while listening is off: only commands are acted on, each after the
   * owner's yes. The same id twice (a page retrying after a dropped link) is carried out once.
   */
  utterance(id: string, audio: Float32Array, receiver: string | null, standby = false): Promise<Utterance> {
    const known = this.heard.get(id);
    if (known) return known;
    const done = this.queue.then(() => this.handle(id, audio, receiver, standby));
    this.queue = done.catch(() => undefined);
    this.heard.set(id, done);
    if (this.heard.size > UTTERANCES_KEPT) this.heard.delete(this.heard.keys().next().value as string);
    return done;
  }

  private async handle(id: string, audio: Float32Array, receiver: string | null, standby: boolean): Promise<Utterance> {
    const record = (heard: string, done: Done): Utterance => {
      const u: Utterance = { id, heard, as: done.as, ok: done.ok, outcome: done.outcome };
      this.broadcast({ type: 'utterance', utterance: u });
      if (!done.silent) this.speak(feedbackFor(done.as, done.ok, done.say ?? done.outcome));
      return u;
    };
    const speech = this.speech.state();
    if (!speech.ready) return record('', { as: 'nothing', ok: false, outcome: speech.reason });
    let heard: string;
    try { heard = (await this.speech.transcribe(audio)).trim(); } catch (error) {
      return record('', { as: 'nothing', ok: false, outcome: `Speech could not be read: ${(error as Error).message}` });
    }
    const shelf = this.shelf();
    const taken = classify(heard, this.questions.waiting, this.picker !== null);
    // A command waiting for its yes is dropped by anything the owner says but a yes or a no. Noise that came to no words is not something said.
    if (this.questions.kind === 'command' && taken.as !== 'nothing' && !(taken.as === 'command' && taken.command.whenConfirming)) this.dropCommand('something else was said instead');
    return record(heard, standby ? await this.inStandby(taken, heard, shelf, receiver) : await this.execute(taken, heard, shelf, receiver));
  }

  /** What an utterance does: the whole of it, when the owner is listening. */
  private async execute(taken: Heard, heard: string, shelf: Shelf, receiver: string | null): Promise<Done> {
    switch (taken.as) {
      case 'nothing': return { as: 'nothing', ok: false, outcome: 'Heard nothing to act on.' };
      case 'command': {
        if ('page' in taken.command.run) {
          this.broadcast({ type: 'page', action: taken.command.run.page });
          return { as: 'command', ok: true, outcome: taken.command.label };
        }
        const run = taken.command.run.bridge;
        // A spoken key, "go" or "scratch that" belongs to its utterance: like a prompt, it acts on the
        // session that was in front when the speech began, not whichever is in front once it is heard.
        const r = run.kind === 'key' || run.kind === 'send' || run.kind === 'scratch' || run.kind === 'model' || run.kind === 'effort' ? await this.spokenAt(shelf, receiver, run) : await this.act(run);
        return { as: 'command', ...r };
      }
      case 'go': case 'show': {
        const way = navigation(taken, shelf);
        // "show me the failing test" names no session: it is a prompt.
        if (way === null) return await this.deliver(heard, shelf, receiver);
        if ('done' in way) return way.done;
        return { as: 'command', ...await this.act(way.action) };
      }
      case 'helper': {
        try {
          const seat = await this.agents.seat(OVERVIEW);
          if (seat.state === 'ready') { await this.order(seat.paneId, taken.order); return { as: 'helper', ok: true, outcome: this.settings.direct ? 'Sent to the helper' : HELPER_DRAFT }; }
          // The helper is starting: the order waits for it beside this queue, so speech goes on.
          void this.agents.ready(seat.paneId)
            .then(() => this.inOrder(() => this.order(seat.paneId, taken.order)))
            .then(
              () => this.broadcast({ type: 'notice', text: this.settings.direct ? `The helper is ready and got your order: "${taken.order}"` : `The helper is ready. Your order waits as a draft: ${HELPER_DRAFT_HOW}` }),
              (error: unknown) => this.broadcast({ type: 'notice', text: `The helper did not get "${taken.order}": ${error instanceof RefusedError ? error.message : this.problem('an order to the helper', error)}` }),
            );
          return { as: 'helper', ok: true, outcome: 'The helper is starting; your order goes to it when it is ready' };
        } catch (error) { return { as: 'helper', ok: false, outcome: `The helper did not get it: ${error instanceof RefusedError ? error.message : this.problem('an order to the helper', error)}` }; }
      }
      case 'prompt': return await this.deliver(heard, shelf, receiver);
      case 'pick': return { as: 'command', ...await this.pick(this.shelf(), taken.n) };
      case 'make': return { as: 'command', ...await this.makeFromPicker(taken.name) };
      case 'filter': {
        if (!this.picker) return await this.deliver(heard, shelf, receiver);
        this.picker.filter = taken.text;
        this.picker.page = 0;
        this.touchPicker();
        const n = this.filtered().length;
        return { as: 'command', ok: true, outcome: n === 0 ? `Nothing in the list matches "${taken.text}"` : `The list shows what matches "${taken.text}" (${n})` };
      }
      default: return assertNever(taken);
    }
  }

  /**
   * An utterance heard while listening is off. Nothing is ever sent to a session from here: a
   * prompt or an order is shown as ignored; a command that only changes the view runs at once;
   * every other command is asked as a question and done only after the owner's "yes".
   */
  private async inStandby(taken: Heard, heard: string, shelf: Shelf, receiver: string | null): Promise<Done> {
    switch (taken.as) {
      case 'nothing': return await this.execute(taken, heard, shelf, receiver);
      case 'helper': case 'prompt': return IGNORED;
      // While listening is off a list is not narrowed; picking or making asks first, like any command.
      case 'filter': return IGNORED;
      case 'pick': return this.ask(`Pick ${taken.n} from the list`, () => this.pick(this.shelf(), taken.n));
      case 'make': return this.ask(`Make a new project called ${taken.name}`, () => this.makeFromPicker(taken.name));
      case 'command': {
        const c = taken.command;
        // A yes or a no answers the question that waits; a view-only command changes nothing but the view.
        if (c.whenConfirming || c.viewOnly) return await this.execute(taken, heard, shelf, receiver);
        return this.ask(this.does(c, shelf, receiver), () => this.execute(taken, heard, this.shelf(), receiver));
      }
      case 'go': case 'show': {
        const way = navigation(taken, shelf);
        if (way === null) return IGNORED;
        if ('done' in way) return way.done;
        return this.ask(way.label, () => this.act(way.action));
      }
      default: return assertNever(taken);
    }
  }

  /** What a command does, for the question: a key or "go" names the session it will act on. */
  private does(c: Command, shelf: Shelf, receiver: string | null): string {
    const what = c.does ?? c.label;
    const run = 'bridge' in c.run ? c.run.bridge : null;
    return run && (run.kind === 'key' || run.kind === 'send' || run.kind === 'scratch' || run.kind === 'model' || run.kind === 'effort') ? `${what} in ${receiver ? name(shelf, receiver) : 'the session in front'}` : what;
  }

  /** Puts a command to the owner as a question; it is done only on their "yes". */
  private ask(label: string, run: () => Promise<Result>): Done {
    const asked = this.questions.put({ kind: 'command', label, run }, this.standbyAnswerMs, () => {
      this.log(`standby command "${label}" dropped: no answer in time`);
      this.broadcast({ type: 'notice', text: `Dropped: ${label}. There was no yes in time.` });
    });
    if (!asked) return { as: 'command', ok: false, outcome: 'A close is waiting for your yes or no first. Nothing was done.' };
    this.log(`standby command "${label}" asked of the owner`);
    return { as: 'command', ok: true, outcome: `Do “${label}”? Say “yes” or “no”.` };
  }

  private dropCommand(why: string): void {
    const dropped = this.questions.take();
    if (dropped?.kind !== 'command') return;
    this.log(`standby command "${dropped.label}" dropped: ${why}`);
    this.broadcast({ type: 'notice', text: `Dropped: ${dropped.label}.` });
  }

  /** The owner's yes or no to the one question that waits. */
  private async answer(yes: boolean): Promise<Result> {
    const q = this.questions.take();
    if (!q) return { ok: false, outcome: 'Nothing is waiting for your yes or no.' };
    if (q.kind === 'close') {
      q.settle(yes);
      return { ok: true, outcome: yes ? `Answered yes to closing ${q.name}.` : `Answered no: ${q.name} stays open.` };
    }
    // The only other kind: a command heard on standby.
    if (!yes) {
      this.log(`standby command "${q.label}" dropped: the owner said no`);
      return { ok: true, outcome: `Answered no: “${q.label}” was not done.` };
    }
    this.log(`standby command "${q.label}" confirmed by the owner`);
    const r = await q.run();
    // What is said is what the command came to, not the owner's own yes read back.
    return { ok: r.ok, outcome: `Answered yes: ${q.label}. ${r.outcome}`, ...(r.silent ? { silent: true as const } : { say: r.outcome }) };
  }

  private async deliver(heard: string, shelf: Shelf, receiver: string | null): Promise<Done> {
    const done = (ok: boolean, outcome: string): Done => ({ as: 'prompt', ok, outcome });
    if (receiver === null) return done(false, 'Not sent: no session was in front when you started speaking.');
    const target = shelf.sessions.find(s => s.id === receiver);
    if (!target) return done(false, 'Not sent: the session that was in front when you spoke has closed.');
    const unready = notReady(shelf, target);
    if (unready) return done(false, `Not sent: ${unready}`);
    if (this.settings.direct) {
      try { await this.prompt(target, heard); } catch (error) { return done(false, `Not sent to ${target.name}: ${this.problem(`a prompt to ${target.name} (${target.id})`, error)}`); }
      return done(true, `Sent to ${target.name}`);
    }
    try { await this.typeInto(target.id, heard); } catch (error) {
      return done(false, `Not typed into ${target.name}: ${error instanceof RefusedError ? error.message : this.problem(`typing into ${target.name} (${target.id})`, error)}`);
    }
    return done(true, `Draft in ${target.name}. Say “go” to send it, or “scratch that” to clear it.`);
  }

  /**
   * The helper asks to close a session. Nothing closes until the owner says yes to that named
   * session; no answer, or a no, leaves it open.
   */
  async requestClose(ref: string): Promise<CloseAnswer> {
    const shelf = this.shelf();
    // A close names exactly one session: by pane id, tile number or a name no other session has.
    const found = matches(shelf, ref, false);
    if (found.length > 1) return 'ambiguous';
    const target = found[0];
    if (!target) return 'unknown-session';
    const n = shelfOrder(shelf.projects, shelf.sessions).indexOf(target) + 1;
    const project = shelf.projects.find(p => p.id === target.workspaceId)?.label ?? '';
    const shown = `${n} ${target.name}${project ? ` (${project})` : ''}`;
    if (this.questions.waiting) return 'busy';
    this.log(`close of ${shown} (${target.id}) asked of the owner`);
    this.speak(`Close ${target.name}? Say yes or no.`);
    const answer = await new Promise<'yes' | 'no' | 'no-answer'>(settle => {
      this.questions.put({ kind: 'close', sessionId: target.id, name: shown, settle: yes => settle(yes ? 'yes' : 'no') }, this.closeAnswerMs, () => settle('no-answer'));
    });
    if (answer !== 'yes') {
      this.log(`close of ${shown} (${target.id}): ${answer === 'no' ? 'the owner said no' : 'no answer in time'}; it stays open`);
      this.broadcast({ type: 'notice', text: `${target.name} was not closed.` });
      this.speak(`${target.name} was not closed.`);
      return answer === 'no' ? 'declined' : 'no-answer';
    }
    try { await this.herdr.call('pane.close', { pane_id: target.id }); } catch (error) {
      this.broadcast({ type: 'notice', text: `Could not close ${target.name}: ${this.problem(`the close of ${shown} (${target.id})`, error)}` });
      return 'failed';
    }
    this.log(`closed ${shown} (${target.id}) on the owner's yes`);
    this.broadcast({ type: 'notice', text: `Closed ${target.name}.` });
    this.speak(`Closed ${target.name}.`);
    return 'closed';
  }

  /** Logs a Herdr error on an action, saying which, and returns what to tell the owner. */
  private problem(what: string, error: unknown): string {
    const text = herdrProblem(error);
    this.log(`Herdr refused ${what}: ${text}`);
    return text;
  }

  private seatName(id: string): string { return `${this.agents.describe(id)} (${id})`; }

  /** One log line for each level-agent start that began, finished or failed since the last. */
  private logAgentStarts(): void {
    const now = this.agents.pending();
    const starting = new Set(now.starting);
    for (const id of starting) if (!this.logged.starting.has(id)) this.log(`${this.seatName(id)} is starting`);
    for (const f of now.failed) if (this.logged.failed.get(f.id) !== f.reason) this.log(`${this.seatName(f.id)} did not start: ${f.reason}`);
    for (const id of this.logged.starting) if (!starting.has(id) && !now.failed.some(f => f.id === id)) this.log(`${this.seatName(id)} started`);
    this.logged = { starting, failed: new Map(now.failed.map(f => [f.id, f.reason])) };
  }

  private broadcastQuestion(): void {
    this.broadcast({ type: 'confirm', pending: this.questions.closeView() });
    this.broadcast({ type: 'ask', ask: this.questions.commandView() });
  }

  private async focus(id: string): Promise<void> {
    await this.herdr.call('pane.focus', { pane_id: id });
    await this.mirror.tick();
  }

  private async key(shelf: Shelf, target: string | null, key: KeyName): Promise<Result> {
    if (!target) return { ok: false, outcome: 'No session is in front to receive the key.' };
    const session = shelf.sessions.find(s => s.id === target);
    const unready = session ? notReady(shelf, session) : null;
    if (unready) return { ok: false, outcome: `Not pressed: ${unready}` };
    await this.herdr.call('pane.send_keys', { pane_id: target, keys: [key] });
    return { ok: true, outcome: `Pressed ${key} in ${name(shelf, target)}` };
  }

  private async spokenAt(shelf: Shelf, receiver: string | null, run: { kind: 'key'; key: KeyName } | { kind: 'send' } | { kind: 'scratch' } | { kind: 'model'; name: ModelName } | { kind: 'effort'; level: EffortLevel }): Promise<Result> {
    if (receiver !== null && !shelf.sessions.some(s => s.id === receiver)) return { ok: false, outcome: 'Not done: the session that was in front when you spoke has closed.' };
    try {
      switch (run.kind) {
        case 'key': return await this.key(shelf, receiver, run.key);
        case 'send': return await this.sendDraft(shelf, receiver);
        case 'scratch': return await this.scratchDraft(shelf, receiver);
        case 'model': return await this.typeSetting(shelf, receiver, 'model', run.name);
        case 'effort': return await this.typeSetting(shelf, receiver, 'effort', run.level);
        default: return assertNever(run);
      }
    } catch (error) { return { ok: false, outcome: this.problem(`the ${run.kind === 'key' ? `${run.key} key` : run.kind === 'send' ? '"go"' : run.kind === 'scratch' ? '"scratch that"' : `${run.kind} command`}`, error) }; }
  }

  /** Runs `step` after the utterances already queued, so a held order never interleaves with one being carried out. */
  private inOrder<T>(step: () => Promise<T>): Promise<T> {
    const done = this.queue.then(step);
    this.queue = done.catch(() => undefined);
    return done;
  }

  /** Types raw text from the headset keyboard into the session in front. */
  private async typeText(shelf: Shelf, target: string | null, text: string): Promise<Result> {
    if (!target) return { ok: false, outcome: 'No session is in front to receive the text.' };
    if (!text) return { ok: true, outcome: '', silent: true };
    await this.herdr.call('pane.send_text', { pane_id: target, text });
    return { ok: true, outcome: '', silent: true };
  }

  /** Types spoken words into a session's input after any draft already there, without sending. */
  private async typeInto(id: string, text: string): Promise<void> {
    const typed = typeable(text);
    if (!typed) throw new RefusedError('There was nothing to type.');
    // Typed into an agent that waits on a question, words would be keys answering it.
    if (this.shelf().sessions.find(s => s.id === id)?.status === 'blocked') throw new RefusedError(`it is waiting on a question: answer it with a key first.`);
    // Marked before the call: a second utterance meeting this one sees the draft and adds a space, and
    // a call whose answer is lost may still have typed the words, so they stay a draft to send or clear.
    const piece = this.drafts.has(id) ? ` ${typed}` : typed;
    this.drafts.mark(id);
    this.broadcast({ type: 'shelf', shelf: this.shelf() });
    await this.herdr.call('pane.send_text', { pane_id: id, text: piece });
  }

  /** An order for the helper: typed into its input to wait for "go", or sent at once when direct sending is on. */
  private async order(paneId: string, text: string): Promise<void> {
    if (this.settings.direct) await this.herdr.call('agent.prompt', { target: paneId, text });
    else await this.typeInto(paneId, text);
  }

  /** "go": presses Enter in the session, once, if it holds a draft. */
  private async sendDraft(shelf: Shelf, target: string | null): Promise<Result> {
    if (!target || !this.drafts.has(target)) return { ok: false, outcome: 'No draft waits in the session in front. Nothing was sent.' };
    // Taken before the key goes, so a second "go" at the same moment finds nothing to send.
    this.drafts.clear(target);
    try {
      const r = await this.key(shelf, target, 'enter');
      if (!r.ok) this.drafts.mark(target);
      return r.ok ? { ok: true, outcome: `Sent the draft in ${name(shelf, target)}` } : r;
    } catch (error) { this.drafts.mark(target); throw error; } finally { this.broadcast({ type: 'shelf', shelf: this.shelf() }); }
  }

  /** "scratch that": empties the session's input with Ctrl-U, sending nothing. */
  private async scratchDraft(shelf: Shelf, target: string | null): Promise<Result> {
    if (!target || !this.drafts.has(target)) return { ok: false, outcome: 'No draft waits in the session in front. Nothing was cleared.' };
    // Taken before the key goes, as for "go"; put back if the call fails, so the owner can say it again.
    this.drafts.clear(target);
    try { await this.herdr.call('pane.send_keys', { pane_id: target, keys: ['ctrl+u'] }); } catch (error) { this.drafts.mark(target); throw error; } finally { this.broadcast({ type: 'shelf', shelf: this.shelf() }); }
    return { ok: true, outcome: `Cleared the draft in ${name(shelf, target)}` };
  }

  /** Speaks a phrase when there is one and the owner has the voice on. Returns whether it was queued. */
  private speak(phrase: string | null): boolean {
    if (phrase === null || !this.settings.voice || !this.say) return false;
    return this.say.say(phrase);
  }

  /**
   * Types `/model <name>` or `/effort <level>` into a Claude Code session and restores the
   * owner's defaults for new sessions afterwards. Only a session that is idle or done, with
   * nothing already typed in its input: elsewhere the text would be keys answering a question,
   * a prompt, or a line joined to a draft.
   */
  private async typeSetting(shelf: Shelf, target: string | null, what: 'model' | 'effort', value: ModelName | EffortLevel): Promise<Result> {
    if (!target) return { ok: false, outcome: 'No session is in front to change.' };
    const session = shelf.sessions.find(s => s.id === target);
    if (!session) return { ok: false, outcome: 'Not done: that session has closed.' };
    const refused = settingRefusal(shelf, session, this.drafts.has(session.id));
    if (refused) return { ok: false, outcome: `Not changed: ${refused}` };
    const typed = `/${what} ${value}`;
    const confirmations = (text: string) => plain(text).match(CONFIRMATION[what]) ?? [];
    const before = confirmations(await this.herdr.read(session.id, 30)).length;

    // Save the owner's defaults before the command is typed, so they can be restored afterwards.
    // If the save fails (file unreadable or corrupt), proceed with typing but note it in the outcome.
    let token: ReturnType<typeof saveDefaults> | null = null;
    let saveError: string | null = null;
    if (this.settingsFilePath) {
      try { token = saveDefaults(this.settingsFilePath); }
      catch (error) {
        saveError = (error as Error).message;
        this.log(`could not read ${this.settingsFilePath} before ${typed}: ${saveError}`);
      }
    }

    await this.herdr.call('pane.send_input', { pane_id: session.id, text: typed, keys: ['enter'] });
    this.log(`${typed} typed into ${session.name} (${session.id}) on the owner's order`);
    const deadline = Date.now() + this.confirmMs;
    let confirmedText: string | null = null;
    for (;;) {
      await new Promise(resolve => setTimeout(resolve, 150));
      const seen = confirmations(await this.herdr.read(session.id, 30));
      if (seen.length > before) { confirmedText = seen.slice(before)[0] ?? null; break; }
      if (Date.now() > deadline) break;
    }

    // Restore the owner's defaults. Claude Code may write the file slightly after the confirmation
    // line prints, so keep polling for RESTORE_WATCH_MS after the confirmation (or deadline) and
    // restore whenever tracked values differ.
    let restoreError: string | null = null;
    if (token) {
      const watchUntil = Date.now() + RESTORE_WATCH_MS;
      const tryRestore = () => {
        if (!token) return;
        try { restoreDefaults(token); }
        catch (error) {
          restoreError = (error as Error).message;
          this.log(`could not restore default after ${typed}: ${restoreError}`);
          token = null;
        }
      };
      tryRestore();
      // Keep watching until the guard window closes.
      const watchLoop = async () => {
        while (Date.now() < watchUntil) {
          await new Promise(r => setTimeout(r, 200));
          if (!token) break;
          try { restoreDefaults(token); } catch { /* will be caught on the next full tryRestore */ }
        }
      };
      void watchLoop().catch(() => undefined);
      // Immediate restore is enough for the returned outcome.
    }

    // Build the outcome from the session's new setting, without echoing the "saved as default" clause.
    const saveNote = saveError ? ` The default for new sessions may have changed: could not read the settings file before the command (${saveError}).` : '';
    if (!confirmedText) return { ok: true, outcome: `Sent ${typed} to ${session.name}. It did not show that it took effect.${saveNote}` };
    return { ok: true, outcome: settingOutcome(what, confirmedText, restoreError ?? (saveError ? saveError : null)) };
  }

  private setVoice(on: boolean): Result {
    const saved = this.save(() => this.settings.setVoice(on), `spoken feedback turned ${on ? 'on' : 'off'}`);
    if (!on) this.say?.stop();
    this.announceVoice();
    if (on) this.speak('The voice is on.');
    return { ok: true, outcome: (on ? 'The voice is on: answers are spoken.' : 'The voice is off: answers show on the shelf only.') + saved, silent: true };
  }

  private setReading(on: boolean): Result {
    const saved = this.save(() => this.settings.setReadReplies(on), `reading replies aloud turned ${on ? 'on' : 'off'}`);
    this.announceVoice();
    const note = on && !this.settings.voice ? ' The voice is off, so nothing is spoken until you say “voice on”.' : '';
    if (on) this.speak('Reading replies is on.');
    return { ok: true, outcome: (on ? 'Reading each finished reply aloud. Say “stop reading replies” to stop.' : 'Replies are not read aloud.') + note + saved, silent: true };
  }

  private announceVoice(): void { this.broadcast({ type: 'voice', feedback: this.settings.voice, reading: this.settings.readReplies, trouble: this.say?.failed ?? false }); }

  /**
   * Runs a settings write and logs it. A file that cannot be written is logged too, and the setting
   * holds until a restart: the returned note says so, for the owner's answer, or is empty.
   */
  private save(write: () => void, what: string): string {
    try { write(); } catch (error) {
      this.log(`${what}, but it could not be saved: ${(error as Error).message}`);
      return ` It could not be saved (${(error as Error).message}), so it lasts only until the view restarts.`;
    }
    this.log(what);
    return '';
  }

  /** Reads the last reply of a Claude Code session aloud. */
  private async readLast(shelf: Shelf, target: string | null): Promise<Result> {
    if (!target) return { ok: false, outcome: 'No session is in front to read.' };
    const session = shelf.sessions.find(s => s.id === target);
    if (!session) return { ok: false, outcome: 'Not read: that session has closed.' };
    if (!this.settings.voice || !this.say) return { ok: false, outcome: this.say ? 'The voice is off. Say “voice on” first.' : 'There is no voice to read with.' };
    if (session.agent !== 'claude') return { ok: false, outcome: `${session.name} is not a Claude Code session; only those can be read aloud.` };
    const spoken = await this.replyOf(session.id);
    if ('problem' in spoken) return { ok: false, outcome: spoken.problem };
    this.read.set(session.id, spoken.text);
    this.speak(spoken.phrase);
    return { ok: true, outcome: `Reading the last reply of ${session.name}.`, silent: true };
  }

  /** The session id Herdr holds for a pane's agent. */
  private async herdrSessionOf(paneId: string): Promise<string | null> {
    const info = await this.herdr.call('agent.get', { target: paneId });
    const session = (info.agent as { agent_session?: { value?: unknown } } | undefined)?.agent_session?.value;
    return typeof session === 'string' ? session : null;
  }

  /** The speakable start of a session's last reply, or why there is none. Nothing of it is logged. */
  private async replyOf(paneId: string): Promise<{ text: string; phrase: string } | { problem: string }> {
    let id: string | null = null;
    try { id = await this.sessionOf(paneId); } catch (error) { this.problem(`asking for the session of ${paneId}`, error); }
    if (!id) return { problem: 'Herdr has no transcript for that session, so there is nothing to read.' };
    const reply = lastReply(id, this.transcripts);
    if ('text' in reply) {
      const phrase = replyPhrase(reply.text);
      return phrase ? { text: reply.text, phrase } : { problem: 'That reply has nothing to read.' };
    }
    this.log(`the reply of ${paneId} could not be read: ${reply.problem}`);
    return { problem: reply.problem === 'no-reply' ? 'That session has no reply to read yet.' : reply.problem === 'unreadable' ? 'Its transcript could not be read.' : 'No transcript was found for that session.' };
  }

  /**
   * With reading on, a finished turn in the session in front is read aloud once: when its state
   * goes from working to idle or done. Another session's turn, and a reply already read, are not.
   */
  private watchTurns(shelf: Shelf): void {
    const ids = new Set(shelf.sessions.map(s => s.id));
    for (const id of [...this.states.keys()]) if (!ids.has(id)) { this.states.delete(id); this.read.delete(id); }
    for (const s of shelf.sessions) {
      const was = this.states.get(s.id);
      this.states.set(s.id, s.status);
      if (!(was === 'working' && (s.status === 'idle' || s.status === 'done')) || !this.settings.readReplies || !this.settings.voice) continue;
      if (s.id !== shelf.focusedId || s.agent !== 'claude') continue;
      const timer = setTimeout(() => {
        void (async () => {
          // Rechecked now: the owner may have turned reading off, or moved on, during the wait.
          if (this.mirror.shelf().focusedId !== s.id || !this.settings.readReplies || !this.settings.voice) return;
          const spoken = await this.replyOf(s.id);
          if ('problem' in spoken || this.read.get(s.id) === spoken.text || !this.settings.readReplies) return;
          this.read.set(s.id, spoken.text);
          this.speak(spoken.phrase);
        })();
      }, SETTLE_MS);
      // A wait for a transcript must not keep the process alive after the view stops.
      timer.unref();
    }
  }

  private setDirect(on: boolean): Result {
    const saved = this.save(() => this.settings.setDirect(on), `direct sending turned ${on ? 'on: spoken prompts are sent as soon as they are heard' : 'off: spoken prompts wait for "go"'}`);
    this.broadcast({ type: 'direct', on });
    return { ok: true, outcome: (on ? 'Sending at once: spoken prompts are sent as soon as they are heard. Say “wait for go” to stop.' : 'Waiting for “go”: spoken prompts wait as drafts.') + saved };
  }

  /** Brings a level's agent to the front, making its seat and starting the agent beside this call. */
  private async goTo(level: Level, place: string, who: string): Promise<Result> {
    const seat = await this.agents.seat(level);
    await this.focus(seat.paneId);
    if (seat.state === 'ready') return { ok: true, outcome: `At ${place}` };
    return { ok: true, outcome: `At ${place}. ${who} is starting.` };
  }

  private async nextWaiting(shelf: Shelf): Promise<Result> {
    const ordered = shelfOrder(shelf.projects, shelf.sessions);
    const waiting = ordered.filter(s => s.status === 'blocked' && s.id !== shelf.focusedId);
    if (waiting.length === 0) return { ok: false, outcome: 'Nothing is waiting for you.' };
    const from = ordered.findIndex(s => s.id === shelf.focusedId);
    const next = waiting.find(s => ordered.indexOf(s) > from) ?? waiting[0] as Session;
    const origin = this.jump?.origin ?? shelf.focusedId;
    await this.focus(next.id);
    if (origin) this.jump = { origin, current: next.id };
    return { ok: true, outcome: `${next.name} is waiting (${waiting.length} waiting)` };
  }

  // ---- Window mirrors ----------------------------------------------------------------------------

  /** An agent's order to show a page or a window in a project, as a new mirror session there. */
  async mirrorOrder(order: { open?: string; mirror?: string; workspace: string }): Promise<string> {
    const shelf = this.shelf();
    const project = shelf.projects.find(p => p.id === order.workspace);
    if (!project) throw new Error(`No project has the workspace ${order.workspace}.`);
    let window;
    if (order.open !== undefined) window = await this.mirrors.open(order.open);
    else {
      const said = (order.mirror ?? '').toLowerCase();
      const found = (await this.mirrors.list()).filter(w => w.title.toLowerCase().includes(said) || w.app.toLowerCase().replace(/\.exe$/, '') === said);
      if (found.length === 0) throw new Error(`No open PC window is called "${order.mirror ?? ''}".`);
      if (found.length > 1) throw new Error(`Several PC windows match "${order.mirror ?? ''}": ${found.slice(0, 6).map(w => `"${w.title}"`).join(', ')}. Name one more closely.`);
      window = found[0] as (typeof found)[number];
    }
    const id = await this.mirrors.make(project.id, window, false);
    await this.mirror.tick();
    this.broadcast({ type: 'notice', text: `"${window.title}" is mirrored into ${project.label}.` });
    return `Mirrored "${window.title}" into ${project.label} as session ${id}.`;
  }

  private frame(id: string, frame: Frame): void {
    const entry = this.frames.get(id) ?? { frame, sent: 0, timer: null };
    entry.frame = frame;
    this.frames.set(id, entry);
    if (entry.timer) return;
    const gap = this.mirror.shelf().focusedId === id ? FRONT_FRAME_MS : TILE_FRAME_MS;
    const wait = entry.sent + gap - Date.now();
    const send = () => {
      entry.timer = null;
      entry.sent = Date.now();
      // Only the latest picture goes; one that arrived while waiting replaced the one before.
      this.broadcast({ type: 'frame', id, w: entry.frame.w, h: entry.frame.h, mime: entry.frame.mime, data: entry.frame.data });
    };
    if (wait <= 0) send(); else entry.timer = setTimeout(send, wait);
  }

  private refreshNotes(): void {
    const sessions = this.mirror.shelf().sessions.filter(s => s.window);
    for (const id of [...this.notes.keys()]) if (!sessions.some(s => s.id === id)) this.notes.delete(id);
    for (const s of sessions) {
      const note = this.mirrors.note(s.id);
      if (this.notes.has(s.id) && this.notes.get(s.id) === note) continue;
      this.notes.set(s.id, note);
      this.broadcast({ type: 'window', id: s.id, note });
    }
  }

  // ---- Lists to pick from -------------------------------------------------------------------------

  private async openPicker(shelf: Shelf, kind: Picker['kind']): Promise<{ ok: boolean; outcome: string }> {
    let entries: PickerEntry[];
    if (kind === 'windows') {
      // A window joins the project the owner is in; at the overview it joins the overview, as sessions of no project do.
      const list = await this.mirrors.list();
      entries = list.map(w => ({ kind: 'windows' as const, label: w.title, detail: w.app.replace(/\.exe$/i, ''), hwnd: w.hwnd }));
    } else {
      entries = folders(projectRoots(), await takenFolders(this.herdr)).map(f => ({ kind: 'folders' as const, label: f.name, detail: f.path.startsWith(`${homedir()}/`) ? `~${f.path.slice(homedir().length)}` : f.path, path: f.path }));
    }
    if (this.picker) clearTimeout(this.picker.timer);
    this.picker = { kind, filter: '', page: 0, entries, timer: setTimeout(() => undefined, 0) };
    this.touchPicker();
    return { ok: true, outcome: kind === 'windows' ? `${entries.length} PC windows: pick one by its number` : `${entries.length} folders: pick one by its number, or say "make" and a new name` };
  }

  private filtered(): PickerEntry[] {
    if (!this.picker) return [];
    const f = squeezed(this.picker.filter);
    if (!f) return this.picker.entries;
    return this.picker.entries.filter(e => squeezed(`${e.label} ${e.detail}`).includes(f));
  }

  private pickerView(): Picker | null {
    const p = this.picker;
    if (!p) return null;
    const all = this.filtered();
    const pages = Math.max(1, Math.ceil(all.length / PICKER_PAGE));
    const items = all.slice(p.page * PICKER_PAGE, (p.page + 1) * PICKER_PAGE).map((e, i) => ({ n: i + 1, label: e.label, detail: e.detail }));
    const empty = all.length > 0 ? null : p.kind === 'windows'
      ? (p.filter ? `No PC window matches "${p.filter}".` : 'No PC window can be shown.')
      : (p.filter ? `No git folder matches "${p.filter}". Say "make it" for a new folder called ${p.filter}.` : 'No git folder that is not a project yet. Say a name, then "make it", for a new one.');
    return {
      kind: p.kind,
      title: p.kind === 'windows' ? 'Mirror a PC window into this project' : 'New project: pick a folder',
      filter: p.filter, items, page: p.page, pages, empty,
      make: p.kind === 'folders' && p.filter ? p.filter : null,
    };
  }

  private touchPicker(): void {
    if (!this.picker) return;
    clearTimeout(this.picker.timer);
    this.picker.timer = setTimeout(() => { this.closePicker(); this.broadcast({ type: 'notice', text: 'The list closed after a while unused; nothing was made.' }); }, this.pickerIdleMs);
    this.picker.timer.unref();
    this.broadcast({ type: 'picker', picker: this.pickerView() });
  }

  private closePicker(): void {
    if (this.picker) clearTimeout(this.picker.timer);
    this.picker = null;
    this.broadcast({ type: 'picker', picker: null });
  }

  private async pick(shelf: Shelf, n: number): Promise<{ ok: boolean; outcome: string }> {
    const p = this.picker;
    if (!p) return { ok: false, outcome: 'No list is open.' };
    const entry = this.filtered()[p.page * PICKER_PAGE + n - 1];
    if (!entry || n < 1 || n > PICKER_PAGE) return { ok: false, outcome: `No item ${n} in the list.` };
    if (entry.kind === 'windows') {
      const workspace = currentProject(shelf) ?? shelf.overviewId;
      if (!workspace) return { ok: false, outcome: 'Go into a project first.' };
      this.closePicker();
      await this.mirrors.make(workspace, { hwnd: entry.hwnd, title: entry.label, app: entry.detail }, true);
      await this.mirror.tick();
      return { ok: true, outcome: `Mirroring ${entry.label}` };
    }
    this.closePicker();
    const made = await addProject(this.herdr, entry.path);
    this.log(`project "${made.label}" made from ${made.folder}`);
    return await this.goToNew(made.workspaceId, made.label);
  }

  private async makeFromPicker(name: string | null): Promise<{ ok: boolean; outcome: string }> {
    const p = this.picker;
    if (!p || p.kind !== 'folders') return { ok: false, outcome: 'Say "new project" first, then "make" and a name.' };
    const said = (name ?? p.filter).trim();
    if (!said) return { ok: false, outcome: 'Say the new project\'s name first, then "make it" (or say "make" and the name).' };
    let made;
    try { made = await makeProject(this.herdr, newProjectRoot(), said); } catch (error) {
      p.filter = said; p.page = 0; this.touchPicker();
      return { ok: false, outcome: (error as Error).message };
    }
    this.closePicker();
    this.log(`project "${made.label}" made in ${made.folder}`);
    return await this.goToNew(made.workspaceId, made.label);
  }

  /** Goes into a project just made: its agent comes to the front, as going into any project does. */
  private async goToNew(workspaceId: string, label: string): Promise<{ ok: boolean; outcome: string }> {
    await this.mirror.tick();
    const r = await this.goTo({ project: workspaceId }, label, `${label}'s agent`);
    return { ok: r.ok, outcome: `Made project ${label}. ${r.outcome}` };
  }

  private async prompt(target: Session, text: string): Promise<void> {
    if (target.agent) await this.herdr.call('agent.prompt', { target: target.id, text });
    else await this.herdr.call('pane.send_input', { pane_id: target.id, text, keys: ['enter'] });
  }
}

/** Why a model or effort command cannot be typed into this session now, or null. */
function settingRefusal(shelf: Shelf, session: Session, draft: boolean): string | null {
  const unready = notReady(shelf, session);
  if (unready) return unready;
  if (session.agent === null) return `${session.name} is a shell; the command would run there as text.`;
  if (session.agent !== 'claude') return `${session.name} is not a Claude Code session.`;
  if (session.status === 'working') return `${session.name} is working. Say it again when it is done.`;
  if (session.status === 'blocked') return `${session.name} is waiting on a question. Answer it first.`;
  if (session.status === 'unknown') return `${session.name} is not showing whether it is ready.`;
  if (draft) return `a draft waits in ${session.name}. Say “go” or “scratch that” first.`;
  return null;
}

/** Why words cannot go to this session now, or null: a level agent that is not up must never get them as shell input. */
function notReady(shelf: Shelf, target: Session): string | null {
  if (target.role === 'task') return null;
  if (shelf.starting.includes(target.id)) return `${target.name} is still starting. Say it again when it is ready.`;
  if (target.agent !== null) return null;
  const failed = shelf.failed.find(f => f.id === target.id);
  return failed ? `${target.name} is not running. ${failed.reason}` : `${target.name} is not running. Go to it again to start it.`;
}

const loose = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/\b([a-z0-9]{3,})s\b/g, '$1');

/** The project whose label was said, loosely: case, punctuation and a plural s do not matter. */
export function projectCalled(shelf: Shelf, said: string): Project | null {
  return shelf.projects.find(p => loose(p.label) === loose(said)) ?? null;
}

/** A session by tile number, pane id, or name or project label as said. */
export function resolve(shelf: Shelf, target: number | string): Session | null {
  const found = matches(shelf, target, true);
  return found[0] ?? null;
}

/**
 * Sessions a spoken reference may mean: by tile number, pane id, name, or (when `projects`)
 * project label, in shelf order. Loose: case, punctuation and a plural s on a longer word do not
 * matter ("log" finds "logs").
 */
export function matches(shelf: Shelf, target: number | string, projects: boolean): Session[] {
  const ordered = shelfOrder(shelf.projects, shelf.sessions);
  const byNumber = (n: number) => { const s = ordered[n - 1]; return s ? [s] : []; };
  if (typeof target === 'number') return byNumber(target);
  const t = target.trim().toLowerCase();
  if (/^\d+$/.test(t)) return byNumber(Number(t));
  const byId = ordered.filter(s => s.id.toLowerCase() === t);
  if (byId.length) return byId;
  // A name several sessions share, such as each project's agent, means the one in the project in front.
  const here = shelf.sessions.find(s => s.id === shelf.focusedId)?.workspaceId;
  const named = ordered.filter(s => loose(s.name) === loose(t));
  const byName = projects && named.some(s => s.workspaceId === here) ? named.filter(s => s.workspaceId === here) : named;
  if (byName.length || !projects) return byName;
  return ordered.filter(s => loose(shelf.projects.find(p => p.id === s.workspaceId)?.label ?? '') === loose(t)).slice(0, 1);
}

function assertNever(value: never): never { throw new Error(`Unhandled ${JSON.stringify(value)}`); }

function name(shelf: Shelf, id: string): string { return shelf.sessions.find(s => s.id === id)?.name ?? id; }

/** What an utterance came to: how it was taken, whether it worked, what to tell the owner. */
interface Done { as: Utterance['as']; ok: boolean; outcome: string; silent?: true; say?: string }

const IGNORED: Done = { as: 'ignored', ok: false, outcome: 'Not sent: listening is off. Say a command.' };

/**
 * Where "go to ..." or "show ..." leads: the action and what to call it, or why it leads nowhere,
 * or null when "show ..." names no session or project and is a prompt. Navigation only: with no
 * match, the words reach no session.
 */
function navigation(taken: Extract<Heard, { as: 'go' | 'show' }>, shelf: Shelf): { action: BridgeAction; label: string } | { done: Done } | null {
  const project = typeof taken.target === 'string' ? projectCalled(shelf, taken.target) : null;
  if (taken.as === 'go') {
    const target = project ? null : resolve(shelf, taken.target);
    if (project) return { action: { kind: 'go', projectId: project.id }, label: `Go to ${project.label}` };
    if (target) return { action: { kind: 'focus', sessionId: target.id }, label: `Show ${target.name}` };
    return { done: { as: 'command', ok: false, outcome: `No project or session is called "${taken.target}". Nothing was sent.` } };
  }
  const target = resolve(shelf, taken.target);
  // A session's own name wins over a project's; a project's name goes into the project.
  if (target && !(project && target.name.toLowerCase() !== String(taken.target).toLowerCase())) return { action: { kind: 'focus', sessionId: target.id }, label: `Show ${target.name}` };
  if (project) return { action: { kind: 'go', projectId: project.id }, label: `Go to ${project.label}` };
  if (typeof taken.target === 'number') return { done: { as: 'command', ok: false, outcome: `No session ${taken.target} on the shelf.` } };
  return null;
}

/** A refusal the view makes before Herdr is asked: its message says why, in the owner's words. */
class RefusedError extends Error {}

const HELPER_DRAFT_HOW = 'say “overview”, then “go” to send it or “scratch that” to clear it.';
const HELPER_DRAFT = 'Draft in the helper\'s input. At the overview, say “go” to send it or “scratch that” to clear it.';

function herdrProblem(error: unknown): string {
  if (error instanceof HerdrError && error.code === 'agent_blocked') return 'it is waiting on a question — answer it with a key first.';
  return (error as Error).message;
}

