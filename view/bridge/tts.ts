/**
 * Spoken output on the PC: text becomes a WAV with the Windows voice, run through `powershell.exe`
 * from WSL. The text travels only as data, on standard input; the command line is fixed. The WAV
 * comes back on standard output, so no file is ever written. Nothing here leaves the PC.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

/** Where Windows PowerShell is, seen from WSL; `VIEW_POWERSHELL` names another place. */
export const POWERSHELL = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
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
