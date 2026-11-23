/**
 * The PC's windows, through the helper on Windows (`view/windows/window_helper.py`): the list of
 * open windows, the pictures of the ones mirrored, input to them, and pages opened in a browser.
 *
 * The bridge starts the helper the first time it is needed, through WSL interop, and speaks JSON
 * lines over its stdin and stdout, so the helper listens on no port. At most one helper runs; it
 * stops with the bridge. Tests put a stand-in in its place (`SPATIAL_WINDOW_HELPER`).
 */
import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { REPO } from './config.js';

export interface PcWindow { hwnd: number; title: string; app: string }
/** Why a window shows no live picture: minimized, hidden, gone, or its capture failed. */
export type WindowProblem = string | null;
export interface Frame { hwnd: number; w: number; h: number; mime: string; data: string }
export type InputEvent =
  | { type: 'click'; x: number; y: number }
  | { type: 'wheel'; x: number; y: number; delta: number }
  | { type: 'text'; text: string }
  | { type: 'key'; key: string; mods?: ('ctrl' | 'alt' | 'shift')[] };

export interface WindowListener {
  frame(frame: Frame): void;
  problem(hwnd: number, problem: WindowProblem): void;
  /** The helper itself stopped or could not start; every capture is off until it is back. */
  down(reason: string): void;
}

/** What the bridge needs from the PC's windows. */
export interface Windows {
  list(): Promise<PcWindow[]>;
  capture(hwnd: number, fps: number): Promise<WindowProblem>;
  stop(hwnd: number): Promise<void>;
  input(hwnd: number, events: InputEvent[]): Promise<WindowProblem>;
  open(url: string): Promise<PcWindow>;
  listen(listener: WindowListener): void;
  close(): void;
}

const REQUEST_MS = 20_000;
/** Opening a page waits for a browser to start (the helper gives up after about 13 s). */
const OPEN_MS = 30_000;

/** The command that starts the helper: a stand-in named by the environment, else Windows Python. */
export function helperCommand(): { file: string; args: string[] } | { problem: string } {
  const standIn = process.env.SPATIAL_WINDOW_HELPER;
  if (standIn) { const [file, ...args] = standIn.split(' '); return { file: file as string, args }; }
  const script = join(REPO, 'view', 'windows', 'window_helper.py');
  const launcher = pyLauncher();
  if (!launcher) return { problem: 'Windows Python was not found. Install Python 3.12 on Windows, then run: py -3.12 -m pip install --user windows-capture pywin32' };
  let windowsPath: string;
  try { windowsPath = execFileSync('wslpath', ['-w', script], { encoding: 'utf8' }).trim(); } catch { return { problem: 'The view runs outside WSL, so it cannot reach the PC\'s windows.' }; }
  return { file: launcher, args: ['-3.12', '-u', windowsPath] };
}

/** Windows' Python launcher: named by the environment, installed for all users, or in the owner's profile. */
function pyLauncher(): string | null {
  const named = process.env.SPATIAL_PY_LAUNCHER;
  if (named) return existsSync(named) ? named : null;
  if (existsSync('/mnt/c/Windows/py.exe')) return '/mnt/c/Windows/py.exe';
  try {
    const local = execFileSync('/mnt/c/Windows/System32/cmd.exe', ['/c', 'echo %LOCALAPPDATA%'], { encoding: 'utf8', cwd: '/mnt/c', timeout: 10_000 }).trim();
    const p = join(execFileSync('wslpath', ['-u', local], { encoding: 'utf8' }).trim(), 'Programs', 'Python', 'Launcher', 'py.exe');
    return existsSync(p) ? p : null;
  } catch { return null; }
}

