/**
 * Phrases waiting to be spoken. Each is made into audio one at a time by the voice; the page is
 * told by a `say` event and fetches the audio. The queue, the kept audio and the audio's life are
 * all bounded, and a stop drops what waits and what is being made.
 */
import { randomUUID } from 'node:crypto';
import { VOICE_WAITING_MAX } from '../shared/audio.js';
import type { BridgeEvent } from '../shared/messages.js';
import type { Voice } from './tts.js';

/** Phrases that may wait behind the one being made; an older one is dropped for a newer. */
export const WAITING_MAX = VOICE_WAITING_MAX;
/** Finished audio kept for the page to fetch. */
export const CLIPS_KEPT = 6;

export class Say {
  private readonly clips = new Map<string, Buffer>();
  private waiting: string[] = [];
  private working = false;
  /** Bumped by a stop: audio made before it is thrown away. */
  private epoch = 0;
  private failing = false;

  constructor(
    private readonly voice: Voice,
    private readonly emit: (event: BridgeEvent) => void,
    private readonly notify: (text: string) => void,
    private readonly log: (line: string) => void,
    /** Told when the voice starts failing and when it works again. */
    private readonly trouble: (failing: boolean) => void = () => undefined,
  ) {}

  /** The audio of a phrase made earlier, or undefined. */
  clip(id: string): Buffer | undefined { return this.clips.get(id); }

  /** The voice failed and has not worked since. */
  get failed(): boolean { return this.failing; }

  /** Queues a phrase; returns false when the voice cannot work at all. */
  say(text: string): boolean {
    const problem = this.voice.problem();
    if (problem) { this.fail(problem); return false; }
    this.waiting.push(text);
    while (this.waiting.length > WAITING_MAX) this.waiting.shift();
    void this.run();
    return true;
  }

  /** Ends the phrase being played and drops every phrase that waits. */
  stop(): void {
    this.epoch += 1;
    this.waiting = [];
    this.clips.clear();
    this.emit({ type: 'say-stop' });
  }

  private async run(): Promise<void> {
    if (this.working) return;
    this.working = true;
    try {
      for (let text = this.waiting.shift(); text !== undefined; text = this.waiting.shift()) {
        const epoch = this.epoch;
        try {
          const wav = await this.voice.speak(text);
          if (epoch !== this.epoch) continue;
          if (this.failing) { this.failing = false; this.trouble(false); }
          const id = randomUUID();
          this.clips.set(id, wav);
          while (this.clips.size > CLIPS_KEPT) this.clips.delete(this.clips.keys().next().value as string);
          this.emit({ type: 'say', id });
        } catch (error) { this.fail((error as Error).message); }
      }
    } finally { this.working = false; }
  }

  /** One notice for a run of failures: the log line names what failed and holds none of the words. */
  private fail(message: string): void {
    this.log(`the voice failed: ${message}`);
    if (this.failing) return;
    this.failing = true;
    this.trouble(true);
    this.notify(`The voice did not work (${message}). Answers still show on the shelf; it is tried again with the next phrase.`);
  }
}
