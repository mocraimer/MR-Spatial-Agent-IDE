/**
 * A bench Herdr and the real bridge on it, for the page's tests. Speech and the level agents'
 * programs are stand-ins unless a test passes the real ones; every other part is the shipped code,
 * the code that finds, makes and starts the level agents' seats included.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { HerdrBench, type BenchWorkspace } from '../bench/bench.js';
import { HerdrLevelAgents, type AgentOptions, type LevelAgents } from '../bridge/agents.js';
import type { Transcriber } from '../bridge/bridge.js';
import { HerdrError } from '../bridge/herdr.js';
import { REPO } from '../bridge/config.js';
import type { Voice } from '../bridge/tts.js';
import { startView, type RunningView, type ViewOptions } from '../bridge/view.js';
import type { ViewState } from '../shared/view-state.js';

export interface Rig { bench: HerdrBench; view: RunningView; data: string; logs: string[]; stop(): Promise<void> }

/** Speech that hears the text a test queues, so routing can be tested without audio. */
export class ScriptedSpeech implements Transcriber {
  readonly queue: string[] = [];
  state() { return { ready: true as const }; }
  async transcribe(): Promise<string> { return this.queue.shift() ?? ''; }
}

export interface StandinAgentOptions {
  /** Waits this long before the stand-in starts, as a slow agent would. */
  delayMs?: number;
  /** Makes every start fail with this message. */
  fail?: string;
  /** Makes every start end as Herdr's does when the agent asks a question as it starts. */
  ask?: boolean;
}

/**
 * Level agents whose programs are the bench's stand-ins: the seats are found, made and labelled
 * by the shipped code; only the program started in a seat differs.
 */
export function benchAgents(bench: HerdrBench, data: string, options: StandinAgentOptions = {}): LevelAgents {
  const launcher = (name: string): AgentOptions => ({
    kind: 'standin', args: [], cwd: bench.directory,
    launch: async paneId => {
      if (options.delayMs) await new Promise(resolve => setTimeout(resolve, options.delayMs));
      if (options.fail) throw new Error(options.fail);
      if (options.ask) throw new HerdrError('agent_not_ready', 'the agent asks something');
      await bench.startPane(paneId, { name, kind: 'agent' });
    },
  });
  return new HerdrLevelAgents(bench.client, { helper: launcher('helper'), project: launcher('project-agent') }, join(data, 'helper.sock'));
}

export async function rig(layout: BenchWorkspace[], options: Partial<ViewOptions> | ((bench: HerdrBench, data: string) => Partial<ViewOptions>) = {}): Promise<Rig> {
  const bench = await HerdrBench.start(layout);
  const data = mkdtempSync('/tmp/svt-');
  const extra = typeof options === 'function' ? options(bench, data) : options;
  const logs: string[] = [];
  const view = await startView({
    herdrSocket: bench.socketPath,
    dataDirectory: data,
    host: '127.0.0.1',
    port: 0,
    speech: new ScriptedSpeech(),
    agents: benchAgents(bench, data),
    // No test makes real audio unless it asks to.
    voice: null,
    log: line => logs.push(line),
    showPairingCode: () => undefined,
    ...extra,
  });
  return {
    bench, view, data, logs,
    async stop() { await view.stop(); await bench.stop(); rmSync(data, { recursive: true, force: true }); },
  };
}

/** Opens the page and pairs it through its own form. */
export async function pair(page: Page, r: Rig): Promise<void> {
  await page.goto(r.view.url);
  await page.locator('#code').fill(r.view.pairing.setupCode().code);
  await page.getByRole('button', { name: 'Pair this headset' }).click();
  await page.waitForFunction(() => (window.viewState() as { link: string }).link === 'live');
}

export async function viewState(page: Page): Promise<ViewState> {
  return await page.evaluate(() => window.viewState());
}

/** Every session the page shows, with its light and project: tiles of the current place, and the sessions on each chip. */
export function shownSessions(state: ViewState): { id: string; light: string; project: string }[] {
  return [
    ...state.columns.flatMap(c => c.tiles.filter(t => !t.closed).map(t => ({ id: t.id, light: t.light, project: c.project }))),
    ...state.chips.filter(c => !c.overview).flatMap(c => c.sessions.map(s => ({ id: s.id, light: s.light, project: c.project }))),
  ];
}

/** A session's light as the page shows it: on a tile of the current place, or on its project's chip. */
export function shownLight(state: ViewState, paneId: string): string | undefined {
  return shownSessions(state).find(s => s.id === paneId)?.light;
}

