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
 *
 * Cache-dir wiring:
 * kokoro-js is an ESM package. Its nested @huggingface/transformers (v3) default-caches files
 * relative to its own dist/ folder. The only reliable way to redirect the cache is to import the
 * ESM transformers module BEFORE importing kokoro-js, set env.cacheDir on that instance, and
 * then import kokoro-js — which finds the same module in Node's ESM registry and therefore uses
 * the cacheDir we set.
 *
 * The old createRequire approach loaded the CJS build of transformers, which is a separate module
 * instance from the ESM build. Setting env.cacheDir on the CJS instance had no effect on the
 * ESM instance that kokoro-js actually used for caching.
 */
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

type InMessage  = { type: 'fetch'; models: string };
type OutMessage = { type: 'done' } | { type: 'failed'; reason: string };

function send(msg: OutMessage): void { process.send!(msg); }

process.once('message', async (msg: InMessage) => {
  if (msg.type !== 'fetch') { send({ type: 'failed', reason: 'expected fetch' }); return; }
  try {
    // Step 1: Resolve the ESM build of @huggingface/transformers that is bundled inside kokoro-js.
    // We use the CJS resolver to find its path, then derive the ESM sibling (.mjs).
    const kokoroMain = fileURLToPath(await import.meta.resolve('kokoro-js'));
    const kokoroRequire = createRequire(kokoroMain);
    const cjsPath = kokoroRequire.resolve('@huggingface/transformers');
    // Both the CJS and ESM builds live in the same dist/ directory.
    const esmPath = cjsPath.replace('transformers.node.cjs', 'transformers.node.mjs');

    // Step 2: Import the ESM transformers module FIRST and redirect its cacheDir.
    // Because Node.js ESM caches by resolved URL, any subsequent import of the same path
    // (including from within kokoro-js) returns this same module instance.
    const { env } = await import(pathToFileURL(esmPath).href) as {
      env: { cacheDir: string; allowRemoteModels: boolean; allowLocalModels: boolean };
    };
    env.cacheDir          = msg.models + '/'; // trailing slash matches transformers v3 convention
    env.allowRemoteModels = true;
    env.allowLocalModels  = true;

    // Step 3: Import kokoro-js. Its static `import { env } from '@huggingface/transformers'`
    // resolves to the same URL we already imported, so it gets the env we modified above.
    const { KokoroTTS } = await import('kokoro-js') as {
      KokoroTTS: { from_pretrained(id: string, opts: { dtype: string; device: string }): Promise<unknown> };
    };

    // Step 4: Download. from_pretrained caches under env.cacheDir = msg.models,
    // so files land at <msg.models>/onnx-community/Kokoro-82M-v1.0-ONNX/.
    await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', { dtype: 'fp32', device: 'cpu' });

    send({ type: 'done' });
  } catch (err) {
    send({ type: 'failed', reason: (err as Error).message });
  }
});
