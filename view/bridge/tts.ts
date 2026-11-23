/**
 * Spoken output on the PC: either the Kokoro-82M neural voice in a worker thread (default), or
 * the Windows voice run through `powershell.exe` from WSL. While Kokoro loads or if it fails,
 * Windows is used. Text travels only as data; nothing here leaves the PC.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { KokoroWorkerData } from './kokoro-worker.js';

/** Where Windows PowerShell is, seen from WSL; `VIEW_POWERSHELL` names another place. */
export const POWERSHELL = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
/** The Kokoro model subfolder inside the models directory. */
export const KOKORO_MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX';
/** The default voice used with the Kokoro model. */
export const KOKORO_VOICE = 'af_heart';
/** A phrase the voice never runs past. */
export const SYNTHESIS_MS = 15_000;
/** The most text one phrase may hold; the callers keep to far less. */
export const PHRASE_MAX = 1200;
/** The largest WAV taken back from the voice (about 90 seconds of audio). */
const WAV_MAX = 4_000_000;

const SCRIPT = [
  "$ErrorActionPreference='Stop'",
  '[Console]::InputEncoding=[Text.Encoding]::UTF8',
  'Add-Type -AssemblyName System.Speech',
  '$text=[Console]::In.ReadToEnd()',
  '$stream=New-Object System.IO.MemoryStream',
  '$voice=New-Object System.Speech.Synthesis.SpeechSynthesizer',
  '$voice.SetOutputToWaveStream($stream)',
  '$voice.Speak($text)',
  '$voice.Dispose()',
  '$bytes=$stream.ToArray()',
  '$out=[Console]::OpenStandardOutput()',
  '$out.Write($bytes,0,$bytes.Length)',
  '$out.Flush()',
].join(';');

/** What the bridge needs from a voice; tests stand in for it. */
export interface Voice {
  /** Why the voice cannot work, or null. */
  problem(): string | null;
  /** A WAV of the text. Rejects with a message that holds none of the words. */
  speak(text: string): Promise<Buffer>;
  /** True when a fallback voice is standing in for the preferred one (e.g. Windows while Kokoro loads). */
  standingIn?(): boolean;
}

export class WindowsVoice implements Voice {
  constructor(private readonly exe: string = process.env.VIEW_POWERSHELL ?? POWERSHELL, private readonly timeoutMs: number = SYNTHESIS_MS) {}

  problem(): string | null {
    return existsSync(this.exe) ? null : 'The voice needs Windows PowerShell, which was not found from WSL.';
  }

  speak(text: string): Promise<Buffer> {
    const said = text.slice(0, PHRASE_MAX);
    return new Promise((resolve, reject) => {
      const child = spawn(this.exe, ['-NoProfile', '-NonInteractive', '-Command', SCRIPT], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
      const chunks: Buffer[] = [];
      let size = 0;
      let settled = false;
      const finish = (error: Error | null, wav?: Buffer) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.kill();
        if (error) reject(error); else resolve(wav as Buffer);
      };
      const timer = setTimeout(() => finish(new Error('the voice did not answer in time')), this.timeoutMs);
      child.on('error', () => finish(new Error('the voice could not be started')));
      child.stdin.on('error', () => undefined);
      child.stdout.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > WAV_MAX) { finish(new Error('the voice answered with too much audio')); return; }
        chunks.push(chunk);
      });
      child.on('close', code => {
        const wav = Buffer.concat(chunks);
        if (code !== 0 || wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF') finish(new Error('the voice made no audio'));
        else finish(null, wav);
      });
      child.stdin.end(said, 'utf8');
    });
  }
}

type WorkerState = 'loading' | 'ready' | 'failed';
type WorkerMsg =
  | { type: 'ready' }
  | { type: 'failed'; reason: string }
  | { type: 'done'; id: number; wav: ArrayBuffer }
  | { type: 'error'; id: number; reason: string };

/**
 * Kokoro-82M "af_heart" voice in a worker thread, with Windows as a fallback while loading or
 * after failure. The worker loads the model once at construction; `speak()` uses whichever voice
 * is active. Callbacks are called when the state changes so the bridge can notify the owner.
 */
export class KokoroVoice implements Voice {
  private worker: Worker | null = null;
  private state: WorkerState = 'loading';
  private readonly pending = new Map<number, { resolve: (wav: Buffer) => void; reject: (err: Error) => void }>();
  private nextId = 0;
  readonly voiceId: string;