/** The pane of a level agent in the bench: the helper's seat, or the agent seat of a project. */
export async function seatOf(bench: HerdrBench, workspaceLabel: string): Promise<string | undefined> {
  const s = await bench.client.snapshot();
  const ws = s.workspaces.find(w => w.label === workspaceLabel)?.id;
  return s.panes.find(p => p.workspaceId === ws && (p.label === 'helper' || p.label === 'project agent'))?.id;
}

const IWER = readFileSync(join(REPO, 'node_modules', 'iwer', 'build', 'iwer.min.js'), 'utf8');

/** Installs Meta's WebXR emulator (a Quest 3) in the page before its scripts run. */
export async function emulateQuest(page: Page): Promise<void> {
  await page.addInitScript({ content: `${IWER};\nwindow.__xr = new IWER.XRDevice(IWER.metaQuest3); window.__xr.installRuntime({ forceInstall: true });` });
}

/** Clicks "Enter mixed reality" and waits for the immersive session and its first frames. */
export async function enterMixedReality(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Enter mixed reality' }).click();
  await page.waitForFunction(() => (window.viewState() as { immersive: boolean }).immersive);
  await page.waitForTimeout(300);
}

type Input = 'controller' | 'hand';
interface Vec { x: number; y: number; z: number; set(...v: number[]): void }
interface Tracked { position: Vec; quaternion: Vec & { w: number } }
/** The parts of IWER's emulated Quest the tests drive. */
interface Emulator {
  position: Vec;
  primaryInputMode: Input;
  controllers: { right: Tracked & { updateButtonValue(id: string, value: number): void } };
  hands: { right: Tracked & { updatePinchValue(value: number): void } };
}
/**
 * Points the right controller or hand at a spot on a surface (x, y as fractions of its canvas)
 * from a little in front of it, as a person's ray would.
 */
export async function aim(page: Page, input: Input, surface: string, x = 0.5, y = 0.5): Promise<void> {
  const ok = await page.evaluate(({ input, surface, x, y }) => {
    const xr = (window as unknown as { __xr: Emulator }).__xr;
    const target = window.viewTest.worldPoint(surface, x, y);
    if (!target) return false;
    const [tx, ty, tz] = target;
    // The page's 'local' space starts at the head; IWER poses inputs in its global space.
    const w = window as unknown as { __head?: [number, number, number] };
    w.__head ??= [xr.position.x, xr.position.y, xr.position.z];
    const [hx, hy, hz] = w.__head;
    const [ax, ay, az] = [tx * 0.6, ty * 0.6, tz * 0.6];
    const len = Math.hypot(tx - ax, ty - ay, tz - az);
    const [nx, ny, nz] = [(tx - ax) / len, (ty - ay) / len, (tz - az) / len];
    // Shortest rotation taking -Z onto n: axis (-Z x n), w = 1 + (-Z . n).
    const [cx, cy, cz, cw] = [ny, -nx, 0, 1 - nz];
    const ql = Math.hypot(cx, cy, cz, cw);
    xr.primaryInputMode = input;
    const device = input === 'hand' ? xr.hands.right : xr.controllers.right;
    device.position.set(ax + hx, ay + hy, az + hz);
    device.quaternion.set(cx / ql, cy / ql, cz / ql, cw / ql);
    return true;
  }, { input, surface, x, y });
  if (!ok) throw new Error(`No surface ${surface} to aim at`);
  await page.waitForTimeout(150);
}

/** Pinch (hand) or trigger (controller) down and up, with frames in between. */
export async function press(page: Page, input: Input, holdMs = 120): Promise<void> {
  await setPressed(page, input, 1);
  await page.waitForTimeout(holdMs);
  await setPressed(page, input, 0);
  await page.waitForTimeout(150);
}
export async function setPressed(page: Page, input: Input, value: number): Promise<void> {
  await page.evaluate(({ input, value }) => {
    const xr = (window as unknown as { __xr: Emulator }).__xr;
    if (input === 'hand') xr.hands.right.updatePinchValue(value); else xr.controllers.right.updateButtonValue('trigger', value);
  }, { input, value });
}
export async function squeeze(page: Page, value: number): Promise<void> {
  await page.evaluate(value => { (window as unknown as { __xr: Emulator }).__xr.controllers.right.updateButtonValue('squeeze', value); }, value);
}

