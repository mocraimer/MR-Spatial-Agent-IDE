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
    const result: unknown = await this.recognizer(audio);
    const parts = Array.isArray(result) ? result : [result];
    const texts = parts.map(r => (typeof r === 'object' && r !== null && typeof (r as { text?: unknown }).text === 'string' ? (r as { text: string }).text : null));
    if (texts.includes(null)) throw new Error('the speech model answered in a form this view does not read');
    return texts.join(' ').trim();
  }
}

/** Downloads the model into `models`. The only network use of speech, done once at setup. */
export async function fetchModel(models: string): Promise<void> {
  const { env, pipeline } = await import('@huggingface/transformers');
  env.allowRemoteModels = true;
  env.cacheDir = models;
  await pipeline('automatic-speech-recognition', SPEECH_MODEL, { dtype: SPEECH_DTYPE });
}
