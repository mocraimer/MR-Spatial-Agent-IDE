import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { OpenAiSpeechService, SpeechError, inspectSpeechWav, type OpenAiSpeechOptions, type SpeechFetch } from '../src/speech.js';

// All transport responses below are fixtures. No network/account/model/device calls occur.
const FAKE_KEY = 'speech-test-credential-NOT-A-REAL-KEY';
const pricing = { whisperUsdPerMinute: 0.006, ttsUsdPerMillionCharacters: 15, verifiedAt: new Date().toISOString() };
function wav(seconds = 0.01, rate = 16000, channels = 1): Buffer {
  const samples = Math.floor(seconds * rate), bytes = samples * channels * 2;
  const b = Buffer.alloc(44 + bytes); b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(channels, 22); b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * channels * 2, 28); b.writeUInt16LE(channels * 2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(bytes, 40);
  for (let i = 44; i < b.length; i += 2) b.writeInt16LE((i % 8000) - 4000, i);
  return b;
}
function fixtureFetch(): { fetch: SpeechFetch; calls: { url: string; init: RequestInit; snapshot: Buffer }[] } {
  const calls: { url: string; init: RequestInit; snapshot: Buffer }[] = [];
  return { calls, fetch: async (url, init) => {
    calls.push({ url, init, snapshot: Buffer.from(init.body as Uint8Array) });
    return url.endsWith('/transcriptions') ? Response.json({ text: '  fixture useful transcript  ' }) : new Response(new Uint8Array(wav(0.1, 24000).subarray(44)), { headers: { 'Content-Type': 'audio/pcm' } });
  } };
}
function fixture(overrides: Partial<OpenAiSpeechOptions> = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'speech-test-'));
  const transport = fixtureFetch();
  const options: OpenAiSpeechOptions = { journalPath: join(directory, 'speech.sqlite'), initializeJournal: true, approvedPerCallUsd: 0.1, approvedDailyUsd: 1, pricing, fetch: transport.fetch, ...overrides };
  const services: OpenAiSpeechService[] = [];
  const open = (changes: Partial<OpenAiSpeechOptions> = {}) => { const service = new OpenAiSpeechService({ ...options, ...changes }); services.push(service); return service; };
  const service = open();
  return { directory, options, service, open, ...transport, cleanup: async () => { for (const s of services) await s.close(); rmSync(directory, { recursive: true, force: true }); } };
}
function entries(path: string) {
  const db = new DatabaseSync(path);
  try { return db.prepare('SELECT * FROM speech_calls ORDER BY rowid').all(); } finally { db.close(); }
}
function errorCode(code: string): (error: unknown) => boolean {
  return error => { assert.ok(error instanceof SpeechError); assert.equal(error.code, code); assert.equal(JSON.stringify(error).includes(FAKE_KEY), false); assert.equal(error.message.includes(FAKE_KEY), false); assert.equal(error.stack!.includes(FAKE_KEY), false); return true; };
}
async function withKey(run: () => Promise<void>) {
  const previous = process.env['OPENAI_API_KEY']; process.env['OPENAI_API_KEY'] = FAKE_KEY;
  try { await run(); } finally { if (previous === undefined) delete process.env['OPENAI_API_KEY']; else process.env['OPENAI_API_KEY'] = previous; }
}
const context = (idempotencyKey: string) => ({ idempotencyKey });

