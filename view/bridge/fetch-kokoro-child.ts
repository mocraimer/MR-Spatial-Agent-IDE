/**
 * Child-process entry point for downloading the Kokoro model.
 *
 * Run as a fork (child process) from fetchKokoroModel() so that kokoro-js's nested
 * onnxruntime-node never loads in the same process as the speech model's onnxruntime-node.
 *
 * Usage: forked with { serialization: 'advanced' }. Receives one message:
 *   { type: 'fetch'; models: string }
 * Sends back:
 *   { type: 'done' }  |  { type: 'failed'; reason: string }
 * then exits.
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

type InMessage  = { type: 'fetch'; models: string };
type OutMessage = { type: 'done' } | { type: 'failed'; reason: string };

function send(msg: OutMessage): void { process.send!(msg); }

process.once('message', async (msg: InMessage) => {
  if (msg.type !== 'fetch') { send({ type: 'failed', reason: 'expected fetch' }); return; }
  try {
    // Access kokoro's nested @huggingface/transformers (v3) to set its cacheDir,
    // so from_pretrained downloads into msg.models rather than the default HF cache.
    const kokoroMain = fileURLToPath(import.meta.resolve('kokoro-js'));
    const kokoroRequire = createRequire(kokoroMain);
    const { env } = kokoroRequire('@huggingface/transformers') as {
      env: { cacheDir: string; allowRemoteModels: boolean; allowLocalModels: boolean };
    };
    const prev = { cacheDir: env.cacheDir, remote: env.allowRemoteModels, local: env.allowLocalModels };
    try {
      env.cacheDir = msg.models;
      env.allowRemoteModels = true;
      env.allowLocalModels = true;
      const { KokoroTTS } = await import('kokoro-js') as {
        KokoroTTS: { from_pretrained(id: string, opts: { dtype: string; device: string }): Promise<unknown> };
      };
      await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', { dtype: 'fp32', device: 'cpu' });
    } finally {
      env.cacheDir = prev.cacheDir;
      env.allowRemoteModels = prev.remote;
      env.allowLocalModels = prev.local;
    }
    send({ type: 'done' });
  } catch (err) {
    send({ type: 'failed', reason: (err as Error).message });
  }
});
