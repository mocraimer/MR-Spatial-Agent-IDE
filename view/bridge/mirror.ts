/**
 * The bridge's one copy of the owner's sessions. Herdr owns them; this polls Herdr and holds
 * what it last reported. Herdr has no output stream (protocol 22), so text is read and compared.
 */
import { HERDR_PROTOCOL, HerdrClient, HerdrUnavailable, type HerdrPane } from './herdr.js';
import type { HerdrLink, Session, Shelf } from '../shared/messages.js';

export interface MirrorOptions {
  /** Rows of history kept for the session in front; the page scrolls within them. */
  frontLines: number;
  /** Rows read for the other sessions; a tile shows only its last few. */
  tileLines: number;
  tickMs: number;
  /** Other sessions are read every this many ticks. */
  tileEvery: number;
}
export const DEFAULT_MIRROR: MirrorOptions = { frontLines: 500, tileLines: 40, tickMs: 33, tileEvery: 30 };

export interface MirrorListener {
  shelf(shelf: Shelf): void;
  text(sessionId: string, text: string): void;
}

export class Mirror {
  private current: Shelf = { herdr: { state: 'down', reason: 'Connecting to Herdr…' }, projects: [], sessions: [], focusedId: null };
  private readonly texts = new Map<string, string>();
  private readonly listeners = new Set<MirrorListener>();
  private timer: NodeJS.Timeout | null = null;
  private ticks = 0;
  private running = false;
  private checkedProtocol = false;

  constructor(private readonly herdr: HerdrClient, private readonly options: MirrorOptions = DEFAULT_MIRROR) {}

  shelf(): Shelf { return this.current; }
  text(sessionId: string): string | undefined { return this.texts.get(sessionId); }

  listen(listener: MirrorListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const loop = async () => {
      if (!this.running) return;
      const wait = await this.tick();
      if (this.running) this.timer = setTimeout(() => { void loop(); }, wait);
    };
    void loop();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private ticking: Promise<number> = Promise.resolve(0);
  /**
   * Reads Herdr once; returns how long to wait before the next read. Reads run one after
   * another, so an older snapshot never lands after a newer one (an action's own read included).
   */
  tick(): Promise<number> {
    const next = this.ticking.then(() => this.readOnce());
    this.ticking = next.catch(() => 0);
    return next;
  }

  private async readOnce(): Promise<number> {
    try {
      if (!this.checkedProtocol) {
        const protocol = await this.herdr.ping();
        if (protocol !== HERDR_PROTOCOL) {
          this.setLink({ state: 'down', reason: `Herdr speaks protocol ${protocol}; this view needs ${HERDR_PROTOCOL}. Update the view or Herdr so they match.` });
          return 5000;
        }
        this.checkedProtocol = true;
      }
      const snapshot = await this.herdr.snapshot();
      const sessions = snapshot.panes.map(toSession);
      const ids = new Set(sessions.map(s => s.id));
      for (const id of [...this.texts.keys()]) if (!ids.has(id)) this.texts.delete(id);
      const next: Shelf = {
        herdr: { state: 'up' },
        projects: snapshot.workspaces.map(w => ({ id: w.id, label: w.label })),
        sessions,
        focusedId: snapshot.focusedPaneId,
      };
      if (JSON.stringify(next) !== JSON.stringify(this.current)) { this.current = next; this.emitShelf(); }
      const readAll = this.ticks % this.options.tileEvery === 0;
      this.ticks += 1;
      await Promise.all(sessions
        .filter(s => readAll || s.id === next.focusedId || !this.texts.has(s.id))
        .map(s => this.readText(s.id, s.id === next.focusedId ? this.options.frontLines : this.options.tileLines)));
      return this.options.tickMs;
    } catch (error) {
      // Not running, shutting down, or an answer this view cannot read: shown, then retried.
      this.checkedProtocol = false;
      this.setLink({
        state: 'down',
        reason: error instanceof HerdrUnavailable
          ? 'Herdr is not running on the PC. Start Herdr; the view reconnects by itself.'
          : `Herdr answered with an error (${(error as Error).message}). The view retries by itself.`,
      });
      return 1000;
    }
  }

  private async readText(id: string, lines: number): Promise<void> {
    let text: string;
    try { text = await this.herdr.read(id, lines); } catch (error) {
      if (error instanceof HerdrUnavailable) throw error;
      return; // The pane closed between the snapshot and the read; the next snapshot drops it.
    }
    if (this.texts.get(id) === text || !this.current.sessions.some(s => s.id === id)) return;
    this.texts.set(id, text);
    for (const listener of this.listeners) listener.text(id, text);
  }

  private setLink(link: HerdrLink): void {
    if (JSON.stringify(link) === JSON.stringify(this.current.herdr)) return;
    this.current = { ...this.current, herdr: link };
    this.emitShelf();
  }

  private emitShelf(): void { for (const listener of this.listeners) listener.shelf(this.current); }
}

function toSession(pane: HerdrPane): Session {
  return {
    id: pane.id,
    workspaceId: pane.workspaceId,
    agent: pane.agent,
    status: pane.status,
    name: pane.label ?? pane.title ?? pane.agent ?? 'shell',
  };
}