test('fixed official HTTP profile, protected environment-only key, durable transcript and memory-only WAV fixture', async () => withKey(async () => {
  const f = fixture();
  try {
    const readiness = await f.service.readiness();
    assert.equal(readiness.find(r => r.id === 'speech-provider')!.state, 'unknown');
    assert.equal(f.calls.length, 0, 'readiness never spends');
    const input = wav(0.1), original = Buffer.from(input);
    assert.equal(await f.service.transcribe(input, context('voice:durable-request')), 'fixture useful transcript');
    assert.deepEqual(input, original, 'caller retains responsibility for its own raw buffer');
    const output = await f.service.synthesize('fixture reply', context('speech:message-id'));
    assert.equal(inspectSpeechWav(output).seconds, 0.1);
    const [stt, tts] = f.calls;
    assert.equal(stt!.url, 'https://api.openai.com/v1/audio/transcriptions');
    assert.equal(tts!.url, 'https://api.openai.com/v1/audio/speech');
    assert.equal(stt!.init.redirect, 'error'); assert.equal(tts!.init.redirect, 'error');
    assert.equal(stt!.init.method, 'POST');
    assert.equal(new Headers(stt!.init.headers).get('authorization'), `Bearer ${FAKE_KEY}`);
    assert.match(stt!.snapshot.toString(), /name="model"\r\n\r\nwhisper-1/);
    assert.ok(stt!.snapshot.includes(input)); assert.equal(stt!.snapshot.includes(Buffer.from(FAKE_KEY)), false);
    assert.deepEqual(JSON.parse(tts!.snapshot.toString()), { model: 'tts-1', voice: 'alloy', input: 'fixture reply', response_format: 'pcm' });
    assert.ok(Buffer.from(stt!.init.body as Uint8Array).every(byte => byte === 0), 'owned raw multipart copy wiped');
    assert.ok(Buffer.from(tts!.init.body as Uint8Array).every(byte => byte === 0), 'owned reply request body wiped');
    const rows = entries(f.options.journalPath);
    assert.equal(rows[0]!['state'], 'complete'); assert.equal(rows[0]!['transcript'], 'fixture useful transcript'); assert.equal(rows[0]!['reserved_micro_usd'], 6000);
    assert.equal(rows[1]!['transcript'], null);
    assert.deepEqual(readdirSync(f.directory), ['speech.sqlite', 'speech.sqlite.identity']);
    const journal = readFileSync(f.options.journalPath);
    assert.equal(journal.includes(input), false); assert.equal(journal.includes(output), false);
    assert.equal(journal.includes(Buffer.from(FAKE_KEY)), false);
    assert.equal(journal.includes(Buffer.from('fixture reply')), false);
    assert.equal(JSON.stringify(readiness).includes(FAKE_KEY), false);
    assert.equal(statSync(f.options.journalPath).mode & 0o777, 0o600);
    assert.equal(statSync(f.directory).mode & 0o777, 0o700);
  } finally { await f.cleanup(); }
}));

test('same-service concurrent/replayed keys coalesce, changed bytes/text/operation/voice are rejected', async () => withKey(async () => {
  const f = fixture();
  try {
    const recording = wav();
    const transcripts = await Promise.all(Array.from({ length: 20 }, () => f.service.transcribe(recording, context('same-turn'))));
    assert.equal(new Set(transcripts).size, 1); assert.equal(f.calls.length, 1);
    const replies = await Promise.all(Array.from({ length: 20 }, () => f.service.synthesize('reply', context('same-reply'))));
    assert.equal(f.calls.length, 2); replies[0]!.fill(0); assert.ok(replies[1]!.some(byte => byte !== 0), 'returned buffers do not share writable cache');
    const changed = Buffer.from(recording); changed[44] = 77;
    await assert.rejects(f.service.transcribe(changed, context('same-turn')), errorCode('speech-key-conflict'));
    await assert.rejects(f.service.synthesize('changed reply', context('same-reply')), errorCode('speech-key-conflict'));
    await assert.rejects(f.service.synthesize('reply', context('same-turn')), errorCode('speech-key-conflict'));
    const otherVoice = f.open({ voice: 'nova' });
    await assert.rejects(otherVoice.synthesize('reply', context('same-reply')), errorCode('speech-key-conflict'));
    assert.equal(await f.service.transcribe(recording, context('same-turn')), transcripts[0]);
    assert.deepEqual(await f.service.synthesize('reply', context('same-reply')), wav(0.1, 24000));
    assert.equal(f.calls.length, 2); assert.equal(entries(f.options.journalPath).length, 2);
  } finally { await f.cleanup(); }
}));

