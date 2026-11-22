/**
 * What the view does, apart from how it is reached: the shelf, the actions, speech routing and
 * the yes before a close. The HTTP server (server.ts) only authenticates and forwards here.
 */
import { shelfOrder, type BridgeAction, type KeyName } from '../shared/actions.js';
import type { BridgeEvent, PendingClose, Project, Session, Shelf, SpeechState, Utterance } from '../shared/messages.js';
import { OVERVIEW, type Level, type LevelAgents } from './agents.js';
import { classify } from './heard.js';
import { HerdrError, type HerdrClient } from './herdr.js';
import type { Mirror } from './mirror.js';

export interface Transcriber { state(): SpeechState; transcribe(audio: Float32Array): Promise<string> }

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
    private readonly agents: LevelAgents,
    private readonly closeAnswerMs = CLOSE_ANSWER_MS,
  ) {
    agents.onChange(() => this.broadcast({ type: 'shelf', shelf: this.shelf() }));
    mirror.listen({
      shelf: shelf => {
        if (this.jump && shelf.focusedId !== this.jump.current) this.jump = null;
        this.broadcast({ type: 'shelf', shelf: this.shelf() });
      },
      text: (id, text) => this.broadcast({ type: 'text', id, text }),
    });
  }

  /** Herdr's sessions as the mirror holds them, with which level agents are starting or failed. */
  shelf(): Shelf {
    const shelf = this.mirror.shelf();
    const pending = this.agents.pending();
    // A start that failed only because the agent asked something is over once Herdr sees the agent running.
    const running = new Set(shelf.sessions.filter(s => s.agent !== null).map(s => s.id));
    return { ...shelf, starting: pending.starting, failed: pending.failed.filter(f => !running.has(f.id)) };
  }

  /** Adds a page. It first gets everything it needs to draw, then each change. */
  connect(send: Send): () => void {
    const shelf = this.shelf();
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
        case 'confirm-close': {
          if (!this.pending) return { ok: false, outcome: 'No close is waiting for an answer.' };
          this.pending.answer(action.answer);
          return { ok: true, outcome: action.answer ? `Answered yes to closing ${this.pending.name}.` : `Answered no: ${this.pending.name} stays open.` };
        }
        case 'go': {
          if (action.projectId === shelf.overviewId) return await this.goTo(OVERVIEW, 'the overview', 'The helper');
          const project = shelf.projects.find(p => p.id === action.projectId);
          if (!project) return { ok: false, outcome: 'That project is no longer open.' };
          return await this.goTo({ project: project.id }, project.label, `${project.label}'s agent`);
        }
        case 'overview': return await this.goTo(OVERVIEW, 'the overview', 'The helper');
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
    const shelf = this.shelf();
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
      case 'go': {
        // Going somewhere is navigation only: with no match, the words reach no session.
        const project = typeof taken.target === 'string' ? projectCalled(shelf, taken.target) : null;
        const target = project ? null : resolve(shelf, taken.target);
        if (!project && !target) return record(heard, 'command', false, `No project or session is called "${taken.target}". Nothing was sent.`);
        const r = await this.act(project ? { kind: 'go', projectId: project.id } : { kind: 'focus', sessionId: (target as Session).id });
        return record(heard, 'command', r.ok, r.outcome);
      }
      case 'show': {
        const project = typeof taken.target === 'string' ? projectCalled(shelf, taken.target) : null;
        const target = resolve(shelf, taken.target);
        // A session's own name wins over a project's; a project's name goes into the project.
        if (target && !(project && target.name.toLowerCase() !== String(taken.target).toLowerCase())) { const r = await this.act({ kind: 'focus', sessionId: target.id }); return record(heard, 'command', r.ok, r.outcome); }
        if (project) { const r = await this.act({ kind: 'go', projectId: project.id }); return record(heard, 'command', r.ok, r.outcome); }
        if (typeof taken.target === 'number') return record(heard, 'command', false, `No session ${taken.target} on the shelf.`);
        // "show me the failing test" names no session: it is a prompt.
        return this.deliver(record, heard, shelf, receiver);
      }
      case 'helper': {
        try {
          const seat = await this.agents.seat(OVERVIEW);
          if (seat.state === 'ready') { await this.herdr.call('agent.prompt', { target: seat.paneId, text: taken.order }); return record(heard, 'helper', true, 'Sent to the helper'); }
          // The helper is starting: the order waits for it beside this queue, so speech goes on.
          void this.agents.ready(seat.paneId)
            .then(() => this.herdr.call('agent.prompt', { target: seat.paneId, text: taken.order }))
            .then(
              () => this.broadcast({ type: 'notice', text: `The helper is ready and got your order: "${taken.order}"` }),
              (error: unknown) => this.broadcast({ type: 'notice', text: `The helper did not get "${taken.order}": ${herdrProblem(error)}` }),
            );
          return record(heard, 'helper', true, 'The helper is starting; your order goes to it when it is ready');
        } catch (error) { return record(heard, 'helper', false, `The helper did not get it: ${herdrProblem(error)}`); }
      }
      case 'prompt': return this.deliver(record, heard, shelf, receiver);
      default: return assertNever(taken);
    }
  }

  private async deliver(record: (heard: string, as: Utterance['as'], ok: boolean, outcome: string) => Utterance, heard: string, shelf: Shelf, receiver: string | null): Promise<Utterance> {
    if (receiver === null) return record(heard, 'prompt', false, 'Not sent: no session was in front when you started speaking.');
    const target = shelf.sessions.find(s => s.id === receiver);
    if (!target) return record(heard, 'prompt', false, 'Not sent: the session that was in front when you spoke has closed.');
    const unready = notReady(shelf, target);
    if (unready) return record(heard, 'prompt', false, `Not sent: ${unready}`);
    try { await this.prompt(target, heard); } catch (error) { return record(heard, 'prompt', false, `Not sent to ${target.name}: ${herdrProblem(error)}`); }
    return record(heard, 'prompt', true, `Sent to ${target.name}`);
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
    const session = shelf.sessions.find(s => s.id === target);
    const unready = session ? notReady(shelf, session) : null;
    if (unready && shelf.starting.includes(target)) return { ok: false, outcome: `Not pressed: ${unready}` };
    await this.herdr.call('pane.send_keys', { pane_id: target, keys: [key] });
    return { ok: true, outcome: `Pressed ${key} in ${name(shelf, target)}` };
  }

  private async spokenKey(shelf: Shelf, receiver: string | null, key: KeyName): Promise<{ ok: boolean; outcome: string }> {
    if (receiver !== null && !shelf.sessions.some(s => s.id === receiver)) return { ok: false, outcome: 'Not pressed: the session that was in front when you spoke has closed.' };
    try { return await this.key(shelf, receiver, key); } catch (error) { return { ok: false, outcome: herdrProblem(error) }; }
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

function herdrProblem(error: unknown): string {
  if (error instanceof HerdrError && error.code === 'agent_blocked') return 'it is waiting on a question — answer it with a key first.';
  return (error as Error).message;
}

