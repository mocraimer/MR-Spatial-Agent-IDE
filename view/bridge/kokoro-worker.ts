/**
 * Worker thread for Kokoro TTS synthesis. Runs off the bridge's main event loop so
 * the 33 ms Herdr poll is not starved. The model loads once at start; each 'speak'
 * message returns a WAV buffer via a transferred ArrayBuffer.
 *
 * INV-G4: no network at run time. `env.allowRemoteModels = false` is set on kokoro-js's
 * own nested @huggingface/transformers before the model is loaded.
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { parentPort, workerData } from 'node:worker_threads';

export interface KokoroWorkerData { modelPath: string; voiceId: string }

type InMessage = { type: 'speak'; id: number; text: string };
type OutMessage =
  | { type: 'ready' }
  | { type: 'failed'; reason: string }
  | { type: 'done'; id: number; wav: ArrayBuffer }
  | { type: 'error'; id: number; reason: string };

const { modelPath, voiceId } = workerData as KokoroWorkerData;

let tts: { generate(text: string, opts: { voice: string }): Promise<{ toBlob(): { arrayBuffer(): Promise<ArrayBuffer> } }> } | null = null;

try {
  // Block remote model loading before kokoro-js loads anything (INV-G4).
  // We access the env through kokoro-js's own nested @huggingface/transformers (^3),
  // not the project's transformers (^4), so the cacheDir points to our local models directory.
  const kokoroMain = fileURLToPath(import.meta.resolve('kokoro-js'));
  const kokoroRequire = createRequire(kokoroMain);
  const { env } = kokoroRequire('@huggingface/transformers') as { env: { allowRemoteModels: boolean; allowLocalModels: boolean; localModelPath: string } };
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.localModelPath = modelPath;

  // Dynamic import so the module path is not resolved at build time.
  const { KokoroTTS } = await import('kokoro-js') as { KokoroTTS: { from_pretrained(id: string, opts: { dtype: string; device: string }): Promise<typeof tts> } };
  tts = await KokoroTTS.from_pretrained(modelPath, { dtype: 'fp32', device: 'cpu' });
  (parentPort as NonNullable<typeof parentPort>).postMessage({ type: 'ready' } satisfies OutMessage);
} catch (error) {
  (parentPort as NonNullable<typeof parentPort>).postMessage({ type: 'failed', reason: (error as Error).message } satisfies OutMessage);
  process.exit(0);
}

(parentPort as NonNullable<typeof parentPort>).on('message', async (msg: InMessage) => {
  if (msg.type !== 'speak') return;
  try {
    const audio = await tts!.generate(msg.text, { voice: voiceId });
    const ab = await audio.toBlob().arrayBuffer();
    (parentPort as NonNullable<typeof parentPort>).postMessage({ type: 'done', id: msg.id, wav: ab } satisfies OutMessage, [ab]);
  } catch (error) {
    (parentPort as NonNullable<typeof parentPort>).postMessage({ type: 'error', id: msg.id, reason: (error as Error).message } satisfies OutMessage);
  }
});
