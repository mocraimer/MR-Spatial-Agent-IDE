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
  /**
   * Each entry is a group: one spoken text split into sentences. The queue cap counts groups,
   * not individual sentences, so a long reply does not push out earlier ones sentence-by-sentence.
   */
  private waiting: string[][] = [];
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

  /**
   * Queues one sentence; the sentence is its own group. Returns false when the voice cannot work.
   * For multi-sentence text use `sayGroup` so the queue cap counts the whole text as one slot.
   */
  say(text: string): boolean { return this.sayGroup([text]); }

  /**
   * Queues a group of sentences as one spoken text. The waiting cap counts groups: a long reply
   * split into 6 sentences is one group and takes one slot, not six. Within a group, sentences are
   * streamed one by one so the first phrase reaches the page before later ones are synthesised.
   * Returns false when the voice cannot work at all.
   */
  sayGroup(texts: string[]): boolean {
    if (texts.length === 0) return false;
    const problem = this.voice.problem();
    if (problem) { this.fail(problem); return false; }
    this.waiting.push(texts);
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
      for (let group = this.waiting.shift(); group !== undefined; group = this.waiting.shift()) {
        const epoch = this.epoch;
        for (const text of group) {
          if (epoch !== this.epoch) break; // stop was called: abandon this group
          try {
            const wav = await this.voice.speak(text);
            if (epoch !== this.epoch) break;
            if (this.failing) { this.failing = false; this.trouble(false); }
            const id = randomUUID();
            this.clips.set(id, wav);
            while (this.clips.size > CLIPS_KEPT) this.clips.delete(this.clips.keys().next().value as string);
            this.emit({ type: 'say', id });
          } catch (error) { this.fail((error as Error).message); break; }
        }
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
