/**
 * What the view does, apart from how it is reached: the shelf, the actions, speech routing and
 * the yes before a close. The HTTP server (server.ts) only authenticates and forwards here.
 */
import { shelfOrder, type BridgeAction, type KeyName } from '../shared/actions.js';
import type { BridgeEvent, PendingClose, Session, Shelf, SpeechState, Utterance } from '../shared/messages.js';
import { classify } from './heard.js';
import { HerdrError, type HerdrClient } from './herdr.js';
import type { Mirror } from './mirror.js';

export interface Transcriber { state(): SpeechState; transcribe(audio: Float32Array): Promise<string> }
export interface HelperAgent { show(): Promise<string>; order(text: string): Promise<void> }

type Send = (event: BridgeEvent) => void;
export type CloseAnswer = 'closed' | 'declined' | 'no-answer' | 'unknown-session' | 'ambiguous' | 'busy' | 'failed';

/** How long a close waits for the owner's answer before it lapses. */
export const CLOSE_ANSWER_MS = 120_000;
const UTTERANCES_KEPT = 200;

export class Bridge {
  private readonly clients = new Set<Send>();
  /** Where "back" returns to, and the session the last jump brought to the front. */
  private jump: { origin: string; current: string } | null = null;
  private pending: (PendingClose & { answer: (yes: boolean) => void }) | null = null;
  private readonly heard = new Map<string, Promise<Utterance>>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly herdr: HerdrClient,
    private readonly mirror: Mirror,
    private readonly speech: Transcriber,
    private readonly helper: HelperAgent,
    private readonly closeAnswerMs = CLOSE_ANSWER_MS,
  ) {
    mirror.listen({
      shelf: shelf => {
        if (this.jump && shelf.focusedId !== this.jump.current) this.jump = null;
        this.broadcast({ type: 'shelf', shelf });
      },
      text: (id, text) => this.broadcast({ type: 'text', id, text }),
    });
  }

  /** Adds a page. It first gets everything it needs to draw, then each change. */
  connect(send: Send): () => void {
    const shelf = this.mirror.shelf();
    send({ type: 'shelf', shelf });
    for (const s of shelf.sessions) { const text = this.mirror.text(s.id); if (text !== undefined) send({ type: 'text', id: s.id, text }); }
    send({ type: 'confirm', pending: this.pendingView() });
    send({ type: 'speech', speech: this.speech.state() });
    this.clients.add(send);
    return () => { this.clients.delete(send); };
  }

  broadcast(event: BridgeEvent): void { for (const send of this.clients) send(event); }

  /** Carries out one action; the answer is what to tell the owner. */
  async act(action: BridgeAction): Promise<{ ok: boolean; outcome: string }> {
    const shelf = this.mirror.shelf();
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
        case 'confirm-close': {
          if (!this.pending) return { ok: false, outcome: 'No close is waiting for an answer.' };
          this.pending.answer(action.answer);
          return { ok: true, outcome: action.answer ? `Answered yes to closing ${this.pending.name}.` : `Answered no: ${this.pending.name} stays open.` };
        }
        case 'helper': {
          const id = await this.helper.show();
          await this.focus(id);
          return { ok: true, outcome: 'Showing the helper. Type or speak an order to it.' };
        }
        default: return assertNever(action);
      }
    } catch (error) {
      return { ok: false, outcome: herdrProblem(error) };
    }
  }

  /**
   * One utterance, transcribed and carried out in arrival order. `receiver` is the session that
   * was in front when the speech began; a prompt goes there even if focus has moved since.
   * The same id twice (a page retrying after a dropped link) is carried out once.
   */
  utterance(id: string, audio: Float32Array, receiver: string | null): Promise<Utterance> {
    const known = this.heard.get(id);
    if (known) return known;
    const done = this.queue.then(() => this.handle(id, audio, receiver));
    this.queue = done.catch(() => undefined);
    this.heard.set(id, done);
    if (this.heard.size > UTTERANCES_KEPT) this.heard.delete(this.heard.keys().next().value as string);
    return done;
  }

  private async handle(id: string, audio: Float32Array, receiver: string | null): Promise<Utterance> {
    const record = (heard: string, as: Utterance['as'], ok: boolean, outcome: string): Utterance => {
      const u: Utterance = { id, heard, as, ok, outcome };
      this.broadcast({ type: 'utterance', utterance: u });
      return u;
    };
    const speech = this.speech.state();
    if (!speech.ready) return record('', 'nothing', false, speech.reason);
    let heard: string;
    try { heard = (await this.speech.transcribe(audio)).trim(); } catch (error) {
      return record('', 'nothing', false, `Speech could not be read: ${(error as Error).message}`);
    }
    const shelf = this.mirror.shelf();
    const taken = classify(heard, this.pending !== null);
    switch (taken.as) {
      case 'nothing': return record(heard, 'nothing', false, 'Heard nothing to act on.');
      case 'command': {
        if ('page' in taken.command.run) {
          this.broadcast({ type: 'page', action: taken.command.run.page });
          return record(heard, 'command', true, taken.command.label);
        }
        const run = taken.command.run.bridge;
        // A spoken key belongs to its utterance: like a prompt, it goes to the session that was
        // in front when the speech began, not to whichever is in front once it has been heard.
        const r = run.kind === 'key' ? await this.spokenKey(shelf, receiver, run.key) : await this.act(run);
        return record(heard, 'command', r.ok, r.outcome);
      }
      case 'show': {
        const target = resolve(shelf, taken.target);
        if (target) { const r = await this.act({ kind: 'focus', sessionId: target.id }); return record(heard, 'command', r.ok, r.outcome); }
        if (typeof taken.target === 'number') return record(heard, 'command', false, `No session ${taken.target} on the shelf.`);
        // "show me the failing test" names no session: it is a prompt.
        return this.deliver(record, heard, shelf, receiver);
      }
      case 'helper': {
        try { await this.helper.order(taken.order); } catch (error) { return record(heard, 'helper', false, `The helper did not get it: ${herdrProblem(error)}`); }
        return record(heard, 'helper', true, 'Sent to the helper');
      }
      case 'prompt': return this.deliver(record, heard, shelf, receiver);
      default: return assertNever(taken);
    }
  }

  private async deliver(record: (heard: string, as: Utterance['as'], ok: boolean, outcome: string) => Utterance, heard: string, shelf: Shelf, receiver: string | null): Promise<Utterance> {
    if (receiver === null) return record(heard, 'prompt', false, 'Not sent: no session was in front when you started speaking.');
    const target = shelf.sessions.find(s => s.id === receiver);
    if (!target) return record(heard, 'prompt', false, 'Not sent: the session that was in front when you spoke has closed.');
    try { await this.prompt(target, heard); } catch (error) { return record(heard, 'prompt', false, `Not sent to ${target.name}: ${herdrProblem(error)}`); }
    return record(heard, 'prompt', true, `Sent to ${target.name}`);
  }

  /**
   * The helper asks to close a session. Nothing closes until the owner says yes to that named
   * session; no answer, or a no, leaves it open.
   */
  async requestClose(ref: string): Promise<CloseAnswer> {
    const shelf = this.mirror.shelf();
    // A close names exactly one session: by pane id, tile number or a name no other session has.
    const found = matches(shelf, ref, false);
    if (found.length > 1) return 'ambiguous';
    const target = found[0];
    if (!target) return 'unknown-session';
    const n = shelfOrder(shelf.projects, shelf.sessions).indexOf(target) + 1;
    const project = shelf.projects.find(p => p.id === target.workspaceId)?.label ?? '';
    const shown = `${n} ${target.name}${project ? ` (${project})` : ''}`;
    if (this.pending) return 'busy';
    const answer = await new Promise<'yes' | 'no' | 'no-answer'>(settle => {
      const timer = setTimeout(() => settle('no-answer'), this.closeAnswerMs);
      this.pending = { sessionId: target.id, name: shown, answer: yes => { clearTimeout(timer); settle(yes ? 'yes' : 'no'); } };
      this.broadcast({ type: 'confirm', pending: this.pendingView() });
    });
    this.pending = null;
    this.broadcast({ type: 'confirm', pending: null });
    if (answer !== 'yes') {
      this.broadcast({ type: 'notice', text: `${target.name} was not closed.` });
      return answer === 'no' ? 'declined' : 'no-answer';
    }
    try { await this.herdr.call('pane.close', { pane_id: target.id }); } catch (error) {
      this.broadcast({ type: 'notice', text: `Could not close ${target.name}: ${herdrProblem(error)}` });
      return 'failed';
    }
    this.broadcast({ type: 'notice', text: `Closed ${target.name}.` });
    return 'closed';
  }

  private pendingView(): PendingClose | null {
    return this.pending ? { sessionId: this.pending.sessionId, name: this.pending.name } : null;
  }

  private async focus(id: string): Promise<void> {
    await this.herdr.call('pane.focus', { pane_id: id });
    await this.mirror.tick();
  }

  private async key(shelf: Shelf, target: string | null, key: KeyName): Promise<{ ok: boolean; outcome: string }> {
    if (!target) return { ok: false, outcome: 'No session is in front to receive the key.' };
    await this.herdr.call('pane.send_keys', { pane_id: target, keys: [key] });
    return { ok: true, outcome: `Pressed ${key} in ${name(shelf, target)}` };
  }

  private async spokenKey(shelf: Shelf, receiver: string | null, key: KeyName): Promise<{ ok: boolean; outcome: string }> {
    if (receiver !== null && !shelf.sessions.some(s => s.id === receiver)) return { ok: false, outcome: 'Not pressed: the session that was in front when you spoke has closed.' };
    try { return await this.key(shelf, receiver, key); } catch (error) { return { ok: false, outcome: herdrProblem(error) }; }
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

  private async prompt(target: Session, text: string): Promise<void> {
    if (target.agent) await this.herdr.call('agent.prompt', { target: target.id, text });
    else await this.herdr.call('pane.send_input', { pane_id: target.id, text, keys: ['enter'] });
  }
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
  const loose = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/\b([a-z0-9]{3,})s\b/g, '$1');
  const byId = ordered.filter(s => s.id.toLowerCase() === t);
  if (byId.length) return byId;
  const byName = ordered.filter(s => loose(s.name) === loose(t));
  if (byName.length || !projects) return byName;
  return ordered.filter(s => loose(shelf.projects.find(p => p.id === s.workspaceId)?.label ?? '') === loose(t)).slice(0, 1);
}

function assertNever(value: never): never { throw new Error(`Unhandled ${JSON.stringify(value)}`); }

function name(shelf: Shelf, id: string): string { return shelf.sessions.find(s => s.id === id)?.name ?? id; }

function herdrProblem(error: unknown): string {
  if (error instanceof HerdrError && error.code === 'agent_blocked') return 'it is waiting on a question — answer it with a key first.';
  return (error as Error).message;
}