test('actual SQLite reservation prevents concurrent independent services from paying twice or overbooking', async () => withKey(async () => {
  let acknowledge!: () => void;
  const gate = new Promise<void>(resolve => { acknowledge = resolve; });
  let calls = 0;
  const fetch: SpeechFetch = async () => { calls++; await gate; return Response.json({ text: 'fixture acknowledged' }); };
  const f = fixture({ approvedDailyUsd: 0.006, fetch });
  try {
    const other = f.open();
    const first = f.service.transcribe(wav(), context('one'));
    assert.equal(entries(f.options.journalPath)[0]!['state'], 'reserved', 'reservation precedes HTTP invocation');
    assert.equal(calls, 1);
    await assert.rejects(other.transcribe(wav(), context('one')), errorCode('speech-call-uncertain'));
    await assert.rejects(other.transcribe(wav(), context('two')), errorCode('speech-budget-exhausted'));
    acknowledge(); assert.equal(await first, 'fixture acknowledged');
    assert.equal(await other.transcribe(wav(), context('one')), 'fixture acknowledged'); assert.equal(calls, 1);
  } finally { acknowledge(); await f.cleanup(); }
}));

test('memory pressure is bounded to four in-flight requests; same-key replay still coalesces without reserving twice', async () => withKey(async () => {
  let acknowledge!: () => void;
  const gate = new Promise<void>(resolve => { acknowledge = resolve; });
  let calls = 0;
  const f = fixture({ fetch: async () => { calls++; await gate; return Response.json({ text: 'fixture bounded concurrency' }); } });
  try {
    const pending = Array.from({ length: 4 }, (_, index) => f.service.transcribe(wav(), context('pending-' + index)));
    await assert.rejects(f.service.transcribe(wav(), context('fifth')), errorCode('speech-busy'));
    const same = f.service.transcribe(wav(), context('pending-0'));
    assert.equal(calls, 4); assert.equal(entries(f.options.journalPath).length, 4);
    acknowledge(); await Promise.all([...pending, same]);
    await f.service.transcribe(wav(), context('fifth'));
    assert.equal(calls, 5);
  } finally { acknowledge(); await f.cleanup(); }
}));

test('budget absent, key absent, expired/unknown/understated pricing and missing durable key never send HTTP', async () => withKey(async () => {
  const f = fixture();
  const previous = process.env['OPENAI_API_KEY'];
  try {
    await assert.rejects(f.service.transcribe(wav()), errorCode('speech-key-required'));
    await assert.rejects(f.service.synthesize('reply', context('')), errorCode('speech-key-required'));
    for (const changes of [
      { approvedPerCallUsd: undefined }, { approvedDailyUsd: undefined }, { approvedDailyUsd: -1 }, { pricing: undefined },
      { pricing: { ...pricing, whisperUsdPerMinute: 0.001 } }, { pricing: { ...pricing, ttsUsdPerMillionCharacters: 1 } },
      { pricing: { ...pricing, verifiedAt: 'unknown' } }, { pricing: { ...pricing, verifiedAt: '2000-01-01' } },
      { pricing: { ...pricing, verifiedAt: '2999-01-01' } },
    ]) {
      // Explicit undefined emulates absent trusted host configuration at runtime.
      const service = f.open(changes as Partial<OpenAiSpeechOptions>);
      await assert.rejects(service.transcribe(wav(), context('no-budget')), errorCode('speech-budget-unapproved'));
      assert.equal((await service.readiness()).find(r => r.id === 'speech-budget')!.state, 'blocked');
    }
    delete process.env['OPENAI_API_KEY'];
    assert.equal((await f.service.readiness()).find(r => r.id === 'speech-credentials')!.state, 'missing');
    await assert.rejects(f.service.transcribe(wav(), context('no-key')), errorCode('speech-credentials-missing'));
    process.env['OPENAI_API_KEY'] = 'key\nunsafe';
    await assert.rejects(f.service.synthesize('reply', context('bad-key')), errorCode('speech-credentials-missing'));
    assert.equal(f.calls.length, 0); assert.equal(entries(f.options.journalPath).length, 0);
  } finally { process.env['OPENAI_API_KEY'] = previous; await f.cleanup(); }
}));