/** The point of a button region on a surface, as fractions of the surface. */
export async function regionPoint(page: Page, surface: string, id: string): Promise<{ x: number; y: number }> {
  // A region appears on the frame after the state that draws it.
  const handle = await page.waitForFunction(({ surface, id }) => window.viewTest.region(surface, id), { surface, id }, { timeout: 5000 });
  return await handle.jsonValue() as { x: number; y: number };
}

/** A 16 kHz mono 16-bit WAV from view/tests/audio as samples. */
export function wav(slug: string): number[] {
  const b = readFileSync(join(REPO, 'view', 'tests', 'audio', `${slug}.wav`));
  for (let o = 12; o + 8 <= b.length;) {
    const id = b.toString('ascii', o, o + 4), size = b.readUInt32LE(o + 4);
    if (id === 'data') return Array.from({ length: size / 2 }, (_, i) => b.readInt16LE(o + 8 + i * 2) / 32768);
    o += 8 + size;
  }
  throw new Error(`${slug}.wav has no data`);
}
const silence = (seconds: number) => new Array<number>(Math.round(16000 * seconds)).fill(0);

/** Feeds samples to the page's microphone path in 64 ms pieces, as a microphone would. */
export async function feed(page: Page, samples: number[]): Promise<void> {
  for (let i = 0; i < samples.length; i += 1024) await page.evaluate(s => window.viewTest.feed(s), samples.slice(i, i + 1024));
}

/**
 * Says a phrase into the page. Hold to talk holds the ` key while speaking; the listening switch
 * must already be on and cuts the utterance at the pause that follows.
 */
export async function say(page: Page, slug: string, beforeRelease?: () => Promise<void>): Promise<void> {
  const before = (await viewState(page)).last;
  const mode = (await viewState(page)).mic.mode;
  if (mode === 'hold') {
    const pressed = Date.now();
    await page.keyboard.down('Backquote');
    await page.waitForFunction(() => (window.viewState() as { mic: { open: boolean } }).mic.open);
    await feed(page, wav(slug));
    await beforeRelease?.();
    // Audio is fed faster than it is spoken; a press this short would count as a tap (keep listening).
    await page.waitForTimeout(Math.max(0, 500 - (Date.now() - pressed)));
    await page.keyboard.up('Backquote');
  } else {
    await feed(page, [...silence(0.3), ...wav(slug), ...silence(1.0)]);
  }
  await page.waitForFunction(b => {
    const s = window.viewState() as { last: unknown; hearing: number };
    return s.hearing === 0 && JSON.stringify(s.last) !== b;
  }, JSON.stringify(before), { timeout: 20_000 });
}

/**
 * Says a phrase while listening is off, in mixed reality: the microphone is open on standby, so
 * the audio is simply fed and cut at the pause that follows. Waits until the page shows the result.
 */
export async function sayStandby(page: Page, slug: string): Promise<void> {
  const before = (await viewState(page)).last;
  await feed(page, [...silence(0.3), ...wav(slug), ...silence(1.0)]);
  await page.waitForFunction(b => {
    const s = window.viewState() as { last: unknown; hearing: number };
    return s.hearing === 0 && JSON.stringify(s.last) !== b;
  }, JSON.stringify(before), { timeout: 20_000 });
}

/** Points at a button on a surface and selects it. */
export async function tap(page: Page, input: Input, surface: string, id: string): Promise<void> {
  const p = await regionPoint(page, surface, id);
  await aim(page, input, surface, p.x, p.y);
  await press(page, input);
}

/** A silent WAV of this many seconds: 22.05 kHz, mono, 16-bit, as the Windows voice makes. */
export function silentWav(seconds: number): Buffer {
  const rate = 22050, samples = Math.round(rate * seconds), data = samples * 2;
  const b = Buffer.alloc(44 + data);
  b.write('RIFF', 0); b.writeUInt32LE(36 + data, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(data, 40);
  return b;
}

/** A voice that records what it is asked to say and answers silence, or fails or is unavailable as a test says. */
export class FakeVoice implements Voice {
  readonly spoken: string[] = [];
  mode: 'ok' | 'fail' | 'unavailable' = 'ok';
  seconds = 0.3;
  problem(): string | null { return this.mode === 'unavailable' ? 'No voice here.' : null; }
  speak(text: string): Promise<Buffer> {
    this.spoken.push(text);
    if (this.mode === 'fail') return Promise.reject(new Error('the voice made no audio'));
    return Promise.resolve(silentWav(this.seconds));
  }
}
