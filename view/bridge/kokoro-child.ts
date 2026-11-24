/**
 * Child-process entry point for Kokoro TTS synthesis.
 *
 * Same protocol as kokoro-worker.ts (ready / failed / speak / done / error) but uses
 * process IPC instead of worker_threads. Running Kokoro in a child process, rather than
 * a worker thread, gives it its own dlopen space: each process independently loads
 * libonnxruntime.so.1, so kokoro-js's nested onnxruntime-node (v1.21.x) and the bridge's
 * @huggingface/transformers v4 onnxruntime-node never share the same SO, eliminating the
 *   libonnxruntime.so.1: version `VERS_1.21.0' not found
 * crash that worker threads produced.
 *
 * Message flow:
 *   parent → child:  { type: 'init'; modelPath: string; voiceId: string }
 *   child  → parent: { type: 'ready' }  |  { type: 'failed'; reason: string }
 *   parent → child:  { type: 'speak'; id: number; text: string }
 *   child  → parent: { type: 'done'; id: number; wav: Buffer }
 *                  | { type: 'error'; id: number; reason: string }
 *
 * The parent must fork with { serialization: 'advanced' } so that Buffer payloads are
 * transferred via V8 structured clone rather than JSON.
 *
 * INV-G4: allowRemoteModels is set to false on the ESM transformers instance before loading.
 * Setting process.env.HF_HUB_OFFLINE is not sufficient because transformers v3 does not read it;
 * we must set env.allowRemoteModels directly on the ESM module instance.
 */
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

type InitMessage  = { type: 'init';  modelPath: string; voiceId: string };
type SpeakMessage = { type: 'speak'; id: number; text: string };
type InMessage    = InitMessage | SpeakMessage;

type ReadyMsg  = { type: 'ready' };
type FailedMsg = { type: 'failed'; reason: string };
type DoneMsg   = { type: 'done';  id: number; wav: Buffer };
type ErrorMsg  = { type: 'error'; id: number; reason: string };
type OutMessage = ReadyMsg | FailedMsg | DoneMsg | ErrorMsg;

function send(msg: OutMessage): void { process.send!(msg); }

type KokoroTTS = { generate(text: string, opts: { voice: string }): Promise<{ toBlob(): { arrayBuffer(): Promise<ArrayBuffer> } }> };

let tts: KokoroTTS | null = null;

// Lower this process's CPU scheduling priority so Kokoro inference does not starve the bridge's
// event loop. The bridge sits in the same scheduler pool; if the Kokoro child runs at the default
// nice level (0) it can consume all available CPU time and delay the bridge's 33 ms Herdr poll.
// Nice +10 keeps synthesis responsive while giving the bridge process first pick of CPU cycles.
import { setPriority } from 'node:os';
try { setPriority(10); } catch { /* non-fatal if the OS denies it */ }

process.once('message', async (msg: InMessage) => {
  if (msg.type !== 'init') { send({ type: 'failed', reason: 'expected init' }); return; }
  const { modelPath, voiceId } = msg;
  try {
    // INV-G4: set allowRemoteModels=false on the ESM transformers instance before importing
    // kokoro-js. transformers v3 does not read HF_HUB_OFFLINE; the env property must be set
    // directly. Import the ESM transformers first (before kokoro-js so they share the instance).
    const kokoroMain = fileURLToPath(await import.meta.resolve('kokoro-js'));
    const esmPath = createRequire(kokoroMain).resolve('@huggingface/transformers')
      .replace('transformers.node.cjs', 'transformers.node.mjs');
    const { env: tenv } = await import(pathToFileURL(esmPath).href) as {
      env: { allowRemoteModels: boolean; allowLocalModels: boolean };
    };
    tenv.allowRemoteModels = false;
    tenv.allowLocalModels  = true;
    const { KokoroTTS: Ctor } = await import('kokoro-js') as { KokoroTTS: { from_pretrained(id: string, opts: { dtype: string; device: string }): Promise<KokoroTTS> } };
    tts = await Ctor.from_pretrained(modelPath, { dtype: 'fp32', device: 'cpu' });
    send({ type: 'ready' });

    // Only register the speak listener after a successful load.
    process.on('message', async (m: InMessage) => {
      if (m.type !== 'speak') return;
      try {
        const audio = await tts!.generate(m.text, { voice: voiceId });
        const wav = Buffer.from(await audio.toBlob().arrayBuffer());
        send({ type: 'done', id: m.id, wav });
      } catch (err) {
        send({ type: 'error', id: m.id, reason: (err as Error).message });
      }
    });
  } catch (err) {
    send({ type: 'failed', reason: (err as Error).message });
    // No message listener registered → event loop drains → process exits naturally.
  }
});