test('per-call and daily caps use conservative nonrefundable microUSD bounds; UTF-8 and rounding never under-reserve', async () => withKey(async () => {
  const f = fixture({ approvedDailyUsd: 0.006, approvedPerCallUsd: 0.006 });
  try {
    await assert.rejects(f.service.synthesize('a'.repeat(401), context('too-costly')), errorCode('speech-budget-exhausted'));
    assert.equal(await f.service.transcribe(wav(0.01), context('turn')), 'fixture useful transcript');
    await assert.rejects(f.service.transcribe(wav(), context('over-daily')), errorCode('speech-budget-exhausted'));
    assert.equal(f.calls.length, 1);
    assert.equal((await f.service.readiness()).find(item => item.id === 'speech-budget')!.state, 'blocked');
    assert.equal(entries(f.options.journalPath)[0]!['reserved_micro_usd'], 6000);
    const unicode = fixture({ approvedPerCallUsd: 0.001 });
    try {
      await unicode.service.synthesize('😀', context('unicode'));
      assert.equal(entries(unicode.options.journalPath)[0]!['reserved_micro_usd'], 60, 'four UTF8 bytes conservatively exceed one character');
    } finally { await unicode.cleanup(); }
    const highBound = fixture({ approvedPerCallUsd: 20000, approvedDailyUsd: 20000, pricing: { ...pricing, ttsUsdPerMillionCharacters: 999999.123456 } });
    try {
      await highBound.service.synthesize('€'.repeat(4096), context('large-price-upper-bound'));
      assert.equal(entries(highBound.options.journalPath)[0]!['reserved_micro_usd'], 12287989230, 'exact ceiling even when integer multiplication exceeds double precision');
    } finally { await highBound.cleanup(); }
    const understated = f.open({ approvedDailyUsd: 2 });
    await assert.rejects(understated.transcribe(wav(), context('changed-policy')), errorCode('speech-budget-unapproved'));
    assert.equal(f.calls.length, 1);
  } finally { await f.cleanup(); }
}));

test('timeout, lost acknowledgement and provider rejection retain the bound, redact errors and refuse replay/restart', async () => withKey(async () => {
  const scenarios: SpeechFetch[] = [
    async () => new Promise<Response>(() => {}),
    async () => { throw new Error(`fixture network error contains ${FAKE_KEY} and request body`); },
    async () => new Response(`provider rejection includes ${FAKE_KEY}`, { status: 401 }),
  ];
  for (const fetch of scenarios) {
    const requestBodies: Uint8Array[] = [];
    const f = fixture({ fetch: async (url, init) => { requestBodies.push(init.body as Uint8Array); return fetch(url, init); }, timeoutMs: 10, approvedDailyUsd: 0.006 });
    try {
      await assert.rejects(f.service.transcribe(wav(), context('lost')), error => {
        assert.ok(error instanceof SpeechError); assert.ok(['speech-call-uncertain', 'speech-provider-rejected'].includes(error.code));
        assert.equal(error.message.includes(FAKE_KEY), false); assert.equal(error.stack!.includes(FAKE_KEY), false); return true;
      });
      assert.equal(requestBodies.length, 1);
      assert.ok(requestBodies[0]!.every(byte => byte === 0), 'raw request copy wiped even after timeout/lost acknowledgement/rejection');
      const row = entries(f.options.journalPath)[0]!;
      assert.equal(row['reserved_micro_usd'], 6000); assert.equal(row['state'], 'uncertain');
      await f.service.close();
      const restarted = f.open({ fetch: f.fetch });
      await assert.rejects(restarted.transcribe(wav(), context('lost')), errorCode(String(row['error_code'])));
      await assert.rejects(restarted.transcribe(wav(), context('new')), errorCode('speech-budget-exhausted'));
      assert.equal(f.calls.length, 0);
      assert.equal(readFileSync(f.options.journalPath).includes(Buffer.from(FAKE_KEY)), false);
    } finally { await f.cleanup(); }
  }
}));

