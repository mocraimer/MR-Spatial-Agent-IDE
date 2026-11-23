/**
 * What the view does, apart from how it is reached: the shelf, the actions, speech routing and
 * the yes before a close. The HTTP server (server.ts) only authenticates and forwards here.
 */
import { homedir } from 'node:os';
import { shelfOrder, type BridgeAction, type Command, type KeyName } from '../shared/actions.js';
import { currentProject, type BridgeEvent, type Picker, type Project, type Session, type Shelf, type SpeechState, type Utterance } from '../shared/messages.js';
import { OVERVIEW, type Level, type LevelAgents } from './agents.js';
import { Drafts, typeable } from './drafts.js';
import { classify, type Heard } from './heard.js';
import { HerdrError, type HerdrClient } from './herdr.js';
import type { Mirror } from './mirror.js';
import { Questions } from './question.js';
import { Settings } from './settings.js';
import { Mirrors } from './mirrors.js';
import { addProject, folders, loose as squeezed, makeProject, newProjectRoot, projectRoots, takenFolders } from './projects.js';
import type { Frame, Windows } from './windows.js';

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
  /** How long a list to pick from stays open without use (tests make it short). */
  pickerIdleMs?: number | undefined;
  /** The window mirrors; without them, the PC's windows are not offered. */
  mirrors?: Mirrors | undefined;
}
/** Where no window helper is set up: every request says so. */
const NO_WINDOWS: Windows = {
  list: () => Promise.reject(new Error('Window mirrors are not set up in this view.')),
  capture: () => Promise.reject(new Error('Window mirrors are not set up in this view.')),
  stop: () => Promise.resolve(),
  input: () => Promise.reject(new Error('Window mirrors are not set up in this view.')),
  open: () => Promise.reject(new Error('Window mirrors are not set up in this view.')),
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
const TILE_FRAME_MS = 1000;

type PickerEntry = { kind: 'windows'; label: string; detail: string; hwnd: number } | { kind: 'folders'; label: string; detail: string; path: string };
interface PickerState { kind: Picker['kind']; filter: string; page: number; entries: PickerEntry[]; timer: NodeJS.Timeout }


export class Bridge {
  private readonly clients = new Set<Send>();
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
    this.mirrors = options.mirrors ?? new Mirrors(herdr, NO_WINDOWS, '');
    this.pickerIdleMs = options.pickerIdleMs ?? PICKER_IDLE_MS;
    agents.onChange(() => { this.logAgentStarts(); this.broadcast({ type: 'shelf', shelf: this.shelf() }); });
    mirror.listen({
      shelf: shelf => {
        if (this.jump && shelf.focusedId !== this.jump.current) this.jump = null;
        this.drafts.prune(new Set(shelf.sessions.map(x => x.id)));
        this.mirrors.sweep(new Set(shelf.sessions.map(s => s.id)));
        for (const id of [...this.frames.keys()]) if (!shelf.sessions.some(s => s.id === id)) { const f = this.frames.get(id); if (f?.timer) clearTimeout(f.timer); this.frames.delete(id); }
        this.broadcast({ type: 'shelf', shelf: this.shelf() });
        this.refreshNotes();
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
    const shelf = this.shelf();
    send({ type: 'shelf', shelf });
    for (const s of shelf.sessions) { const text = this.mirror.text(s.id); if (text !== undefined) send({ type: 'text', id: s.id, text }); }
    send({ type: 'confirm', pending: this.questions.closeView() });
    send({ type: 'ask', ask: this.questions.commandView() });
    send({ type: 'direct', on: this.settings.direct });
    send({ type: 'speech', speech: this.speech.state() });
    send({ type: 'picker', picker: this.pickerView() });
    for (const s of shelf.sessions.filter(x => x.window)) {
      send({ type: 'window', id: s.id, note: this.mirrors.note(s.id) });
      const f = this.frames.get(s.id);
      if (f) send({ type: 'frame', id: s.id, w: f.frame.w, h: f.frame.h, mime: f.frame.mime, data: f.frame.data });
    }
    this.clients.add(send);
    return () => { this.clients.delete(send); };
  }

  broadcast(event: BridgeEvent): void { for (const send of this.clients) send(event); }

  /** Carries out one action; the answer is what to tell the owner. */
  async act(action: BridgeAction): Promise<{ ok: boolean; outcome: string }> {
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
        const r = run.kind === 'key' || run.kind === 'send' || run.kind === 'scratch' ? await this.spokenAt(shelf, receiver, run) : await this.act(run);
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
    return run && (run.kind === 'key' || run.kind === 'send' || run.kind === 'scratch') ? `${what} in ${receiver ? name(shelf, receiver) : 'the session in front'}` : what;
  }

  /** Puts a command to the owner as a question; it is done only on their "yes". */
  private ask(label: string, run: () => Promise<{ ok: boolean; outcome: string }>): Done {
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
  private async answer(yes: boolean): Promise<{ ok: boolean; outcome: string }> {
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
    return { ok: r.ok, outcome: `Answered yes: ${q.label}. ${r.outcome}` };
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
    const answer = await new Promise<'yes' | 'no' | 'no-answer'>(settle => {
      this.questions.put({ kind: 'close', sessionId: target.id, name: shown, settle: yes => settle(yes ? 'yes' : 'no') }, this.closeAnswerMs, () => settle('no-answer'));
    });
    if (answer !== 'yes') {
      this.log(`close of ${shown} (${target.id}): ${answer === 'no' ? 'the owner said no' : 'no answer in time'}; it stays open`);
      this.broadcast({ type: 'notice', text: `${target.name} was not closed.` });
      return answer === 'no' ? 'declined' : 'no-answer';
    }
    try { await this.herdr.call('pane.close', { pane_id: target.id }); } catch (error) {
      this.broadcast({ type: 'notice', text: `Could not close ${target.name}: ${this.problem(`the close of ${shown} (${target.id})`, error)}` });
      return 'failed';
    }
    this.log(`closed ${shown} (${target.id}) on the owner's yes`);
    this.broadcast({ type: 'notice', text: `Closed ${target.name}.` });
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

  private async key(shelf: Shelf, target: string | null, key: KeyName): Promise<{ ok: boolean; outcome: string }> {
    if (!target) return { ok: false, outcome: 'No session is in front to receive the key.' };
    const session = shelf.sessions.find(s => s.id === target);
    const unready = session ? notReady(shelf, session) : null;
    if (unready) return { ok: false, outcome: `Not pressed: ${unready}` };
    await this.herdr.call('pane.send_keys', { pane_id: target, keys: [key] });
    return { ok: true, outcome: `Pressed ${key} in ${name(shelf, target)}` };
  }

  private async spokenAt(shelf: Shelf, receiver: string | null, run: { kind: 'key'; key: KeyName } | { kind: 'send' } | { kind: 'scratch' }): Promise<{ ok: boolean; outcome: string }> {
    if (receiver !== null && !shelf.sessions.some(s => s.id === receiver)) return { ok: false, outcome: 'Not done: the session that was in front when you spoke has closed.' };
    try {
      return run.kind === 'key' ? await this.key(shelf, receiver, run.key) : run.kind === 'send' ? await this.sendDraft(shelf, receiver) : await this.scratchDraft(shelf, receiver);
    } catch (error) { return { ok: false, outcome: this.problem(`the ${run.kind === 'key' ? `${run.key} key` : run.kind === 'send' ? '"go"' : '"scratch that"'}`, error) }; }
  }

  /** Runs `step` after the utterances already queued, so a held order never interleaves with one being carried out. */
  private inOrder<T>(step: () => Promise<T>): Promise<T> {
    const done = this.queue.then(step);
    this.queue = done.catch(() => undefined);
    return done;
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
  private async sendDraft(shelf: Shelf, target: string | null): Promise<{ ok: boolean; outcome: string }> {
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
  private async scratchDraft(shelf: Shelf, target: string | null): Promise<{ ok: boolean; outcome: string }> {
    if (!target || !this.drafts.has(target)) return { ok: false, outcome: 'No draft waits in the session in front. Nothing was cleared.' };
    // Taken before the key goes, as for "go"; put back if the call fails, so the owner can say it again.
    this.drafts.clear(target);
    try { await this.herdr.call('pane.send_keys', { pane_id: target, keys: ['ctrl+u'] }); } catch (error) { this.drafts.mark(target); throw error; } finally { this.broadcast({ type: 'shelf', shelf: this.shelf() }); }
    return { ok: true, outcome: `Cleared the draft in ${name(shelf, target)}` };
  }

  private setDirect(on: boolean): { ok: boolean; outcome: string } {
    let saved = '';
    try { this.settings.setDirect(on); } catch (error) {
      saved = ` It could not be saved (${(error as Error).message}), so it lasts only until the view restarts.`;
      this.log(`the send setting could not be saved: ${(error as Error).message}`);
    }
    this.log(`direct sending turned ${on ? 'on: spoken prompts are sent as soon as they are heard' : 'off: spoken prompts wait for "go"'}`);
    this.broadcast({ type: 'direct', on });
    return { ok: true, outcome: (on ? 'Sending at once: spoken prompts are sent as soon as they are heard. Say “wait for go” to stop.' : 'Waiting for “go”: spoken prompts wait as drafts.') + saved };
  }

  /** Brings a level's agent to the front, making its seat and starting the agent beside this call. */
  private async goTo(level: Level, place: string, who: string): Promise<{ ok: boolean; outcome: string }> {
    const seat = await this.agents.seat(level);
    await this.focus(seat.paneId);
    if (seat.state === 'ready') return { ok: true, outcome: `At ${place}` };
    return { ok: true, outcome: `At ${place}. ${who} is starting.` };
  }

  private async nextWaiting(shelf: Shelf): Promise<{ ok: boolean; outcome: string }> {
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
interface Done { as: Utterance['as']; ok: boolean; outcome: string }

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

