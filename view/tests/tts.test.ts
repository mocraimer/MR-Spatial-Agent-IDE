/**
 * The Windows voice's process boundary: what it is run with, how it fails, and one real synthesis
 * on this PC (skipped where Windows PowerShell is not there). The text is an agent's reply or
 * transcribed speech, so it must reach the voice as data and run nothing.
 * Also tests KokoroVoice: fallback behavior with a missing model, and (when KOKORO_TEST_DIR is set)
 * a real Kokoro synthesis to verify af_heart voice and 24kHz WAV output.
 */
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { KokoroVoice, WindowsVoice, KOKORO_MODEL, KOKORO_VOICE, PHRASE_MAX } from '../bridge/tts.js';

/** A stand-in for powershell.exe: a node script run as the voice's executable. */
function standin(directory: string, name: string, body: string): string {
  const file = join(directory, name);
  writeFileSync(file, `#!/usr/bin/env node\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
}
const WAV = "const wav = Buffer.alloc(100); wav.write('RIFF', 0); process.stdout.write(wav);";

test('the voice is run with a fixed command line and the text only on standard input: a phrase full of shell syntax runs nothing', async () => {
  const dir = mkdtempSync('/tmp/svl-tts-');
  try {
    const marker = join(dir, 'marker');
    const exe = standin(dir, 'record.mjs', `
      import { writeFileSync } from 'node:fs';
      let input = '';
      process.stdin.on('data', c => { input += c; });
      process.stdin.on('end', () => {
        writeFileSync(${JSON.stringify(join(dir, 'argv.json'))}, JSON.stringify(process.argv.slice(2)));
        writeFileSync(${JSON.stringify(join(dir, 'stdin.txt'))}, input);
        ${WAV}
      });`);
    const nasty = `hello "quoted" 'single' $(touch ${marker}) \`touch ${marker}\` ; touch ${marker} & | > ${marker} %PATH% $env:PATH\nsecond line ünï — ${'long '.repeat(500)}`;
    const wav = await new WindowsVoice(exe).speak(nasty);
    assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
    const argv = JSON.parse(readFileSync(join(dir, 'argv.json'), 'utf8')) as string[];
    assert.deepEqual(argv.slice(0, 3), ['-NoProfile', '-NonInteractive', '-Command']);
    assert.equal(argv.length, 4, 'one script argument, fixed');
    assert.equal(argv.some(a => a.includes('touch') || a.includes('hello')), false, 'no word of the phrase is in the command line');
    assert.equal(readFileSync(join(dir, 'stdin.txt'), 'utf8'), nasty.slice(0, PHRASE_MAX), 'the text arrived whole (up to the bound) as data');
    assert.equal(existsSync(marker), false, 'nothing in the phrase was run');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a voice that hangs is stopped after its bound, one that makes no audio or too much audio fails, and a missing one says so', async () => {
  const dir = mkdtempSync('/tmp/svl-tts-');
  try {
    const hang = standin(dir, 'hang.mjs', 'setTimeout(() => undefined, 60000);');
    const started = Date.now();
    await assert.rejects(new WindowsVoice(hang, 300).speak('x'), /did not answer in time/);
    assert.ok(Date.now() - started < 3000, 'the bound held');
    await assert.rejects(new WindowsVoice(standin(dir, 'empty.mjs', 'process.stdout.write("hello");'), 5000).speak('x'), /made no audio/);
    await assert.rejects(new WindowsVoice(standin(dir, 'fail.mjs', 'process.exit(3);'), 5000).speak('x'), /made no audio/);
    await assert.rejects(new WindowsVoice(standin(dir, 'big.mjs', `const b = Buffer.alloc(1_000_000); b.write('RIFF'); for (let i = 0; i < 6; i++) process.stdout.write(b);`), 5000).speak('x'), /too much audio/);
    const missing = new WindowsVoice(join(dir, 'nope.exe'), 1000);
    assert.match(missing.problem() as string, /PowerShell/);
    await assert.rejects(missing.speak('x'), /could not be started/);
    for (const exe of [hang]) assert.equal(new WindowsVoice(exe).problem(), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// KokoroVoice tests run serially: each test starts a worker thread that loads the
// onnxruntime native addon. Concurrent loads of the same native addon in separate
// workers cause "Module did not self-register" on some Node versions.
describe('KokoroVoice', { concurrency: false }, () => {

test('KokoroVoice with a missing model falls back to the Windows voice and reports failure', async () => {
  const dir = mkdtempSync('/tmp/svl-kokoro-');
  try {
    const missingModel = join(dir, 'no-such-model');
    const windows = new WindowsVoice();
    let failReason: string | null = null;
    // Use a path that does not exist; the worker will fail to load the model.
    const v = new KokoroVoice(missingModel, KOKORO_VOICE, windows, () => undefined, r => { failReason = r; });
    // Before the worker fails (while loading), problem() delegates to fallback and standingIn is true.
    assert.equal(v.voiceId, KOKORO_VOICE, 'af_heart is the default voice id');
    assert.equal(v.problem(), windows.problem(), 'problem() delegates to fallback while loading');
    assert.equal(v.standingIn(), true, 'standing in while loading');
    v.stop();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


// AC-2.1: Real Kokoro synthesis. Set KOKORO_TEST_DIR to a writable directory; the model is
// downloaded there if not already present. The test verifies the voice is af_heart and the
// output is a 24kHz WAV.
const kokoroTestDir = process.env.KOKORO_TEST_DIR;
test('the real Kokoro voice (af_heart) makes a 24kHz WAV', { skip: kokoroTestDir ? false : 'set KOKORO_TEST_DIR to run this' }, async () => {
  const models = kokoroTestDir!;
  const modelPath = join(models, KOKORO_MODEL);
  if (!existsSync(modelPath)) {
    console.log('# Downloading Kokoro model for test (this may take a minute)…');
    mkdirSync(models, { recursive: true });
    const { fetchKokoroModel } = await import('../bridge/tts.js');
    await fetchKokoroModel(models);
  }
  assert.ok(existsSync(modelPath), 'model directory exists after download');
  const started = Date.now();
  await new Promise<void>((resolve, reject) => {
    const windows = new WindowsVoice();
    const v = new KokoroVoice(
      modelPath, KOKORO_VOICE, windows,
      async () => {
        try {
          // AC-2.1: voiceId=af_heart from running voice, 24kHz output, phrases came from Kokoro.
          assert.equal(v.voiceId, KOKORO_VOICE, 'voice is af_heart');
          assert.equal(v.problem(), null, 'problem() is null when Kokoro is ready (not Windows problem)');
          assert.equal(v.standingIn(), false, 'standingIn is false when Kokoro is ready');
          // speak() uses Kokoro (state=ready), not Windows.
          const wav = await v.speak('Hello from Kokoro.');
          assert.equal(wav.toString('ascii', 0, 4), 'RIFF', 'output is a WAV');
          const hz = wav.readUInt32LE(24);
          assert.equal(hz, 24000, '24kHz sample rate — came from Kokoro, not Windows (22050 Hz)');
          assert.ok(wav.length > 10_000, 'some audio was made');
          console.log(`# Kokoro af_heart: ${wav.length} bytes, ${hz} Hz, made in ${Date.now() - started} ms`);
          v.stop();
          resolve();
        } catch (e) { v.stop(); reject(e as Error); }
      },
      reason => { v.stop(); reject(new Error(`Kokoro failed: ${reason}`)); },
    );
  });
});

}); // describe KokoroVoice

const real = new WindowsVoice();
test('the real Windows voice makes a WAV of a phrase with quotes, dollar signs, new lines and accents', { skip: real.problem() ?? false }, async () => {
  const started = Date.now();
  const wav = await real.speak('It said "hello" and $(echo hi) `ls`; 100% done.\nSecond line, ünï — end.');
  console.log(`# real voice: ${wav.length} bytes, ${wav.readUInt32LE(24)} Hz, ${((wav.length - 44) / wav.readUInt32LE(28)).toFixed(1)} s of audio, made in ${Date.now() - started} ms`);
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.ok(wav.length > 50_000, 'a few seconds of speech');
  assert.equal(wav.readUInt16LE(22), 1, 'mono');
});
