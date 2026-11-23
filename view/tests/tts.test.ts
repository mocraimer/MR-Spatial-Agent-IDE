/**
 * The Windows voice's process boundary: what it is run with, how it fails, and one real synthesis
 * on this PC (skipped where Windows PowerShell is not there). The text is an agent's reply or
 * transcribed speech, so it must reach the voice as data and run nothing.
 */
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { WindowsVoice, PHRASE_MAX } from '../bridge/tts.js';

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

const real = new WindowsVoice();
test('the real Windows voice makes a WAV of a phrase with quotes, dollar signs, new lines and accents', { skip: real.problem() ?? false }, async () => {
  const started = Date.now();
  const wav = await real.speak('It said "hello" and $(echo hi) `ls`; 100% done.\nSecond line, ünï — end.');
  console.log(`# real voice: ${wav.length} bytes, ${wav.readUInt32LE(24)} Hz, ${((wav.length - 44) / wav.readUInt32LE(28)).toFixed(1)} s of audio, made in ${Date.now() - started} ms`);
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.ok(wav.length > 50_000, 'a few seconds of speech');
  assert.equal(wav.readUInt16LE(22), 1, 'mono');
});
