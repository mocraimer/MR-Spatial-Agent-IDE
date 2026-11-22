/**
 * The bridge on a bench Herdr, driven by text instead of audio: for tests of what the bridge does
 * with each utterance. Speech is scripted; the level agents' programs are stand-ins; every other
 * part is the shipped code.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { HerdrBench, type BenchWorkspace } from '../bench/bench.js';
import { Bridge } from '../bridge/bridge.js';
import { DEFAULT_MIRROR, Mirror } from '../bridge/mirror.js';
import type { Settings } from '../bridge/settings.js';
import { plain } from '../shared/ansi.js';
import { benchAgents, ScriptedSpeech, type StandinAgentOptions } from './fixture.js';

export interface DeskOptions {
  standin?: StandinAgentOptions;
  closeAnswerMs?: number;
  standbyAnswerMs?: number;
  /** Directories put before PATH in the bench's Herdr, e.g. one holding a stand-in `claude`. */
  path?: string[];
  settings?: Settings;
  log?: (line: string) => void;
}

const audio = new Float32Array(1600);
let seq = 0;

export async function setup(layout: BenchWorkspace[], options: DeskOptions = {}) {
  const bench = await HerdrBench.start(layout, { path: options.path ?? [] });
  const data = mkdtempSync('/tmp/svl-');
  const mirror = new Mirror(bench.client, DEFAULT_MIRROR);
  const speech = new ScriptedSpeech();
  const agents = benchAgents(bench, data, options.standin ?? {});
  const bridge = new Bridge(bench.client, mirror, speech, agents, { closeAnswerMs: options.closeAnswerMs ?? 400, ...(options.standbyAnswerMs ? { standbyAnswerMs: options.standbyAnswerMs } : {}), ...(options.settings ? { settings: options.settings } : {}), ...(options.log ? { log: options.log } : {}) });
  mirror.start();
  await bench.waitFor(async () => mirror.shelf().sessions.length === layout.flatMap(w => w.panes).length, 'the mirror to see every session');
  const snap = () => bench.client.snapshot();
  /** Says `text` as one utterance, as heard when `receiver` was in front (by default what is in front now). */
  const say = async (text: string, receiver: string | null = mirror.shelf().focusedId, standby = false) => { speech.queue.push(text); return await bridge.utterance(`u${++seq}`, audio, receiver, standby); };
  /** Says `text` while listening is off: in standby. */
  const sayStandby = (text: string, receiver: string | null = mirror.shelf().focusedId) => say(text, receiver, true);
  /** What a page connected to the bridge would be shown: the latest of each question and the page actions asked of it. */
  const watch = () => {
    const seen = { confirm: null as string | null, ask: null as string | null, pageActions: [] as string[], both: false };
    bridge.connect(event => {
      if (event.type === 'confirm') seen.confirm = event.pending?.name ?? null;
      if (event.type === 'ask') seen.ask = event.ask?.label ?? null;
      if (event.type === 'page') seen.pageActions.push(event.action);
      if (seen.confirm !== null && seen.ask !== null) seen.both = true;
    });
    return seen;
  };
  /** Level-agent seats per workspace label. */
  const seats = async () => {
    const s = await snap();
    return s.panes.filter(p => p.label === 'helper' || p.label === 'project agent').map(p => [s.workspaces.find(w => w.id === p.workspaceId)?.label, p.label]);
  };
  const text = async (id: string) => plain(await bench.client.read(id, 80));
  /** Sessions that ran a line: a stand-in prints "received:" only when Enter reaches it. */
  const received = async () => {
    const out: string[] = [];
    for (const p of (await snap()).panes) if ((await text(p.id)).includes('received:')) out.push(p.id);
    return out;
  };
  const focused = async () => (await snap()).focusedPaneId;
  return {
    bench, data, mirror, speech, agents, bridge, say, sayStandby, watch, seats, text, received, focused, snap,
    stop: async () => { mirror.stop(); await bench.stop(); rmSync(data, { recursive: true, force: true }); },
  };
}
export type Desk = Awaited<ReturnType<typeof setup>>;
