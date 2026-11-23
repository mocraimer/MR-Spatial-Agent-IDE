/**
 * Speech to text on the PC with a small local English model. At run time the model is read
 * only from the view's data directory; nothing is fetched. `npm run view:setup` fetches it once.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { SpeechState } from '../shared/messages.js';
import type { Transcriber } from './bridge.js';

/**
 * Moonshine tiny, 8-bit weights: about 31 MB on disk, English only. Chosen over Moonshine base
 * (64 MB), Parakeet CTC 110M, zipformer and Whisper tiny/base.en on the view's own phrases: as
 * accurate overall as base, better on short commands, half the size (see the ADR on local speech).
 */
export const SPEECH_MODEL = 'onnx-community/moonshine-tiny-ONNX';
export const SPEECH_DTYPE = 'q8';

/** Sample rate expected by the speech model (16kHz). */
export const SAMPLE_RATE = 16000;

/**
 * Split audio into chunks of at most ~10 seconds, breaking at the quietest 200ms window found
 * between start+1s and end-1s. If no such window exists the chunk is cut hard at the limit.
 * Short audio (≤MAX_CHUNK) is returned as-is. No chunk shorter than ~1s is produced, except
 * the final tail.
 */
export function splitAtPauses(audio: Float32Array, sampleRate: number = SAMPLE_RATE): Float32Array[] {
  const max = Math.round(sampleRate * 10);
  const min = Math.round(sampleRate * 1);
  const win = Math.round(sampleRate * 0.2);
  if (audio.length <= max) return [audio];
  const chunks: Float32Array[] = [];
  let start = 0;
  while (start < audio.length) {
    const end = Math.min(start + max, audio.length);
    if (end === audio.length) { chunks.push(audio.subarray(start)); break; }
    // Scan all 200ms windows in [start+min, end-min] and find the quietest one.
    const scanStart = start + min;
    const scanEnd = end - min - win;
    let splitAt = end; // fallback: hard cut
    if (scanStart <= scanEnd) {
      let quietestRms = Infinity;
      for (let i = scanStart; i <= scanEnd; i += win) {
        const slice = audio.subarray(i, i + win);
        let sumSq = 0;
        for (let j = 0; j < slice.length; j++) sumSq += (slice[j] ?? 0) * (slice[j] ?? 0);
        const rms = Math.sqrt(sumSq / slice.length);
        if (rms < quietestRms) { quietestRms = rms; splitAt = i + win; }
      }
    }
    chunks.push(audio.subarray(start, splitAt));
    start = splitAt;
  }
  return chunks;
}

/** Lower-case the word and strip punctuation, for case/punctuation-insensitive comparison. */
function normWord(w: string): string { return w.toLowerCase().replace(/[^\w]/g, ''); }

/**
 * Collapse immediate repeated word sequences that speech recognition produces when the speaker
 * pauses or stammers. Only collapses when the same 1–3-word phrase repeats 3 or more times
 * consecutively (so "very very" is kept, "the the the" is collapsed to "the"). Comparison
 * ignores case and punctuation; the first occurrence's capitalisation is kept.
 */
export function collapseRepeats(text: string): string {
  if (!text) return text;
  const words = text.trim().split(/\s+/);
  const out: string[] = [];
  let i = 0;
  while (i < words.length) {
    let collapsed = false;
    // Try phrase lengths from 3 down to 1; take the longest that repeats 3+ times.
    for (let len = Math.min(3, Math.floor((words.length - i) / 3)); len >= 1; len--) {
      const phrase = words.slice(i, i + len);
      const normPhrase = phrase.map(normWord);
      let count = 1;
      while (i + count * len + len <= words.length) {
        const next = words.slice(i + count * len, i + count * len + len).map(normWord);
        if (next.length !== len || next.some((w, j) => w !== normPhrase[j])) break;
        count++;
      }
      if (count >= 3) {
        out.push(...phrase); // keep first occurrence
        i += count * len;
        collapsed = true;
        break;
      }
    }
    if (!collapsed) { out.push(words[i] as string); i++; }
  }
  return out.join(' ');
}

type Recognizer = (audio: Float32Array) => Promise<{ text: string } | { text: string }[]>;

export function modelDirectory(dataDirectory: string): string { return join(dataDirectory, 'models'); }

export class LocalSpeech implements Transcriber {
  private recognizer: Recognizer | null = null;
  private current: SpeechState = { ready: false, reason: 'Speech is starting on the PC…' };

  constructor(private readonly models: string) {}

  state(): SpeechState { return this.current; }

  async load(): Promise<void> {
    if (!existsSync(join(this.models, SPEECH_MODEL))) {
      this.current = { ready: false, reason: 'Not set up on the PC: run `npm run view:setup` there once, then restart the view.' };
      return;
    }
    try {
      const { env, pipeline } = await import('@huggingface/transformers');
      env.allowRemoteModels = false;
      env.allowLocalModels = true;
      env.localModelPath = this.models;
      this.recognizer = await pipeline('automatic-speech-recognition', SPEECH_MODEL, { dtype: SPEECH_DTYPE }) as unknown as Recognizer;
      this.current = { ready: true };
    } catch (error) {
      this.current = { ready: false, reason: `Speech could not start on the PC: ${(error as Error).message}` };
    }
  }

  async transcribe(audio: Float32Array): Promise<string> {
    if (!this.recognizer) throw new Error('speech is not ready');
    // Split long audio at pauses into ≤10s chunks so the model never sees too much at once.
    const chunks = splitAtPauses(audio, SAMPLE_RATE);
    const parts: string[] = [];
    for (const chunk of chunks) {
      const result: unknown = await this.recognizer(chunk);
      const rs = Array.isArray(result) ? result : [result];
      const texts = rs.map(r => (typeof r === 'object' && r !== null && typeof (r as { text?: unknown }).text === 'string' ? (r as { text: string }).text : null));
      if (texts.includes(null)) throw new Error('the speech model answered in a form this view does not read');
      parts.push(texts.join(' ').trim());
    }
    return collapseRepeats(parts.filter(Boolean).join(' ').trim());
  }
}

/** Downloads the model into `models`. The only network use of speech, done once at setup. */
export async function fetchModel(models: string): Promise<void> {
  const { env, pipeline } = await import('@huggingface/transformers');
  env.allowRemoteModels = true;
  env.cacheDir = models;
  await pipeline('automatic-speech-recognition', SPEECH_MODEL, { dtype: SPEECH_DTYPE });
}
