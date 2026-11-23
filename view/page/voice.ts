import { VOICE_WAITING_MAX } from '../shared/audio.js';

/**
 * Plays the phrases the bridge makes. The bridge says a phrase is ready (`say`), the page fetches
 * its audio and plays phrases one after another through an audio context. While one plays the
 * microphone must hear nothing (the page tells the Mic), and a stop ends it at once.
 */

/** How long a blocked audio context is given to wake before the phrase is dropped. */
const WAKE_MS = 400;

export class VoicePlayer {
  playing = false;
  /** Phrases played to their end. */
  played = 0;
  /** Why phrases cannot be heard, or null. */
  problem: string | null = null;
  private queue: string[] = [];
  private epoch = 0;
  private running = false;
  private context: AudioContext | null = null;
  private source: AudioBufferSourceNode | null = null;

  constructor(
    private readonly fetchClip: (id: string) => Promise<ArrayBuffer | null>,
    private readonly onChange: () => void,
  ) {}

  /** Called from a tap or key press, when the browser allows sound to start. */
  unlock(): void {
    try {
      this.context ??= new AudioContext();
      void this.context.resume();
    } catch { /* no audio on this page */ }
  }

  enqueue(id: string): void {
    this.queue.push(id);
    while (this.queue.length > VOICE_WAITING_MAX) this.queue.shift();
    void this.run();
  }

  /** Ends the phrase that plays and drops those that wait. */
  stop(): void {
    this.epoch += 1;
    this.queue = [];
    try { this.source?.stop(); } catch { /* it had already ended */ }
  }

  private async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (let id = this.queue.shift(); id !== undefined; id = this.queue.shift()) {
        const epoch = this.epoch;
        try { await this.play(id, epoch); } catch (error) { this.problem = `A phrase could not be played: ${(error as Error).message}`; this.onChange(); }
      }
    } finally { this.running = false; }
  }

  private async play(id: string, epoch: number): Promise<void> {
    const data = await this.fetchClip(id);
    if (!data || epoch !== this.epoch) return;
    this.unlock();
    const context = this.context;
    if (!context) throw new Error('this browser has no audio');
    if (context.state !== 'running') await Promise.race([context.resume(), new Promise(resolve => setTimeout(resolve, WAKE_MS))]);
    if (context.state !== 'running') { this.problem = 'The headset has not allowed sound yet: tap or press anything once.'; this.onChange(); return; }
    const buffer = await context.decodeAudioData(data);
    if (epoch !== this.epoch) return;
    this.problem = null;
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    this.source = source;
    const ended = new Promise<void>(resolve => { source.onended = () => resolve(); });
    this.playing = true;
    this.onChange();
    source.start();
    try { await ended; } finally {
      this.playing = false;
      this.source = null;
      this.played += 1;
      this.onChange();
    }
  }
}