export class HelperWindows implements Windows {
  private child: ChildProcessWithoutNullStreams | null = null;
  private starting: Promise<ChildProcessWithoutNullStreams> | null = null;
  private next = 1;
  private readonly waiting = new Map<number, { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private readonly listeners = new Set<WindowListener>();
  private closed = false;

  constructor(private readonly log: (line: string) => void = () => undefined) {}

  listen(listener: WindowListener): void { this.listeners.add(listener); }

  async list(): Promise<PcWindow[]> {
    const r = await this.request({ op: 'list' });
    return Array.isArray(r.windows) ? r.windows.filter(isWindow) : [];
  }

  async capture(hwnd: number, fps: number): Promise<WindowProblem> {
    const r = await this.request({ op: 'capture', hwnd, fps });
    return typeof r.problem === 'string' ? r.problem : null;
  }

  async stop(hwnd: number): Promise<void> { if (this.child && !this.closed) await this.request({ op: 'stop', hwnd }); }

  async input(hwnd: number, events: InputEvent[]): Promise<WindowProblem> {
    const r = await this.request({ op: 'input', hwnd, events });
    return typeof r.problem === 'string' ? r.problem : null;
  }

  async open(url: string): Promise<PcWindow> {
    const r = await this.request({ op: 'open', url }, OPEN_MS);
    if (!isWindow(r.window)) throw new Error('The helper did not say which window it opened.');
    return r.window;
  }

  close(): void {
    this.closed = true;
    const child = this.child;
    this.child = null;
    if (child) { child.stdin.end(); setTimeout(() => { if (child.exitCode === null) child.kill(); }, 2000).unref(); }
  }

  private async request(body: Record<string, unknown>, timeoutMs = REQUEST_MS): Promise<Record<string, unknown>> {
    const child = await this.ensure();
    if (this.closed || !child.stdin.writable) throw new Error('The view is stopping.');
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.waiting.delete(id); reject(new Error('The PC\'s window helper did not answer in time.')); }, timeoutMs);
      this.waiting.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ id, ...body })}\n`);
    });
  }

  private ensure(): Promise<ChildProcessWithoutNullStreams> {
    if (this.closed) return Promise.reject(new Error('The view is stopping.'));
    if (this.child) return Promise.resolve(this.child);
    this.starting ??= this.start().finally(() => { this.starting = null; });
    return this.starting;
  }

  private start(): Promise<ChildProcessWithoutNullStreams> {
    const command = helperCommand();
    if ('problem' in command) return Promise.reject(new Error(command.problem));
    return new Promise((resolve, reject) => {
      const child = spawn(command.file, command.args, { cwd: command.file.startsWith('/mnt/') ? '/mnt/c' : undefined, stdio: ['pipe', 'pipe', 'pipe'] });
      let ready = false;
      let errText = '';
      child.stderr.on('data', (chunk: Buffer) => { errText = (errText + chunk.toString('utf8')).slice(-2000); });
      child.on('error', error => { if (!ready) reject(new Error(`The PC's window helper did not start: ${error.message}`)); });
      child.on('exit', code => {
        if (this.child === child) this.child = null;
        for (const [id, w] of this.waiting) { clearTimeout(w.timer); w.reject(new Error('The PC\'s window helper stopped.')); this.waiting.delete(id); }
        const reason = helperProblem(errText) ?? `The PC's window helper stopped (exit ${code ?? 'signal'}).`;
        if (!ready) { reject(new Error(reason)); return; }
        if (!this.closed) { this.log(reason); for (const l of this.listeners) l.down(reason); }
      });
      createInterface({ input: child.stdout }).on('line', line => {
        let m: Record<string, unknown>;
        try { m = JSON.parse(line) as Record<string, unknown>; } catch { return; }
        if (m.ready === true && !ready) { ready = true; this.child = child; resolve(child); return; }
        if (typeof m.id === 'number') {
          const w = this.waiting.get(m.id);
          if (!w) return;
          clearTimeout(w.timer); this.waiting.delete(m.id);
          if (m.ok === true) w.resolve(m); else w.reject(new Error(typeof m.error === 'string' ? m.error : 'The window helper refused.'));
          return;
        }
        if (typeof m.frame === 'number' && typeof m.data === 'string' && typeof m.w === 'number' && typeof m.h === 'number') {
          const frame: Frame = { hwnd: m.frame, w: m.w, h: m.h, mime: typeof m.mime === 'string' ? m.mime : 'image/jpeg', data: m.data };
          for (const l of this.listeners) l.frame(frame);
          return;
        }
        if (typeof m.window === 'number') for (const l of this.listeners) l.problem(m.window, typeof m.problem === 'string' ? m.problem : null);
      });
    });
  }
}

function isWindow(v: unknown): v is PcWindow {
  const w = v as Partial<PcWindow> | null;
  return typeof w === 'object' && w !== null && typeof w.hwnd === 'number' && typeof w.title === 'string' && typeof w.app === 'string';
}

/** What a helper's error output means for the owner, when it is one of the known setup gaps. */
function helperProblem(stderr: string): string | null {
  if (/No module named '?windows_capture/.test(stderr)) return 'The PC is missing the windows-capture package. On Windows run: py -3.12 -m pip install --user windows-capture pywin32';
  if (/No module named '?(win32|cv2)/.test(stderr)) return 'The PC is missing a Python package for window capture. On Windows run: py -3.12 -m pip install --user windows-capture pywin32';
  if (/Python 3\.12 not found|No suitable Python runtime/i.test(stderr)) return 'Python 3.12 is not installed on Windows. Install it, then run: py -3.12 -m pip install --user windows-capture pywin32';
  return null;
}