test('response timeout covers streaming body and oversized bodies cannot bypass bounds', async () => withKey(async () => {
  let cancelled = false;
  const fetch: SpeechFetch = async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{"text":')); }, cancel() { cancelled = true; } }));
  const f = fixture({ fetch, timeoutMs: 10 });
  try {
    await assert.rejects(f.service.transcribe(wav(), context('body-timeout')), errorCode('speech-call-uncertain'));
    assert.equal(cancelled, true);
    const oversized = f.open({ fetch: async () => new Response(new Uint8Array(262145)) });
    await assert.rejects(oversized.transcribe(wav(), context('huge')), errorCode('speech-response-too-large'));
    const length = f.open({ fetch: async () => new Response(new Uint8Array(4), { headers: { 'content-length': '9000000' } }) });
    await assert.rejects(length.synthesize('reply', context('content-length')), errorCode('speech-response-too-large'));
  } finally { await f.cleanup(); }
}));

test('restart/lost-memory audio and cache eviction yield text fallback, never an automatic second paid generation', async () => withKey(async () => {
  const f = fixture({ audioCacheBytes: 5000 });
  try {
    const input = wav();
    await f.service.transcribe(input, context('retained-turn'));
    await f.service.synthesize('one', context('reply-one'));
    await f.service.synthesize('two', context('reply-two'));
    await assert.rejects(f.service.synthesize('one', context('reply-one')), errorCode('speech-audio-not-retained'));
    await f.service.close();
    delete process.env['OPENAI_API_KEY'];
    const restarted = f.open({ approvedPerCallUsd: undefined, approvedDailyUsd: undefined, pricing: undefined } as unknown as Partial<OpenAiSpeechOptions>);
    assert.equal(await restarted.transcribe(input, context('retained-turn')), 'fixture useful transcript', 'durable successful replay needs no key or new budget');
    await assert.rejects(restarted.synthesize('two', context('reply-two')), errorCode('speech-audio-not-retained'));
    assert.equal(f.calls.length, 3);
    process.env['OPENAI_API_KEY'] = FAKE_KEY;
    const approved = f.open();
    await approved.synthesize('two', context('explicit-new-owner-generation'));
    assert.equal(f.calls.length, 4);
    const noCache = f.open({ audioCacheBytes: 0 });
    await noCache.synthesize('memory-only first delivery', context('no-cache'));
    await assert.rejects(noCache.synthesize('memory-only first delivery', context('no-cache')), errorCode('speech-audio-not-retained'));
    assert.equal(f.calls.length, 5);
  } finally { await f.cleanup(); }
}));

test('strict WAV, reply text and useful transcript bounds reject bad formats without silent truncation', async () => withKey(async () => {
  const f = fixture();
  try {
    const invalid = [Buffer.alloc(0), Buffer.from('not a WAV'), wav(30.01), wav(0.1, 24000), wav(0.1, 16000, 2), wav(0.1, 7999), wav(0.1, 96001), wav(0.1, 16000, 3), Buffer.concat([wav(), Buffer.from('trailer')])];
    for (const [offset, value] of [[4, 1], [20, 3], [28, 7], [32, 1], [34, 8], [40, 1000000]] as const) { const b = wav(); b.writeUInt32LE(value, offset); invalid.push(b); }
    for (const input of invalid) await assert.rejects(f.service.transcribe(input, context('invalid')), errorCode('speech-invalid-wav'));
    for (const text of ['', '  ', 'x'.repeat(4097), '\u0000bad', '\ud800']) await assert.rejects(f.service.synthesize(text, context('invalid-text')), errorCode('speech-invalid-text'));
    assert.equal(f.calls.length, 0); assert.equal(entries(f.options.journalPath).length, 0);
    assert.equal(inspectSpeechWav(wav(30), true).seconds, 30);
    assert.equal(inspectSpeechWav(wav(120, 8000, 2)).seconds, 120);
    for (const [index, text] of [' ', 'x'.repeat(65537), '\u0000'].entries()) {
      const bad = f.open({ fetch: async () => Response.json({ text }) });
      await assert.rejects(bad.transcribe(wav(), context('bad-transcript-' + index)), errorCode(text.trim() === '' ? 'speech-no-speech' : 'speech-invalid-transcript'));
    }
    const noSpeech = f.open({ fetch: async () => Response.json({ text: '' }) });
    await assert.rejects(noSpeech.transcribe(wav(), context('silence')), errorCode('speech-no-speech'));
    await assert.rejects(noSpeech.transcribe(wav(), context('silence')), errorCode('speech-no-speech'));
    const malformed = f.open({ fetch: async () => new Response('{') });
    await assert.rejects(malformed.transcribe(wav(), context('malformed-json')), errorCode('speech-invalid-transcript'));
    const badReply = f.open({ fetch: async () => new Response('compressed-not-WAV') });
    await assert.rejects(badReply.synthesize('reply', context('bad-wav')), errorCode('speech-invalid-wav'));
    const oddPcm = f.open({ fetch: async () => new Response(new Uint8Array(1), { headers: { 'Content-Type': 'audio/pcm' } }) });
    await assert.rejects(oddPcm.synthesize('reply', context('odd-pcm')), errorCode('speech-invalid-wav'));
  } finally { await f.cleanup(); }
}));

test('parallel caller processes share one SQLite daily cap, not independent in-memory budgets', async () => withKey(async () => {
  const f = fixture({ approvedDailyUsd: 0.006 });
  try {
    const moduleUrl = new URL('../src/speech.js', import.meta.url).href;
    const outputs = await Promise.all(Array.from({ length: 6 }, async (_, index) => {
      const script = `import {OpenAiSpeechService} from ${JSON.stringify(moduleUrl)};
        const s = new OpenAiSpeechService({...${JSON.stringify({ ...f.options, fetch: undefined, initializeJournal: false })},
          fetch: async () => { process.stdout.write('PAID\\\\n'); return Response.json({text:'fixture process transcript'}); }});
        try { await s.transcribe(Buffer.from(${JSON.stringify(wav().toString('base64'))},'base64'), {idempotencyKey:${JSON.stringify('process-' + index)}}); process.stdout.write('COMPLETE\\\\n'); }
        catch(e) { process.stdout.write(e.code+'\\\\n'); } finally { await s.close(); }`;
      const child = spawn(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, OPENAI_API_KEY: FAKE_KEY }, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '', errors = '';
      child.stdout!.on('data', chunk => { output += String(chunk); }); child.stderr!.on('data', chunk => { errors += String(chunk); });
      const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
      try { const [code] = await once(child, 'exit'); assert.equal(code, 0, errors); return output; } finally { clearTimeout(timer); }
    }));
    assert.equal(outputs.filter(output => output.includes('PAID')).length, 1);
    assert.equal(outputs.filter(output => output.includes('COMPLETE')).length, 1);
    assert.equal(outputs.filter(output => output.includes('speech-budget-exhausted')).length, 5);
    assert.equal(entries(f.options.journalPath).length, 1);
  } finally { await f.cleanup(); }
}));

test('post-send failures stay prior-day liabilities; completed requests also count across UTC midnight for 24h', async () => withKey(async () => {
  for (const failed of [false, true]) {
    const f = fixture({ approvedDailyUsd: 0.006, fetch: async () => Response.json({ text: failed ? '' : 'fixture text' }) });
    try {
      if (failed) await assert.rejects(f.service.transcribe(wav(), context('first')), errorCode('speech-no-speech'));
      else await f.service.transcribe(wav(), context('first'));
      const db = new DatabaseSync(f.options.journalPath);
      const recent = new Date(Date.now() - 3600000).toISOString();
      db.prepare("UPDATE speech_calls SET day='2000-01-01',created_at=?").run(recent); db.close();
      await assert.rejects(f.service.transcribe(wav(), context('next-day')), errorCode('speech-budget-exhausted'));
      const age = new DatabaseSync(f.options.journalPath);
      age.prepare("UPDATE speech_calls SET created_at='2000-01-01T00:00:00.000Z'").run(); age.close();
      if (failed) await assert.rejects(f.service.transcribe(wav(), context('older-failure')), errorCode('speech-budget-exhausted'));
      else assert.equal(await f.service.transcribe(wav(), context('older-success')), 'fixture text');
    } finally { await f.cleanup(); }
  }
}));

test('SQLite write failures before send refuse billing; failures after successful response retain unknown effects', async () => withKey(async () => {
  const before = fixture(), after = fixture();
  try {
    const b = new DatabaseSync(before.options.journalPath);
    b.exec("CREATE TRIGGER fixture_insert_failure BEFORE INSERT ON speech_calls BEGIN SELECT RAISE(ABORT,'fixture storage failure'); END;"); b.close();
    await assert.rejects(before.service.transcribe(wav(), context('no-write')), errorCode('speech-journal-unavailable'));
    assert.equal(before.calls.length, 0); assert.equal(entries(before.options.journalPath).length, 0);
    const a = new DatabaseSync(after.options.journalPath);
    a.exec("CREATE TRIGGER fixture_ack_failure BEFORE UPDATE ON speech_calls BEGIN SELECT RAISE(ABORT,'fixture storage failure'); END;"); a.close();
    await assert.rejects(after.service.transcribe(wav(), context('lost-journal-ack')), errorCode('speech-call-uncertain'));
    assert.equal(after.calls.length, 1); assert.equal(entries(after.options.journalPath)[0]!['state'], 'reserved');
    await assert.rejects(after.service.transcribe(wav(), context('lost-journal-ack')), errorCode('speech-call-uncertain'));
    assert.equal(after.calls.length, 1);
  } finally { await before.cleanup(); await after.cleanup(); }
}));

test('journal loss/replacement cannot silently reset configured budgets; initial provisioning must be explicit', async () => withKey(async () => {
  const f = fixture();
  try {
    await f.service.transcribe(wav(), context('spent'));
    await f.service.close();
    const options = { ...f.options, initializeJournal: false };
    rmSync(f.options.journalPath);
    assert.throws(() => new OpenAiSpeechService(options), errorCode('speech-journal-unavailable'));
    assert.equal(readdirSync(f.directory).includes('speech.sqlite'), false, 'missing journal was not recreated');
    writeFileSync(f.options.journalPath, '');
    assert.throws(() => new OpenAiSpeechService(options), errorCode('speech-journal-unavailable'));
    rmSync(f.options.journalPath); rmSync(f.options.journalPath + '.identity');
    assert.throws(() => new OpenAiSpeechService(options), errorCode('speech-journal-unavailable'));
    assert.equal(f.calls.length, 1);
  } finally { await f.cleanup(); }
}));

test('price-review date refresh preserves financial policy; long receiver-bound keys are accepted and raw changes rejected', async () => withKey(async () => {
  const f = fixture();
  try {
    const key = 'voice:' + JSON.stringify(['k'.repeat(256), { spaceId: 's'.repeat(256), conversationId: 'c'.repeat(256), taskId: 't'.repeat(256) }]);
    assert.equal(await f.service.transcribe(wav(), context(key)), 'fixture useful transcript');
    const refreshed = f.open({ pricing: { ...pricing, verifiedAt: new Date().toISOString() } });
    assert.equal(await refreshed.transcribe(wav(), context('new-review')), 'fixture useful transcript');
    const changed = wav(); changed[44] = 88;
    await assert.rejects(refreshed.transcribe(changed, context(key)), errorCode('speech-key-conflict'));
    await assert.rejects(refreshed.transcribe(wav(), context('x'.repeat(2049))), errorCode('speech-key-required'));
    assert.equal(f.calls.length, 2);
  } finally { await f.cleanup(); }
}));

test('durable reservation survives an actual killed caller process and remains a prior-day liability', async () => withKey(async () => {
  const f = fixture({ approvedDailyUsd: 0.006 });
  let child: ReturnType<typeof spawn> | undefined;
  try {
    await f.service.close();
    const moduleUrl = new URL('../src/speech.js', import.meta.url).href;
    const script = `import {OpenAiSpeechService} from ${JSON.stringify(moduleUrl)};
      const s = new OpenAiSpeechService({...${JSON.stringify({ ...f.options, fetch: undefined })}, fetch: async () => {
        process.stdout.write('RESERVED\\n'); return new Promise(() => {});
      }}); const wav = Buffer.from(${JSON.stringify(wav().toString('base64'))}, 'base64');
      void s.transcribe(wav, {idempotencyKey:'crash'});`;
    child = spawn(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, OPENAI_API_KEY: FAKE_KEY }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', errors = '';
    child.stderr!.on('data', chunk => { errors += String(chunk); });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('fixture child did not reserve: ' + errors)), 10000);
      child!.stdout!.on('data', chunk => { output += String(chunk); if (output.includes('RESERVED')) { clearTimeout(timer); resolve(); } });
      child!.once('exit', () => { clearTimeout(timer); reject(new Error('fixture child exited early: ' + errors)); });
    });
    const exit = once(child, 'exit'); child.kill('SIGKILL'); await exit;
    assert.equal(entries(f.options.journalPath)[0]!['state'], 'reserved');
    const db = new DatabaseSync(f.options.journalPath); db.prepare("UPDATE speech_calls SET day='2000-01-01',created_at='2000-01-01T00:00:00.000Z'").run(); db.close();
    const restarted = f.open();
    await assert.rejects(restarted.transcribe(wav(), context('crash')), errorCode('speech-call-uncertain'));
    await assert.rejects(restarted.transcribe(wav(), context('tomorrow')), errorCode('speech-budget-exhausted'));
    assert.equal(f.calls.length, 0);
  } finally { child?.kill('SIGKILL'); await f.cleanup(); }
}));

