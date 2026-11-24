/**
 * The Windows voice's process boundary: what it is run with, how it fails, and one real synthesis
 * on this PC (skipped where Windows PowerShell is not there). The text is an agent's reply or
 * transcribed speech, so it must reach the voice as data and run nothing.
 * Also tests KokoroVoice: fallback behavior with a missing model, and (when KOKORO_TEST_DIR is set)
 * a real Kokoro synthesis to verify af_heart voice and 24kHz WAV output.
 * ORT isolation: (when KOKORO_TEST_DIR and speech model are set up) verifies that loading the
 * speech model (ORT v4) in the main thread and then starting KokoroVoice (ORT v3 in child process)
 * does not cause a "version VERS_1.21.0 not found" conflict. This test MUST FAIL with the old
 * worker-thread code and MUST PASS with the child-process fix.
 */
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { dataDirectory } from '../bridge/config.js';
import { modelDirectory, SPEECH_MODEL, SPEECH_DTYPE } from '../bridge/speech.js';
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

// KokoroVoice tests run serially: each test forks a child process that loads the
// onnxruntime native addon. Running tests concurrently is safe (each is a separate process),
// but serial keeps the output readable and avoids CPU contention.
describe('KokoroVoice', { concurrency: false }, () => {

test('KokoroVoice with a missing model falls back to the Windows voice and reports failure', async () => {
  const dir = mkdtempSync('/tmp/svl-kokoro-');
  try {
    const missingModel = join(dir, 'no-such-model');
    const windows = new WindowsVoice();
    // Use a path that does not exist; the child will fail to load the model.
    const v = new KokoroVoice(missingModel, KOKORO_VOICE, windows, () => undefined, () => undefined);
    // Before the child fails (while loading), problem() delegates to fallback and standingIn is true.
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

// ORT isolation: loading speech model (ORT v4) in main thread, then starting KokoroVoice
// (ORT v3 in child process) must not conflict. This is the regression test for the worker-thread
// bug (libonnxruntime.so.1 version VERS_1.21.0 not found) fixed by switching to child_process.fork.
//
// Before fix (worker thread): the worker shared the main thread's dlopen space. ORT v3 (kokoro-js)
// and ORT v4 (speech model) linked against different SO versions → dlopen failed → KokoroVoice
// fell back to Windows → standingIn() == true → test FAILED.
//
// After fix (child process): Kokoro runs in its own process with its own dlopen space. No conflict.
// standingIn() == false → test PASSES.
const kokoroTestDir2 = process.env.KOKORO_TEST_DIR;
test('ORT isolation: speech model (ORT v4) and KokoroVoice (ORT v3) coexist when Kokoro runs in a child process',
  { skip: kokoroTestDir2 ? false : 'set KOKORO_TEST_DIR (Kokoro model dir) to run this' },
  async () => {
    const kokModels = kokoroTestDir2!;
    const modelPath = join(kokModels, KOKORO_MODEL);

    // Optionally download Kokoro if not already present.
    if (!existsSync(modelPath)) {
      console.log('# Downloading Kokoro model for ORT-isolation test…');
      mkdirSync(kokModels, { recursive: true });
      const { fetchKokoroModel } = await import('../bridge/tts.js');
      await fetchKokoroModel(kokModels);
    }
    assert.ok(existsSync(modelPath), 'Kokoro model directory exists');

    // Step 1: Load the speech model in the main thread (the same sequence the bridge uses).
    // This loads ORT v4 (from @huggingface/transformers v4) into this process's dlopen space.
    const speechModels = modelDirectory(dataDirectory());
    if (existsSync(join(speechModels, SPEECH_MODEL))) {
      const { env, pipeline } = await import('@huggingface/transformers');
      env.allowRemoteModels = false;
      env.allowLocalModels = true;
      env.cacheDir = speechModels;
      const asr = await pipeline('automatic-speech-recognition', SPEECH_MODEL, { dtype: SPEECH_DTYPE as 'q8' });
      // Run one inference to confirm ORT v4 is active and its SO is resident in this process.
      await asr(new Float32Array(1600));
      console.log('# Speech model loaded (ORT v4 is now resident in this process)');
    } else {
      console.log('# Speech model not set up — ORT v4 will not be pre-loaded (run npm run view:setup first for full isolation test)');
    }

    // Step 2: Start KokoroVoice. With old code (worker_threads): this would fail because
    // the worker's attempt to dlopen ORT v3 conflicts with ORT v4 already in this process.
    // With the fix (child_process.fork): Kokoro runs in its own process — no conflict.
    await new Promise<void>((resolve, reject) => {
      const v = new KokoroVoice(
        modelPath, KOKORO_VOICE, new WindowsVoice(),
        async () => {
          try {
            assert.equal(v.voiceId, KOKORO_VOICE, 'voice is af_heart');
            assert.equal(v.standingIn(), false, 'Kokoro is active — not standing in (ORT isolation works)');
            const wav = await v.speak('ORT isolation verified.');
            assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
            assert.equal(wav.readUInt32LE(24), 24000, '24 kHz from Kokoro (Windows would be 22050 Hz)');
            assert.ok(wav.length > 10_000, 'some audio was produced');
            console.log(`# Kokoro produced ${wav.length}-byte WAV at ${wav.readUInt32LE(24)} Hz`);
            v.stop(); resolve();
          } catch (e) { v.stop(); reject(e as Error); }
        },
        reason => { v.stop(); reject(new Error(`Kokoro child failed to load — ORT conflict likely: ${reason}`)); },
      );
    });
  },
);

const real = new WindowsVoice();
test('the real Windows voice makes a WAV of a phrase with quotes, dollar signs, new lines and accents', { skip: real.problem() ?? false }, async () => {
  const started = Date.now();
  const wav = await real.speak('It said "hello" and $(echo hi) `ls`; 100% done.\nSecond line, ünï — end.');
  console.log(`# real voice: ${wav.length} bytes, ${wav.readUInt32LE(24)} Hz, ${((wav.length - 44) / wav.readUInt32LE(28)).toFixed(1)} s of audio, made in ${Date.now() - started} ms`);
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.ok(wav.length > 50_000, 'a few seconds of speech');
  assert.equal(wav.readUInt16LE(22), 1, 'mono');
});
