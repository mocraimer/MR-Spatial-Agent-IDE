/**
 * `node build/view/bench/make-speech.js`: synthesizes the phrases the speech tests say, with
 * the PC's own Windows voices (System.Speech, offline), as 16 kHz mono WAV files in
 * view/tests/audio. The executor has no microphone; the owner's voice is tested in the headset.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO } from '../bridge/config.js';
import { PHRASES, slug } from './phrases.js';

const SCRIPT = `param([string]$text, [string]$out)
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$s.Rate = 1
$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
$s.SetOutputToWaveFile($out, $fmt)
$s.Speak($text)
$s.Dispose()`;

const directory = join(REPO, 'view', 'tests', 'audio');
mkdirSync(directory, { recursive: true });
// Windows reads the script through its \\wsl$ path; it is removed afterwards.
const scratch = mkdtempSync('/tmp/svspeech-');
const script = join(scratch, 'synthesize.ps1');
writeFileSync(script, SCRIPT);
const windows = (path: string) => execFileSync('wslpath', ['-w', path], { encoding: 'utf8' }).trim();
for (const phrase of PHRASES) {
  execFileSync('/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', windows(script), '-text', phrase, '-out', windows(join(directory, `${slug(phrase)}.wav`))], { cwd: '/mnt/c', stdio: 'ignore' });
  console.log(`${slug(phrase)}.wav`);
}
rmSync(scratch, { recursive: true, force: true });