  constructor(
    private readonly modelPath: string,
    voice = KOKORO_VOICE,
    private readonly fallback: Voice,
    private readonly onReady: () => void,
    private readonly onFailed: (reason: string) => void,
  ) {
    this.voiceId = voice;
    this.start();
  }

  problem(): string | null {
    // Kokoro is ready: no problem, even if the fallback has one.
    if (this.state === 'ready') return null;
    // Loading or failed: delegate to the fallback which is standing in.
    return this.fallback.problem();
  }

  /** True while Windows is standing in (Kokoro is still loading or has failed). */
  standingIn(): boolean { return this.state !== 'ready'; }

  speak(text: string): Promise<Buffer> {
    if (this.state === 'ready' && this.worker) return this.workerSpeak(text);
    return this.fallback.speak(text);
  }

  /** Reject all pending phrases and mark state as failed; called on unexpected worker death. */
  private workerDied(reason: string): void {
    this.state = 'failed';
    this.worker = null;
    for (const { reject } of this.pending.values()) reject(new Error('the voice stopped'));
    this.pending.clear();
    this.onFailed(reason);
  }

  private start(): void {
    const workerFile = join(dirname(fileURLToPath(import.meta.url)), 'kokoro-worker.js');
    const data: KokoroWorkerData = { modelPath: this.modelPath, voiceId: this.voiceId };
    this.worker = new Worker(workerFile, { workerData: data });
    this.worker.on('message', (msg: WorkerMsg) => {
      if (msg.type === 'ready') {
        this.state = 'ready';
        this.onReady();
      } else if (msg.type === 'failed') {
        this.state = 'failed';
        this.worker?.terminate();
        this.worker = null;
        this.onFailed(msg.reason);
      } else if (msg.type === 'done') {
        this.pending.get(msg.id)?.resolve(Buffer.from(msg.wav));
        this.pending.delete(msg.id);
      } else if (msg.type === 'error') {
        this.pending.get(msg.id)?.reject(new Error('the voice did not make audio'));
        this.pending.delete(msg.id);
      }
    });
    // Handle unexpected worker death in any state.
    this.worker.on('error', err => {
      if (this.state === 'loading') {
        this.state = 'failed';
        this.worker = null;
        this.onFailed(err.message);
      } else {
        this.workerDied(err.message);
      }
    });
    this.worker.on('exit', code => {
      // A graceful exit (code 0) after a 'failed' message is expected; ignore it.
      if (this.worker === null) return;
      // Any other exit (crash, OOM) while the worker is still tracked is a failure.
      this.workerDied(`worker exited with code ${code ?? '?'}`);
    });
  }

  private workerSpeak(text: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('the voice did not answer in time'));
      }, SYNTHESIS_MS);
      this.pending.set(id, {
        resolve: (wav: Buffer) => { clearTimeout(timer); resolve(wav); },
        reject: (err: Error) => { clearTimeout(timer); reject(err); },
      });
      this.worker!.postMessage({ type: 'speak', id, text });
    });
  }

  stop(): void {
    for (const { reject } of this.pending.values()) reject(new Error('the voice stopped'));
    this.pending.clear();
    this.worker?.terminate();
    this.worker = null;
  }
}

/**
 * Downloads the Kokoro model into `models` so the voice can run without a network. The only
 * network use of the Kokoro voice, done once at setup. Uses kokoro-js's own transformers copy
 * and sets its cacheDir so files land in the view's models directory.
 */
export async function fetchKokoroModel(models: string): Promise<void> {
  const { createRequire } = await import('node:module');
  // Access the env from kokoro-js's nested @huggingface/transformers (^3) so we can
  // set cacheDir without touching the project's own transformers (^4).
  const kokoroMain = fileURLToPath(import.meta.resolve('kokoro-js'));
  const kokoroRequire = createRequire(kokoroMain);
  const { env } = kokoroRequire('@huggingface/transformers') as { env: { cacheDir: string; allowRemoteModels: boolean; allowLocalModels: boolean } };
  const prev = { cacheDir: env.cacheDir, remote: env.allowRemoteModels, local: env.allowLocalModels };
  try {
    env.cacheDir = models;
    env.allowRemoteModels = true;
    env.allowLocalModels = true;
    const { KokoroTTS } = await import('kokoro-js');
    await (KokoroTTS as unknown as { from_pretrained(id: string, opts: { dtype: string; device: string }): Promise<unknown> }).from_pretrained(KOKORO_MODEL, { dtype: 'fp32', device: 'cpu' });
  } finally {
    env.cacheDir = prev.cacheDir;
    env.allowRemoteModels = prev.remote;
    env.allowLocalModels = prev.local;
  }
}
