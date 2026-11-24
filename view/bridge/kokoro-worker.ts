/**
 * Worker thread for Kokoro TTS synthesis. Runs off the bridge's main event loop so
 * the 33 ms Herdr poll is not starved. The model loads once at start; each 'speak'
 * message returns a WAV buffer via a transferred ArrayBuffer.
 *
 * INV-G4: no network at run time. HF_HUB_OFFLINE=1 is set via process.env before
 * kokoro-js loads, which causes @huggingface/transformers to disable remote fetches.
 * This avoids the createRequire dance that conflicts with the native onnxruntime binary.
 */
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

const port = parentPort as NonNullable<typeof parentPort>;

try {
  // INV-G4: block remote model loading before kokoro-js loads anything.
  // HF_HUB_OFFLINE=1 is read by @huggingface/hub (used by transformers.js) at import time,
  // so setting it here (before the dynamic import below) is sufficient.
  process.env.HF_HUB_OFFLINE = '1';

  // Dynamic import so the module path is not resolved at build time.
  const { KokoroTTS } = await import('kokoro-js') as { KokoroTTS: { from_pretrained(id: string, opts: { dtype: string; device: string }): Promise<typeof tts> } };
  tts = await KokoroTTS.from_pretrained(modelPath, { dtype: 'fp32', device: 'cpu' });
  port.postMessage({ type: 'ready' } satisfies OutMessage);

  // Only register the message listener on success. If we registered it unconditionally,
  // a failed worker would stay alive waiting for messages, forcing the parent to call
  // terminate(). Terminating a worker that has the onnxruntime native addon loaded corrupts
  // the addon's global registration state, so subsequent workers fail with
  // "Module did not self-register". By exiting naturally on failure (no listener, no
  // process.exit), the addon cleans up without corrupting shared state.
  port.on('message', async (msg: InMessage) => {
    if (msg.type !== 'speak') return;
    try {
      const audio = await tts!.generate(msg.text, { voice: voiceId });
      const ab = await audio.toBlob().arrayBuffer();
      port.postMessage({ type: 'done', id: msg.id, wav: ab } satisfies OutMessage, [ab]);
    } catch (error) {
      port.postMessage({ type: 'error', id: msg.id, reason: (error as Error).message } satisfies OutMessage);
    }
  });
} catch (error) {
  port.postMessage({ type: 'failed', reason: (error as Error).message } satisfies OutMessage);
  // The worker now exits naturally: no message listener is registered, so the event loop
  // drains immediately after this catch block. The parent does NOT call terminate() on
  // failure (see tts.ts) for the same reason.
}
