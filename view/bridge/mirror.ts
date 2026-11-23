/**
 * The bridge's one copy of the owner's sessions. Herdr owns them; this polls Herdr and holds
 * what it last reported. Herdr has no output stream (protocol 22), so text is read and compared.
 */
import { HERDR_PROTOCOL, HerdrClient, HerdrUnavailable, type HerdrPane } from './herdr.js';
import { isMirrorLabel } from './mirrors.js';
import { OVERVIEW_LABEL, SEAT_LABEL, type HerdrLink, type Role, type Session, type Shelf } from '../shared/messages.js';

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
  private current: Shelf = { herdr: { state: 'down', reason: 'Connecting to Herdr…' }, projects: [], sessions: [], focusedId: null, overviewId: null, starting: [], failed: [], drafts: [] };
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
      const overviewId = snapshot.workspaces.find(w => w.label === OVERVIEW_LABEL)?.id ?? null;
      await this.readScreen(snapshot.focusedPaneId, snapshot.panes);
      const sessions = snapshot.panes.map(pane => toSession(pane, overviewId, pane.id === this.screen?.id ? this.screen.size : null));
      const ids = new Set(sessions.map(s => s.id));
      for (const id of [...this.texts.keys()]) if (!ids.has(id)) this.texts.delete(id);
      const next: Shelf = {
        herdr: { state: 'up' },
        projects: snapshot.workspaces.map(w => ({ id: w.id, label: w.label })),
        sessions,
        focusedId: snapshot.focusedPaneId,
        overviewId,
        starting: [],
        failed: [],
        drafts: [],
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

  /** The focused pane's screen size while a full-screen program that is not an agent runs in it. */
  private screen: { id: string; size: { rows: number; cols: number } | null; at: number } | null = null;
  private async readScreen(focusedId: string | null, panes: HerdrPane[]): Promise<void> {
    const pane = panes.find(p => p.id === focusedId);
    if (!pane || pane.agent !== null || isMirrorLabel(pane.label)) { this.screen = null; return; }
    if (this.screen?.id === pane.id && this.ticks - this.screen.at < SCREEN_EVERY) return;
    let size: { rows: number; cols: number } | null = null;
    // Herdr 0.9.3 (protocol 22): pane.process_info names the foreground processes, and pane.layout
    // gives each pane's rect in character cells (a bench pane is 120 by 40), checked on a bench.
    try {
      const info = await this.herdr.call('pane.process_info', { pane_id: pane.id });
      const processes = ((info.process_info as { foreground_processes?: { name?: unknown }[] } | undefined)?.foreground_processes ?? []);
      const programs = processes.filter(p => typeof p.name === 'string' && !SHELLS.has(p.name));
      if (programs.length > 0) {
        const layout = await this.herdr.call('pane.layout', { pane_id: pane.id });
        const rect = ((layout.layout as { panes?: { pane_id?: unknown; rect?: { width?: unknown; height?: unknown } }[] } | undefined)?.panes ?? []).find(p => p.pane_id === pane.id)?.rect;
        if (rect && typeof rect.width === 'number' && typeof rect.height === 'number') size = { rows: rect.height, cols: rect.width };
      }
    } catch (error) {
      if (error instanceof HerdrUnavailable) throw error;
    }
    this.screen = { id: pane.id, size, at: this.ticks };
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

/** A level agent is known by its seat: the pane label, in the overview's workspace or a project's. */
function roleOf(pane: HerdrPane, overviewId: string | null): Role {
  if (pane.workspaceId === overviewId) return pane.label === SEAT_LABEL['overview-agent'] ? 'overview-agent' : 'task';
  return pane.label === SEAT_LABEL['project-agent'] ? 'project-agent' : 'task';
}

/** Programs that are a shell waiting at its prompt, not a full-screen viewer. */
const SHELLS = new Set(['bash', 'zsh', 'sh', 'fish', 'dash', 'ksh', 'tcsh', 'csh', 'nu', 'pwsh', 'login']);
/** The focused pane's program is looked at again this many ticks apart. */
const SCREEN_EVERY = 10;

function toSession(pane: HerdrPane, overviewId: string | null, screen: { rows: number; cols: number } | null): Session {
  return {
    id: pane.id,
    workspaceId: pane.workspaceId,
    role: roleOf(pane, overviewId),
    agent: pane.agent,
    status: pane.status,
    name: pane.label ?? pane.title ?? pane.agent ?? 'shell',
    window: isMirrorLabel(pane.label),
    screen,
  };
}
