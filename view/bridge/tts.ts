/**
 * Spoken output on the PC: either the Kokoro-82M neural voice in a child process (default), or
 * the Windows voice run through `powershell.exe` from WSL. While Kokoro loads or if it fails,
 * Windows is used. Text travels only as data; nothing here leaves the PC.
 *
 * Kokoro runs in a child process (child_process.fork) rather than a worker thread so that its
 * nested onnxruntime-node (bundled with kokoro-js) lives in a separate OS process with its own
 * dlopen space. Worker threads share the parent process's loaded native libraries, which causes
 * a "version VERS_1.21.0 not found" crash when the main thread has already loaded the speech
 * model's onnxruntime-node. A child process avoids this entirely.
 */
import { fork, spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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

type ChildState = 'loading' | 'ready' | 'failed';
type ChildMsg =
  | { type: 'ready' }
  | { type: 'failed'; reason: string }
  | { type: 'done'; id: number; wav: Buffer }
  | { type: 'error'; id: number; reason: string };

/**
 * Kokoro-82M "af_heart" voice in a child process, with Windows as a fallback while loading or
 * after failure. The child process loads the model once at construction; `speak()` uses whichever
 * voice is active. Callbacks are called when the state changes so the bridge can notify the owner.
 *
 * A child process (fork) is used rather than a worker thread because Kokoro's kokoro-js bundles
 * its own onnxruntime-node. Worker threads share the parent's dlopen'd libraries; if the main
 * thread already loaded @huggingface/transformers v4's onnxruntime-node, the worker's attempt
 * to dlopen a different ORT build fails with "version VERS_1.21.0 not found". A child process
 * has its own dlopen space and loads whatever ORT its kokoro-js requires.
 */
export class KokoroVoice implements Voice {
  private child: ChildProcess | null = null;
  private state: ChildState = 'loading';
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
    if (this.state === 'ready') return null;
    return this.fallback.problem();
  }

  /** True while Windows is standing in (Kokoro is still loading or has failed). */
  standingIn(): boolean { return this.state !== 'ready'; }

  /** PID of the Kokoro child process, or undefined if it has not started or has exited. */
  get childPid(): number | undefined { return this.child?.pid; }

  speak(text: string): Promise<Buffer> {
    if (this.state === 'ready' && this.child) return this.childSpeak(text);
    return this.fallback.speak(text);
  }

  /** Reject all pending phrases and mark state as failed; called on unexpected child death. */
  private childDied(reason: string): void {
    this.state = 'failed';
    this.child = null;
    for (const { reject } of this.pending.values()) reject(new Error('the voice stopped'));
    this.pending.clear();
    this.onFailed(reason);
  }

  private start(): void {
    const childFile = join(dirname(fileURLToPath(import.meta.url)), 'kokoro-child.js');
    // serialization: 'advanced' enables V8 structured clone so Buffer payloads are not
    // JSON-serialised (which would corrupt binary data).
    this.child = fork(childFile, [], { serialization: 'advanced' });
    // Send init data as the first message (replaces workerData from the old worker-thread design).
    this.child.send({ type: 'init', modelPath: this.modelPath, voiceId: this.voiceId });

    this.child.on('message', (msg: ChildMsg) => {
      if (msg.type === 'ready') {
        this.state = 'ready';
        this.onReady();
      } else if (msg.type === 'failed') {
        this.state = 'failed';
        this.child = null;
        this.onFailed(msg.reason);
        // Child exits naturally (no 'speak' listener registered on failure).
      } else if (msg.type === 'done') {
        this.pending.get(msg.id)?.resolve(msg.wav);
        this.pending.delete(msg.id);
      } else if (msg.type === 'error') {
        this.pending.get(msg.id)?.reject(new Error('the voice did not make audio'));
        this.pending.delete(msg.id);
      }
    });

    this.child.on('error', err => {
      if (this.state === 'loading') {
        this.state = 'failed';
        this.child = null;
        this.onFailed(err.message);
      } else {
        this.childDied(err.message);
      }
    });

    this.child.on('exit', code => {
      // A graceful exit after a 'failed' message is expected (child is set to null above).
      if (this.child === null) return;
      this.childDied(`kokoro child exited with code ${code ?? '?'}`);
    });
  }

  private childSpeak(text: string): Promise<Buffer> {
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
      this.child!.send({ type: 'speak', id, text });
    });
  }

  stop(): void {
    for (const { reject } of this.pending.values()) reject(new Error('the voice stopped'));
    this.pending.clear();
    this.child?.kill();
    this.child = null;
  }
}

/**
 * Downloads the Kokoro model into `models` so the voice can run without a network. The only
 * network use of the Kokoro voice, done once at setup.
 *
 * Runs in a forked child process so that kokoro-js's nested onnxruntime-node never loads in
 * the same process as the speech model's onnxruntime-node. If both were in the same process,
 * the second ORT build would fail to dlopen because the first is already resident.
 */
export async function fetchKokoroModel(models: string): Promise<void> {
  const childFile = join(dirname(fileURLToPath(import.meta.url)), 'fetch-kokoro-child.js');
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const ok  = () => { if (!settled) { settled = true; resolve(); } };
    const err = (e: Error) => { if (!settled) { settled = true; reject(e); } };
    const child = fork(childFile, [], { serialization: 'advanced' });
    child.send({ type: 'fetch', models });
    child.on('message', (msg: { type: string; reason?: string }) => {
      if (msg.type === 'done') ok();
      else err(new Error(`Kokoro fetch failed: ${msg.reason ?? 'unknown'}`));
    });
    child.on('error', e => err(e));
    child.on('exit', code => err(new Error(`Kokoro fetch child exited with code ${code ?? '?'} without completing`)));
  });
}
