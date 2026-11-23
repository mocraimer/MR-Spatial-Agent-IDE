/**
 * The microphone, in the two ways the owner chose: hold to talk (open only while held) and a
 * listening switch (open until turned off; speech is cut into utterances where the owner pauses).
 * The receiver is taken when speech begins, and travels with the utterance.
 *
 * In mixed reality the microphone is armed: when listening is off it stays open, cuts speech at
 * pauses as the listening switch does, and marks each utterance `standby`, so the bridge acts on
 * commands only and only after a "yes". Not armed, listening off means the microphone is closed.
 */

import { MAX_SECONDS, SAMPLE_RATE } from '../shared/audio.js';

export const RATE = SAMPLE_RATE;
const FRAME = 512;
/** Speech must last this many frames to start an utterance, and pause this long to end it. */
const START_FRAMES = 2, END_FRAMES = 22, PRE_ROLL_FRAMES = 10;
const MAX_SAMPLES = RATE * MAX_SECONDS;
const MIN_SAMPLES = RATE * 0.25;

export interface Captured {
  id: string;
  audio: Float32Array;
  receiver: string | null;
  /** Heard while listening was off: the bridge acts on commands only, each after a yes. */
  standby: boolean;
}
/** An open microphone: it calls `push` with 16 kHz samples until `close`. */
export interface Source { close(): void }
export type OpenSource = (push: (samples: Float32Array) => void) => Promise<Source>;

export type MicMode = 'hold' | 'switch';

export class Mic {
  mode: MicMode = 'hold';
  problem: string | null = null;
  /** True while the microphone itself is open, listening or on standby. */
  private live = false;
  /** In mixed reality: listening off leaves the microphone open for commands. */
  private armed = false;
  /** The owner has listening on: a hold to talk is pressed, or keep listening is on. */
  private talking = false;
  /** Listening: the microphone is open and what is said is a prompt. */
  get open(): boolean { return this.live && this.talking; }
  /** Standby: the microphone is open and only commands are acted on. */
  get standby(): boolean { return this.live && !this.talking; }
  private source: Source | null = null;
  private opening: { generation: number; done: Promise<void> } | null = null;
  /** Bumped by stop(): an open that finishes after a stop closes what it opened. */
  private generation = 0;
  private holding = false;
  /** True from a hold-to-talk press until its release, a stop, or the length limit. */
  get isHolding(): boolean { return this.holding; }
  /** True while the microphone is being opened: speech is not heard yet. */
  get isOpening(): boolean { return this.opening !== null; }
  private recording: { receiver: string | null; chunks: Float32Array[]; length: number; standby: boolean } | null = null;
  private pending = new Float32Array(0);
  private preRoll: Float32Array[] = [];
  private loud = 0;
  private quiet = 0;
  private floor = 0.004;

  constructor(
    private readonly openSource: OpenSource,
    private readonly receiverNow: () => string | null,
    private readonly onUtterance: (c: Captured) => void,
    private readonly onChange: () => void,
  ) {}

  setMode(mode: MicMode): void {
    if (mode === this.mode) return;
    this.stop();
    this.mode = mode;
    this.onChange();
  }

  /** Hold to talk: the press. The receiver is the session in front now. */
  async holdStart(): Promise<void> {
    if (this.mode !== 'hold' || this.holding) return;
    this.holding = true;
    this.talking = true;
    this.recording = { receiver: this.receiverNow(), chunks: [], length: 0, standby: false };
    // Already open on standby: the press changes what the microphone is doing, so the page must hear of it.
    this.onChange();
    await this.start();
    if (!this.holding) this.stop();
  }

  /** Hold to talk: the release sends what was said. */
  holdEnd(): void {
    if (this.mode !== 'hold' || !this.holding) return;
    this.holding = false;
    this.finish();
    this.stop();
  }

  async switchOn(): Promise<void> {
    if (this.mode !== 'switch') return;
    this.talking = true;
    this.onChange();
    await this.start();
  }

  /**
   * Turns listening off in either mode; an utterance in progress is dropped, not sent. In mixed
   * reality the microphone stays open on standby; otherwise it closes.
   */
  stop(): void {
    if (!this.armed) { this.close(); return; }
    this.clear();
    this.talking = false;
    this.onChange();
  }

  /** Mixed reality begins: the microphone opens, and stays open for commands while listening is off. */
  async arm(): Promise<void> {
    this.armed = true;
    await this.start();
  }

  /** Mixed reality ends: the microphone closes, whatever it was doing. */
  disarm(): void {
    this.armed = false;
    this.close();
  }

  /** Drops what was being recorded or waited for. */
  private clear(): void {
    this.holding = false;
    this.recording = null;
    this.pending = new Float32Array(0);
    this.preRoll = [];
    this.loud = 0; this.quiet = 0;
  }