test('journal errors never send paid calls, do not expose paths/credentials, and shutdown is bounded', async () => withKey(async () => {
  const directory = mkdtempSync(join(tmpdir(), 'speech-storage-test-'));
  try {
    const target = join(directory, 'target'); writeFileSync(target, 'private unrelated file');
    const link = join(directory, 'symlink.sqlite'); symlinkSync(target, link);
    assert.throws(() => new OpenAiSpeechService({ journalPath: link }), errorCode('speech-journal-unavailable'));
    assert.equal(readFileSync(target).toString(), 'private unrelated file');
    const bad = join(directory, 'bad.sqlite'); writeFileSync(bad, 'not SQLite');
    assert.throws(() => new OpenAiSpeechService({ journalPath: bad }), errorCode('speech-journal-unavailable'));
    assert.throws(() => new OpenAiSpeechService({ journalPath: ':memory:' }), errorCode('speech-invalid-config'));
    const f = fixture({ fetch: async () => new Promise<Response>(() => {}), timeoutMs: 10 });
    try {
      const attempt = f.service.synthesize('reply', context('closing'));
      const failed = assert.rejects(attempt, errorCode('speech-call-uncertain'));
      await Promise.all([f.service.close(), f.service.close()]); await failed;
      await assert.rejects(f.service.synthesize('reply', context('after-close')), errorCode('speech-closed'));
      assert.equal((await f.service.readiness())[0]!.state, 'blocked');
    } finally { await f.cleanup(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
}));
