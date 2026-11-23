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
/** Maximum chunk length for one model call: ~10 seconds at 16kHz. */
const MAX_CHUNK = SAMPLE_RATE * 10;
/** Minimum silence gap to split at: ~200ms. */
const PAUSE_WINDOW = Math.round(SAMPLE_RATE * 0.2);
/** RMS energy below this is considered silence (–40 dBFS ≈ 0.01). */
const SILENCE_RMS = 0.01;

/**
 * Split audio into chunks of at most `MAX_CHUNK` samples, breaking at the last silence gap before
 * the limit. If no silence is found within a chunk, the chunk is cut hard at the limit.
 * Short audio (≤MAX_CHUNK) is returned as-is.
 */
export function splitAtPauses(audio: Float32Array, sampleRate: number = SAMPLE_RATE): Float32Array[] {
  const max = Math.round(sampleRate * 10);
  if (audio.length <= max) return [audio];
  const chunks: Float32Array[] = [];
  let start = 0;
  while (start < audio.length) {
    const end = Math.min(start + max, audio.length);
    if (end === audio.length) { chunks.push(audio.subarray(start)); break; }
    // Find the last silence gap in the window [start, end) by scanning backwards.
    const win = Math.round(sampleRate * 0.2);
    let splitAt = end;
    for (let i = end - win; i > start + win; i -= win) {
      const slice = audio.subarray(i, i + win);
      let sumSq = 0;
      for (let j = 0; j < slice.length; j++) sumSq += (slice[j] ?? 0) * (slice[j] ?? 0);
      const rms = Math.sqrt(sumSq / slice.length);
      if (rms < SILENCE_RMS) { splitAt = i + win; break; }
    }
    chunks.push(audio.subarray(start, splitAt));
    start = splitAt;
  }
  return chunks;
}

/**
 * Collapse immediate repeated word sequences that speech recognition produces when the speaker
 * pauses or stammers: "the the the quick" → "the quick", "please please" → "please".
 * Only collapses runs of 2+ identical consecutive words/phrases.
 */
export function collapseRepeats(text: string): string {
  if (!text) return text;
  // Split into words, then collapse runs of identical consecutive words.
  const words = text.split(/\s+/);
  const out: string[] = [];
  for (const word of words) {
    if (out.length > 0 && out[out.length - 1] === word) continue; // skip repeat
    out.push(word);
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