  /** Closes the microphone itself. */
  private close(): void {
    this.generation += 1;
    this.clear();
    this.talking = false;
    this.source?.close();
    this.source = null;
    if (this.live) { this.live = false; this.onChange(); }
  }

  /** Every sample the microphone hears comes through here. */
  feed(samples: Float32Array): void {
    if (!this.live) return;
    if (this.holding) {
      if (!this.recording) return;
      this.append(samples);
      // Held past the longest utterance: send what was said and stop listening, so it shows as off.
      if (this.recording.length >= MAX_SAMPLES) { this.finish(); this.stop(); }
      return;
    }
    const joined = new Float32Array(this.pending.length + samples.length);
    joined.set(this.pending); joined.set(samples, this.pending.length);
    let offset = 0;
    for (; offset + FRAME <= joined.length; offset += FRAME) this.frame(joined.slice(offset, offset + FRAME));
    this.pending = joined.slice(offset);
  }

  private frame(frame: Float32Array): void {
    let sum = 0;
    for (const v of frame) sum += v * v;
    const rms = Math.sqrt(sum / frame.length);
    const speaking = rms > Math.max(0.012, this.floor * 3);
    if (!this.recording) {
      if (!speaking) this.floor = this.floor * 0.95 + rms * 0.05;
      this.preRoll.push(frame);
      if (this.preRoll.length > PRE_ROLL_FRAMES) this.preRoll.shift();
      this.loud = speaking ? this.loud + 1 : 0;
      if (this.loud >= START_FRAMES) {
        this.recording = { receiver: this.receiverNow(), chunks: [], length: 0, standby: !this.talking };
        for (const f of this.preRoll) this.append(f);
        this.preRoll = [];
        this.quiet = 0;
        this.onChange();
      }
      return;
    }
    this.append(frame);
    this.quiet = speaking ? 0 : this.quiet + 1;
    if (this.quiet >= END_FRAMES || this.recording.length >= MAX_SAMPLES) { this.finish(); this.loud = 0; }
  }

  private append(samples: Float32Array): void {
    if (!this.recording || this.recording.length >= MAX_SAMPLES) return;
    const room = MAX_SAMPLES - this.recording.length;
    const chunk = samples.length > room ? samples.slice(0, room) : samples.slice();
    this.recording.chunks.push(chunk);
    this.recording.length += chunk.length;
  }

  private finish(): void {
    const r = this.recording;
    this.recording = null;
    if (!r || r.length < MIN_SAMPLES) return;
    const audio = new Float32Array(r.length);
    let at = 0;
    for (const c of r.chunks) { audio.set(c, at); at += c.length; }
    this.onUtterance({ id: crypto.randomUUID(), audio, receiver: r.receiver, standby: r.standby });
  }

  private async start(): Promise<void> {
    if (this.live) return;
    const generation = this.generation;
    // An open begun before the last stop belongs to an older generation: start a fresh one.
    if (this.opening?.generation === generation) { await this.opening.done; return; }
    const done = (async () => {
      try {
        // Audio still queued from a stream closed by a stop belongs to no recording.
        const source = await this.openSource(samples => { if (generation === this.generation) this.feed(samples); });
        if (generation !== this.generation) { source.close(); return; }
        this.source = source;
        this.problem = null;
        this.live = true;
      } catch (error) {
        if (generation !== this.generation) return;
        this.recording = null;
        const name = error instanceof Error ? error.name : '';
        this.problem = name === 'NotAllowedError'
          ? 'Mic refused: allow it in the browser\'s site settings, then select the mic again.'
          : `No microphone: ${error instanceof Error ? error.message : String(error)}`;
      } finally {
        if (this.opening?.generation === generation) this.opening = null;
        this.onChange();
      }
    })();
    this.opening = { generation, done };
    await done;
  }
}

/** The headset's microphone, resampled to 16 kHz mono. */
export const openMicrophone: OpenSource = async push => {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
  let context: AudioContext | null = null;
  let input: MediaStreamAudioSourceNode;
  try {
    context = new AudioContext({ sampleRate: RATE });
    input = context.createMediaStreamSource(stream);
  } catch (error) {
    // A microphone that cannot be wired up is released, never left open.
    stream.getTracks().forEach(t => t.stop());
    void context?.close();
    throw error;
  }
  const audio = context;
  const processor = audio.createScriptProcessor(1024, 1, 1);
  const ratio = audio.sampleRate / RATE;
  processor.onaudioprocess = e => {
    const data = e.inputBuffer.getChannelData(0);
    if (ratio === 1) { push(data.slice()); return; }
    const out = new Float32Array(Math.floor(data.length / ratio));
    for (let i = 0; i < out.length; i += 1) out[i] = data[Math.floor(i * ratio)] as number;
    push(out);
  };
  input.connect(processor);
  processor.connect(audio.destination);
  return { close() { processor.disconnect(); input.disconnect(); stream.getTracks().forEach(t => t.stop()); void audio.close(); } };
};
