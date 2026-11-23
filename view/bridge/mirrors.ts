/**
 * Window mirrors: PC windows shown in a project like its sessions.
 *
 * A mirror is a Herdr pane labelled "window: <title>" in the project's workspace, running a small
 * process (`mirror-session.ts`) that holds which window it shows. So Herdr keeps owning the
 * session: its number, focus, project and closing. The process attaches to the bridge over a
 * socket file only the owner's user can open; while it is attached the window is captured, and
 * keys typed into its pane (at the desk, or by the view's key buttons) go to the window.
 *
 * The same socket takes the agents' orders to show a page or a window in a project.
 */
import { chmodSync, existsSync, rmSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { homedir } from 'node:os';
import { compiled } from './config.js';
import type { HerdrClient } from './herdr.js';
import { paneOf } from './agents.js';
import { terminalKeys } from './keys.js';
import type { Frame, InputEvent, PcWindow, WindowProblem, Windows } from './windows.js';

export const WINDOW_LABEL = 'window: ';
export const MIRROR_SESSION = compiled('bridge', 'mirror-session.js');
export const MIRROR_SOCKET_ENV = 'SPATIAL_VIEW_MIRROR_SOCKET';
/** Pictures are asked of the PC at most this often. */
const CAPTURE_FPS = 15;
/** A new mirror's process has this long to attach before its session says it is not running. */
const ATTACH_MS = 15_000;
const TITLE_MAX = 60;

export interface MirrorListener {
  frame(sessionId: string, frame: Frame): void;
  /** What the session should say instead of the picture, or null when the picture is live. */
  problem(sessionId: string, problem: string | null): void;
  /** Something the owner should be told once, such as keys that did not reach the window. */
  notice(text: string): void;
}

interface Attached { hwnd: number; socket: Socket; problem: WindowProblem }

export function labelFor(title: string): string {
  const t = title.replace(/\s+/g, ' ').trim() || 'window';
  return `${WINDOW_LABEL}${t.length > TITLE_MAX ? `${t.slice(0, TITLE_MAX - 1)}…` : t}`;
}

export function isMirrorLabel(label: string | null): boolean { return label?.startsWith(WINDOW_LABEL) ?? false; }

/** What a mirror says in words, by its window's problem. */
export function problemText(problem: WindowProblem): string | null {
  if (problem === null) return null;
  if (problem === 'minimized') return 'Minimized on the PC. Restore it there to see it here.';
  if (problem === 'hidden') return 'Hidden on the PC. Show it there to see it here.';
  if (problem === 'gone') return 'This window was closed on the PC. Close this session, or mirror the window again.';
  if (problem === 'not-forward') return 'The PC did not let this window come forward for input. Try again.';
  if (problem.startsWith('capture-failed')) return `The PC could not capture this window (${problem.slice(15).trim() || 'no reason given'}). It retries by itself.`;
  return problem;
}

export class Mirrors {
  private readonly attached = new Map<string, Attached>();
  /** Mirrors made by this bridge, by when, so a fresh one says "starting" rather than "stopped". */
  private readonly made = new Map<string, number>();
  private readonly listeners = new Set<MirrorListener>();
  private helperDown: string | null = null;
  private server: Server | null = null;

  constructor(private readonly herdr: HerdrClient, private readonly windows: Windows, private readonly socketPath: string, private readonly log: (line: string) => void = () => undefined) {
    windows.listen({
      frame: frame => { for (const [id, a] of this.attached) if (a.hwnd === frame.hwnd) { if (a.problem !== null) this.setProblem(id, null); for (const l of this.listeners) l.frame(id, frame); } },
      problem: (hwnd, problem) => { for (const [id, a] of this.attached) if (a.hwnd === hwnd) this.setProblem(id, problem); },
      down: reason => { this.helperDown = reason; for (const id of this.attached.keys()) for (const l of this.listeners) l.problem(id, reason); },
    });
  }

  listen(listener: MirrorListener): void { this.listeners.add(listener); }

  /** What a mirror session should say now in place of its picture, or null when it is live. */
  note(sessionId: string): string | null {
    const a = this.attached.get(sessionId);
    if (!a) {
      const at = this.made.get(sessionId);
      return at !== undefined && Date.now() - at < ATTACH_MS ? 'Starting the mirror…' : 'This mirror is not running (Herdr or the view restarted). Close this session and mirror the window again.';
    }
    if (this.helperDown) return this.helperDown;
    return problemText(a.problem);
  }

  /** The underlying Windows helper, for direct calls (window fitting). */
  windowHelper(): Windows { return this.windows; }

  /** The PC's open windows. */
  list(): Promise<PcWindow[]> { return this.windows.list(); }

  /** Opens a web address in a new browser window on the PC. */
  open(url: string): Promise<PcWindow> { return this.windows.open(url); }

  /** Makes a mirror session of a window in a workspace; returns its pane id. */
  async make(workspaceId: string, window: PcWindow, focus: boolean): Promise<string> {
    const made = await this.herdr.call('tab.create', { workspace_id: workspaceId, cwd: homedir(), focus: false, env: { [MIRROR_SOCKET_ENV]: this.socketPath } });
    const paneId = paneOf(made.root_pane);
    this.made.set(paneId, Date.now());
    await this.herdr.call('pane.rename', { pane_id: paneId, label: labelFor(window.title) });
    await this.herdr.call('pane.send_input', { pane_id: paneId, text: `node '${MIRROR_SESSION}' ${window.hwnd}`, keys: ['enter'] });
    if (focus) await this.herdr.call('pane.focus', { pane_id: paneId });
    this.log(`mirror of "${window.title}" (${window.app}) made as ${paneId}`);
    return paneId;
  }

  /** Clicks, scrolls or keys for the window a mirror session shows. */
  async input(sessionId: string, events: InputEvent[]): Promise<string | null> {
    const a = this.attached.get(sessionId);
    if (!a) return this.note(sessionId);
    const problem = await this.windows.input(a.hwnd, events);
    return problemText(problem);
  }

  /** Stops captures for mirror sessions Herdr no longer has. */
  sweep(sessionIds: Set<string>): void {
    for (const id of [...this.attached.keys()]) if (!sessionIds.has(id)) this.detach(id);
    for (const id of [...this.made.keys()]) if (!sessionIds.has(id)) this.made.delete(id);
  }

  serve(handleOrder: (order: { open?: string; mirror?: string; workspace: string }) => Promise<string>): Server {
    if (existsSync(this.socketPath)) rmSync(this.socketPath);
    const server = createServer(socket => this.connection(socket, handleOrder));
    server.listen(this.socketPath, () => chmodSync(this.socketPath, 0o600));
    this.server = server;
    return server;
  }

  close(): void {
    for (const id of [...this.attached.keys()]) this.detach(id);
    this.server?.close();
    this.windows.close();
  }

  private connection(socket: Socket, handleOrder: (order: { open?: string; mirror?: string; workspace: string }) => Promise<string>): void {
    let buffer = '';
    let paneId: string | null = null;
    socket.on('error', () => undefined);
    socket.on('close', () => { if (paneId && this.attached.get(paneId)?.socket === socket) this.detach(paneId); });
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8');
      if (buffer.length > 1_000_000) { socket.destroy(); return; }
      let end: number;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        let m: Record<string, unknown>;
        try { m = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
        if (typeof m.attach === 'number' && typeof m.pane === 'string') { paneId = m.pane; void this.attach(m.pane, m.attach, socket); continue; }
        if (typeof m.keys === 'string' && paneId) { void this.keys(paneId, Buffer.from(m.keys, 'base64')); continue; }
        if (typeof m.workspace === 'string' && (typeof m.open === 'string' || typeof m.mirror === 'string')) {
          const order = { workspace: m.workspace, ...(typeof m.open === 'string' ? { open: m.open } : { mirror: m.mirror as string }) };
          void handleOrder(order).then(
            answer => socket.end(`${JSON.stringify({ ok: true, answer })}\n`),
            (error: unknown) => socket.end(`${JSON.stringify({ ok: false, answer: (error as Error).message })}\n`),
          );
        }
      }
    });
  }

  private async attach(paneId: string, hwnd: number, socket: Socket): Promise<void> {
    const before = this.attached.get(paneId);
    if (before && before.socket !== socket) before.socket.destroy();
    this.attached.set(paneId, { hwnd, socket, problem: null });
    try {
      const problem = await this.windows.capture(hwnd, CAPTURE_FPS);
      this.helperDown = null;
      this.setProblem(paneId, problem);
      socket.write(`${JSON.stringify({ attached: true })}\n`);
    } catch (error) {
      this.helperDown = (error as Error).message;
      for (const l of this.listeners) l.problem(paneId, this.helperDown);
      socket.write(`${JSON.stringify({ problem: this.helperDown })}\n`);
    }
  }

  private detach(paneId: string): void {
    const a = this.attached.get(paneId);
    if (!a) return;
    this.attached.delete(paneId);
    a.socket.destroy();
    // Another session may show the same window; its capture stays.
    if (![...this.attached.values()].some(x => x.hwnd === a.hwnd)) void this.windows.stop(a.hwnd).catch(() => undefined);
    for (const l of this.listeners) l.problem(paneId, this.note(paneId));
  }

  private async keys(paneId: string, bytes: Buffer): Promise<void> {
    const events = terminalKeys(bytes);
    if (events.length === 0) return;
    const problem = await this.input(paneId, events).catch((error: unknown) => (error as Error).message);
    if (problem) for (const l of this.listeners) l.notice(`Keys did not reach the window: ${problem}`);
  }

  private setProblem(paneId: string, problem: WindowProblem): void {
    const a = this.attached.get(paneId);
    if (!a) return;
    a.problem = problem;
    for (const l of this.listeners) l.problem(paneId, this.note(paneId));
  }
}
