import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, constants, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ReadinessItem } from './protocol.js';

export type SpeechFetch = (url: string, init: RequestInit) => Promise<Response>;
export interface SpeechContext { idempotencyKey: string }
export interface SpeechPricing {
  /** Owner-reviewed upper bounds for this fixed profile, not an estimated token price. */
  whisperUsdPerMinute: number;
  ttsUsdPerMillionCharacters: number;
  verifiedAt: string;
}
export interface OpenAiSpeechOptions {
  journalPath: string;
  /** One-time trusted provisioning only; never leave enabled for normal configured startup. */
  initializeJournal?: boolean;
  approvedPerCallUsd?: number;
  approvedDailyUsd?: number;
  pricing?: SpeechPricing;
  voice?: 'alloy' | 'echo' | 'fable' | 'onyx' | 'nova' | 'shimmer';
  timeoutMs?: number;
  audioCacheBytes?: number;
  /** Host/test injection only. Never take a transport or endpoint from client/tool input. */
  fetch?: SpeechFetch;
}
export class SpeechError extends Error {
  constructor(public readonly status: number, public readonly code: string, detail: string, public readonly recovery: string) {
    super(detail); this.name = 'SpeechError';
  }
}
function fail(status: number, code: string, detail: string, recovery = 'Use the retained text reply or push-to-talk/text input. Check speech setup before trying a new owner-approved generation.'): never {
  throw new SpeechError(status, code, detail, recovery);
}
const PROFILE = 'openai-whisper-1-tts-1-v1';
const UNITS = 1000000;
const MAX_INPUT_BYTES = 960044;
const MAX_OUTPUT_BYTES = 8000000;
const MAX_REPLY_PCM_BYTES = 120 * 24000 * 2;
const MAX_TRANSCRIPT = 65536;
type Kind = 'transcribe' | 'synthesize';
type Result = string | Buffer;
interface Entry { digest: string; kind: Kind; state: string; transcript: string | null; error_code: string | null }
interface Policy { perCall: number; daily: number; minute: number; millionCharacters: number; verifiedAt: string }
function financialPolicy(policy: Policy): string {
  return JSON.stringify({ perCall: policy.perCall, daily: policy.daily, minute: policy.minute, millionCharacters: policy.millionCharacters });
}

/** Bounds the whole RIFF container, including chunk alignment; no parser reads outside it. */
export function inspectSpeechWav(wav: Buffer, input = false): { seconds: number } {
  const invalid = (): never => fail(input ? 400 : 502, 'speech-invalid-wav', input ? 'Voice requires canonical mono 16 kHz PCM16 WAV, at most 30 seconds and 960044 bytes.' : 'Provider audio is not complete PCM16 WAV within the 120-second / 8 MB reply limit.');
  if (!Buffer.isBuffer(wav) || wav.length < 46 || wav.length > (input ? MAX_INPUT_BYTES : MAX_OUTPUT_BYTES) || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.readUInt32LE(4) !== wav.length - 8 || wav.toString('ascii', 8, 12) !== 'WAVE') invalid();
  let rate = 0, channels = 0, dataSize = 0, haveData = false;
  for (let offset = 12; offset < wav.length;) {
    if (offset + 8 > wav.length) invalid();
    const name = wav.toString('ascii', offset, offset + 4), size = wav.readUInt32LE(offset + 4), start = offset + 8;
    const end = start + size + size % 2;
    if (end > wav.length) invalid();
    if (name === 'fmt ') {
      if (rate || (input ? size !== 16 : size < 16) || wav.readUInt16LE(start) !== 1 || wav.readUInt16LE(start + 14) !== 16) invalid();
      rate = wav.readUInt32LE(start + 4); channels = wav.readUInt16LE(start + 2);
      if (channels < 1 || channels > 2 || rate < 8000 || rate > 96000 || wav.readUInt16LE(start + 12) !== channels * 2 || wav.readUInt32LE(start + 8) !== rate * channels * 2 || (input && (channels !== 1 || rate !== 16000))) invalid();
    } else if (name === 'data') {
      if (haveData || !size) invalid();
      haveData = true; dataSize = size;
    } else if (input) invalid();
    offset = end;
  }
  if (!rate || !haveData || dataSize % (channels * 2)) invalid();
  const seconds = dataSize / (rate * channels * 2);
  if (seconds > (input ? 30 : 120)) invalid();
  return { seconds };
}
function boundedInteger(value: number, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(503, 'speech-invalid-config', 'Speech timeout/cache limits are invalid.', 'Correct trusted host speech configuration.');
  return value;
}
function usd(value: number | undefined, round: 'floor' | 'ceil'): number | null {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return null;
  const amount = Math[round](value * UNITS);
  return Number.isSafeInteger(amount) && amount > 0 && amount <= 1000000000000 ? amount : null;
}
function hasControl(text: string, multiline = false): boolean {
  return [...text].some(character => {
    const code = character.charCodeAt(0);
    return (code < 32 && !(multiline && [9, 10, 13].includes(code))) || code === 127;
  });
}
function currentKey(): string | null {
  const key = process.env['OPENAI_API_KEY'];
  return key && key.trim() === key && key.length <= 4096 && !/\s/u.test(key) && !hasControl(key) ? key : null;
}

/** Speech billing reservation only; not coordinator dispatch, model authority or tool permissions. */
export class OpenAiSpeechService {
  private readonly db: DatabaseSync;
  private readonly transport: SpeechFetch;
  private readonly voice: NonNullable<OpenAiSpeechOptions['voice']>;
  private readonly timeoutMs: number;
  private readonly maxCacheBytes: number;
  private readonly policy: Policy | null;
  private readonly pending = new Map<string, { digest: string; promise: Promise<Result> }>();
  private readonly audio = new Map<string, Buffer>();
  private cacheBytes = 0;
  private closing: Promise<void> | null = null;

  constructor(options: OpenAiSpeechOptions) {
    if (!isAbsolute(options.journalPath) || options.journalPath === ':memory:') fail(503, 'speech-invalid-config', 'Speech requires an absolute durable journal path.', 'Use a private, persistent host speech directory.');
    this.voice = options.voice ?? 'alloy';
    if (!['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'].includes(this.voice)) fail(503, 'speech-invalid-config', 'Unsupported speech voice.');
    this.timeoutMs = boundedInteger(options.timeoutMs ?? 25000, 1, 25000);
    this.maxCacheBytes = boundedInteger(options.audioCacheBytes ?? 16000000, 0, 64000000);
    this.transport = options.fetch ?? ((url, init) => fetch(url, init));
    const perCall = usd(options.approvedPerCallUsd, 'floor'), daily = usd(options.approvedDailyUsd, 'floor');
    const minute = usd(options.pricing?.whisperUsdPerMinute, 'ceil');
    const millionCharacters = usd(options.pricing?.ttsUsdPerMillionCharacters, 'ceil');
    const verifiedAt = options.pricing?.verifiedAt ?? '';
    const verified = Date.parse(verifiedAt);
    this.policy = perCall && daily && minute && millionCharacters && minute >= 6000 && millionCharacters >= 15000000 && Number.isFinite(verified) && verified <= Date.now() && Date.now() - verified <= 30 * 86400000 ? { perCall, daily, minute, millionCharacters, verifiedAt } : null;
    let db: DatabaseSync | undefined;
    try {
      mkdirSync(dirname(options.journalPath), { recursive: true, mode: 0o700 });
      if (lstatSync(dirname(options.journalPath)).isSymbolicLink()) throw new Error('private directory');
      // A separately durable identity detects accidental journal loss/replacement. Never reset billing.
      const identityPath = `${options.journalPath}.identity`;
      const initial = !existsSync(identityPath) && !existsSync(options.journalPath);
      let identity: string;
      if (initial) {
        if (options.initializeJournal !== true) throw new Error('journal not provisioned');
        identity = randomUUID();
        const marker = openSync(identityPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
        try { writeSync(marker, identity); fsyncSync(marker); } finally { closeSync(marker); }
        const directory = openSync(dirname(options.journalPath), constants.O_RDONLY);
        try { fsyncSync(directory); } finally { closeSync(directory); }
      } else {
        if (!existsSync(options.journalPath) || !lstatSync(identityPath).isFile() || lstatSync(identityPath).isSymbolicLink()) throw new Error('lost journal');
        identity = readFileSync(identityPath, 'utf8');
        if (!/^[a-f0-9-]{36}$/u.test(identity)) throw new Error('journal identity');
      }
      // Do not open a symbolic-link database, and set private permissions before SQLite writes.
      const fd = openSync(options.journalPath, constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600); closeSync(fd);
      if (!lstatSync(options.journalPath).isFile() || lstatSync(options.journalPath).isSymbolicLink()) throw new Error('private journal');
      chmodSync(options.journalPath, 0o600);
      db = new DatabaseSync(options.journalPath);
      db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL;');
      const version = db.prepare('PRAGMA user_version').get()?.['user_version'];
      if (version !== 0 && version !== 1) throw new Error('journal version');
      if (!initial && db.prepare('SELECT identity FROM speech_identity WHERE id=1').get()?.['identity'] !== identity) throw new Error('replaced journal');
      db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE IF NOT EXISTS speech_identity (id INTEGER PRIMARY KEY CHECK(id=1), identity TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS speech_policy (id INTEGER PRIMARY KEY CHECK(id=1), policy TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS speech_calls (
          key TEXT PRIMARY KEY, digest TEXT NOT NULL, kind TEXT NOT NULL,
          state TEXT NOT NULL CHECK(state IN ('reserved','uncertain','complete')),
          day TEXT NOT NULL, created_at TEXT NOT NULL, reserved_micro_usd INTEGER NOT NULL CHECK(reserved_micro_usd > 0),
          transcript TEXT, error_code TEXT);
        PRAGMA user_version = 1;`);
      db.prepare('INSERT OR IGNORE INTO speech_identity VALUES(1,?)').run(identity);
      db.exec('COMMIT');
      this.db = db;
    } catch {
      try { db?.close(); } catch { /* No provider is called if journal setup fails. */ }
      fail(503, 'speech-journal-unavailable', 'Speech journal could not be opened safely.', 'Check private persistent host storage and journal version. Do not replace or delete an existing billing journal.');
    }
  }

  private policyIssue(): string | null {
    if (!this.policy) return 'Set explicit owner-approved per-call and daily USD caps and current (within 30 days) reviewed price upper bounds. No paid calls are enabled.';
    if (Date.now() - Date.parse(this.policy.verifiedAt) > 30 * 86400000) return 'Speech price review expired. Recheck official prices with the owner; no paid calls are enabled.';
    const stored = this.db.prepare('SELECT policy FROM speech_policy WHERE id=1').get()?.['policy'];
    if (stored !== undefined && stored !== financialPolicy(this.policy)) return 'Billing policy differs from the existing journal. Stop the host and reconcile its retained liabilities before an owner-approved policy migration.';
    return null;
  }
  private reservedTotal(): number {
    // Rolling 24h is stricter than a UTC-day cap; midnight cannot free an in-flight bill.
    // Every unresolved/post-send failure from earlier days stays a liability too.
    const cutoff = new Date(Date.now() - 86400000).toISOString();
    const total = Number(this.db.prepare("SELECT COALESCE(SUM(reserved_micro_usd),0) AS total FROM speech_calls WHERE created_at>=? OR state IN ('reserved','uncertain')").get(cutoff)?.['total']);
    if (!Number.isSafeInteger(total) || total < 0) fail(503, 'speech-journal-unavailable', 'Speech billing totals are not valid bounded amounts.');
    return total;
  }
  async readiness(): Promise<ReadinessItem[]> {
    if (this.closing) return [{ id: 'speech', state: 'blocked', detail: 'Speech service is closing or closed. Restart the configured host; keep its billing journal.' }];
    try {
      let issue = this.policyIssue();
      if (!issue && this.reservedTotal() >= this.policy!.daily) issue = 'Speech daily reservation bound is exhausted. Use text and review retained usage/uncertain reservations with the owner; do not reset the journal.';
      return [
        { id: 'speech-credentials', state: currentKey() ? 'ready' : 'missing', detail: currentKey() ? 'Host speech credential is present; account authorization has NOT been tested.' : 'Set OPENAI_API_KEY in the protected host service environment. Do not send it to clients or task tools.' },
        { id: 'speech-budget', state: issue ? 'blocked' : 'ready', detail: issue ?? 'Owner per-call/daily caps and price bounds configured; every paid request requires a durable reservation.' },
        { id: 'speech-provider', state: 'unknown', detail: 'Fixed OpenAI whisper-1 / tts-1 profile. TTS-1 is documented as deprecated; authorized real-provider/device validation remains required. No readiness probe spends money.' },
      ];
    } catch { return [{ id: 'speech', state: 'blocked', detail: 'Speech billing journal cannot be checked. Repair host storage; do not discard retained reservations.' }]; }
  }

  async transcribe(wav: Buffer, context?: SpeechContext): Promise<string> {
    const { seconds } = inspectSpeechWav(wav, true);
    const digest = this.digest('transcribe', wav);
    return await this.run('transcribe', context, digest, this.policy ? Math.ceil(seconds / 60) * this.policy.minute : 0, async key => {
      const boundary = `spatial-${randomUUID()}`;
      const prefix = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n--${boundary}\r\nContent-Disposition: form-data; name="response_format"\r\n\r\njson\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="voice.wav"\r\nContent-Type: audio/wav\r\n\r\n`);
      const body = Buffer.concat([prefix, wav, Buffer.from(`\r\n--${boundary}--\r\n`)]);
      try {
        const bytes = await this.request('https://api.openai.com/v1/audio/transcriptions', key, body, `multipart/form-data; boundary=${boundary}`, 262144);
        let value: unknown;
        try { value = JSON.parse(bytes.toString('utf8')); } catch { fail(502, 'speech-invalid-transcript', 'Provider returned malformed transcription data.'); }
        finally { bytes.fill(0); }
        const text = value && typeof value === 'object' && 'text' in value ? value.text : undefined;
        if (typeof text !== 'string' || text.length > MAX_TRANSCRIPT || hasControl(text, true)) fail(502, 'speech-invalid-transcript', 'Provider transcript is not bounded usable text.');
        if (!text.trim()) fail(422, 'speech-no-speech', 'No usable speech was detected.', 'Try push-to-talk or type the turn. This recording will not be billed again on replay.');
        return text.trim();
      } finally { body.fill(0); }
    }) as string;
  }

  async synthesize(text: string, context?: SpeechContext): Promise<Buffer> {
    if (typeof text !== 'string' || !text.trim() || text.length > 4096 || hasControl(text, true) || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(text)) fail(400, 'speech-invalid-text', 'Speech input must be nonempty valid text of at most 4096 characters. Nothing was truncated.', 'Read the full retained reply. Only request a separately approved shorter generation if needed.');
    const cost = this.policy ? Number((BigInt(Buffer.byteLength(text, 'utf8')) * BigInt(this.policy.millionCharacters) + BigInt(UNITS - 1)) / BigInt(UNITS)) : 0;
    const result = await this.run('synthesize', context, this.digest('synthesize', Buffer.from(text)), cost, async key => {
      const body = Buffer.from(JSON.stringify({ model: 'tts-1', voice: this.voice, input: text, response_format: 'pcm' }));
      try {
        const pcm = await this.request('https://api.openai.com/v1/audio/speech', key, body, 'application/json', MAX_REPLY_PCM_BYTES, true);
        try {
          if (!pcm.length || pcm.length % 2) fail(502, 'speech-invalid-wav', 'Provider did not return complete bounded PCM16 samples.');
          // Official PCM format: mono 24kHz signed 16-bit little-endian, without a header.
          // Wrap it ourselves rather than accept streaming WAV headers with unknown RIFF sizes.
          const wav = Buffer.alloc(44 + pcm.length);
          wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
          wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
          wav.writeUInt32LE(24000, 24); wav.writeUInt32LE(48000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
          wav.write('data', 36); wav.writeUInt32LE(pcm.length, 40); pcm.copy(wav, 44);
          inspectSpeechWav(wav); return wav;
        } finally { pcm.fill(0); }
      } finally { body.fill(0); }
    });
    return Buffer.from(result as Buffer);
  }
  private digest(kind: Kind, payload: Buffer): string {
    return createHash('sha256').update(`${PROFILE}:${kind}:${kind === 'synthesize' ? this.voice : ''}\0`).update(payload).digest('hex');
  }
  private existing(key: string, digest: string): Result | null {
    const row = this.db.prepare('SELECT digest,kind,state,transcript,error_code FROM speech_calls WHERE key=?').get(key) as unknown as Entry | undefined;
    if (!row) return null;
    if (row.digest !== digest) fail(409, 'speech-key-conflict', 'This speech key already identifies a different payload or profile.', 'Use the original payload/key. A changed generation requires a deliberate new owner request.');
    if (row.state === 'complete' && row.kind === 'transcribe' && row.transcript !== null) return row.transcript;
    if (row.state === 'complete' && row.kind === 'synthesize') {
      const cached = this.audio.get(key);
      if (cached) return Buffer.from(cached);
      fail(409, 'speech-audio-not-retained', 'This reply was already generated, but its memory-only audio is no longer available.', 'Read the retained text. An owner may explicitly request a new generation with a new key; replay does not spend again.');
    }
    if (row.error_code && row.error_code !== 'speech-call-uncertain') fail(row.error_code === 'speech-no-speech' ? 422 : 502, row.error_code, 'The prior speech attempt failed after sending; its billing upper bound remains retained.');
    fail(409, 'speech-call-uncertain', 'A speech request is in flight or lost its acknowledgement. Its billing bound is retained.', 'Do not blindly replay. Check retained text/provider usage with the owner. A deliberate new request needs a new key and available budget.');
  }
  private run(kind: Kind, context: SpeechContext | undefined, digest: string, cost: number, perform: (key: string) => Promise<Result>): Promise<Result> {
    if (this.closing) fail(503, 'speech-closed', 'Speech service is closing or closed.');
    if (!context || typeof context.idempotencyKey !== 'string' || !context.idempotencyKey.trim() || context.idempotencyKey.length > 2048 || hasControl(context.idempotencyKey)) fail(400, 'speech-key-required', 'A durable speech idempotency key is required.', 'The host must pass the durable voice request key or speech message ID, not a fresh random retry key.');
    // Only a hash is persisted: the key can contain receiver/request identities, not credentials.
    const key = createHash('sha256').update(context.idempotencyKey).digest('hex');
    const pending = this.pending.get(key);
    if (pending) {
      if (pending.digest !== digest) fail(409, 'speech-key-conflict', 'This speech key already identifies a different payload or profile.');
      return pending.promise;
    }
    let credential: string;
    try {
      this.db.exec('BEGIN IMMEDIATE');
      const existing = this.existing(key, digest);
      if (existing !== null) { this.db.exec('COMMIT'); return Promise.resolve(existing); }
      if (this.pending.size >= 4) fail(429, 'speech-busy', 'Four speech requests are already awaiting acknowledgement.', 'Wait for their retained state, then retry this same unbilled key. Do not change keys to bypass a pending request.');
      const issue = this.policyIssue();
      if (issue) fail(503, 'speech-budget-unapproved', issue, 'Ask the owner to configure reviewed speech price bounds and explicit per-call/daily USD limits in protected host setup.');
      const present = currentKey();
      if (!present) fail(503, 'speech-credentials-missing', 'Protected host speech credentials are missing.', 'The owner must set OPENAI_API_KEY in the host service environment; do not use model-login or task-tool credentials.');
      credential = present;
      const policy = this.policy!;
      const createdAt = new Date().toISOString(), day = createdAt.slice(0, 10);
      const total = this.reservedTotal();
      if (!Number.isSafeInteger(cost) || cost < 1 || cost > policy.perCall || cost > policy.daily - total) fail(429, 'speech-budget-exhausted', 'The conservative speech reservation exceeds the owner per-call or available daily USD cap.', 'Use text. Review retained speech usage and uncertain reservations with the owner; do not reset the journal to regain budget.');
      this.db.prepare('INSERT OR IGNORE INTO speech_policy VALUES(1,?)').run(financialPolicy(policy));
      this.db.prepare("INSERT INTO speech_calls(key,digest,kind,state,day,created_at,reserved_micro_usd) VALUES(?,?,?,'reserved',?,?,?)").run(key, digest, kind, day, createdAt, cost);
      this.db.exec('COMMIT');
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* Commit might already have failed; never send a paid call. */ }
      if (error instanceof SpeechError) throw error;
      fail(503, 'speech-journal-unavailable', 'Speech reservation could not be durably acknowledged.', 'Repair host storage. Preserve the billing journal and uncertain entries; no new provider call was attempted.');
    }
    const promise = (async (): Promise<Result> => {
      let result: Result | undefined;
      try {
        result = await perform(credential);
        this.db.prepare("UPDATE speech_calls SET state='complete', transcript=? WHERE key=? AND state='reserved'").run(kind === 'transcribe' ? result as string : null, key);
        if (Buffer.isBuffer(result)) this.cache(key, result);
        return result;
      } catch (error) {
        if (Buffer.isBuffer(result)) result.fill(0);
        const safe = error instanceof SpeechError ? error : new SpeechError(503, 'speech-call-uncertain', 'Speech acknowledgement was lost; its billing bound remains retained.', 'Use retained text. Check provider usage with the owner; do not blindly replay this paid request.');
        try { this.db.prepare("UPDATE speech_calls SET state=?,error_code=? WHERE key=? AND state='reserved'").run('uncertain', safe.code, key); } catch { /* Durable reserved entry already prevents replay, even on disk failure. */ }
        throw safe;
      } finally { this.pending.delete(key); }
    })();
    this.pending.set(key, { digest, promise });
    return promise;
  }

  private async request(url: string, key: string, body: Buffer, mime: string, max: number, pcm = false): Promise<Buffer> {
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let expired = false;
    const chunks: Buffer[] = [];
    const work = async (): Promise<Buffer> => {
      const response = await this.transport(url, { method: 'POST', redirect: 'error', headers: { Authorization: `Bearer ${key}`, 'Content-Type': mime }, body: new Uint8Array(body.buffer as ArrayBuffer, body.byteOffset, body.byteLength), signal: controller.signal });
      if (expired) { await response.body?.cancel(); throw new Error('expired'); }
      if (!response.ok) { await response.body?.cancel(); fail(502, 'speech-provider-rejected', 'Speech provider rejected the request; its billing reservation is retained.', 'Check host provider authorization/availability with the owner. Use text; this key will not be automatically retried.'); }
      const responseMime = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
      if (pcm && responseMime && !['audio/pcm', 'application/octet-stream'].includes(responseMime)) { await response.body?.cancel(); fail(502, 'speech-invalid-wav', 'Provider returned a non-PCM speech media type.'); }
      if (!response.body || (response.headers.get('content-length') !== null && (!/^\d+$/u.test(response.headers.get('content-length')!) || Number(response.headers.get('content-length')) > max))) { await response.body?.cancel(); fail(502, 'speech-response-too-large', 'Speech provider response exceeds the bounded reply limit.'); }
      reader = response.body.getReader();
      let size = 0;
      for (;;) {
        const part = await reader.read();
        if (expired) throw new Error('expired');
        if (part.done) break;
        size += part.value.byteLength;
        if (size > max) fail(502, 'speech-response-too-large', 'Speech provider response exceeds the bounded reply limit.');
        chunks.push(Buffer.from(part.value));
      }
      return Buffer.concat(chunks);
    };
    try {
      return await Promise.race([work(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => { expired = true; controller.abort(); reject(new Error('timeout')); }, this.timeoutMs);
      })]);
    } finally {
      clearTimeout(timer); controller.abort();
      if (reader) { void reader.cancel().catch(() => {}); }
      for (const chunk of chunks) chunk.fill(0);
    }
  }
  private cache(key: string, wav: Buffer): void {
    if (wav.length > this.maxCacheBytes) return;
    for (const [oldKey, old] of this.audio) {
      if (this.cacheBytes + wav.length <= this.maxCacheBytes) break;
      old.fill(0); this.cacheBytes -= old.length; this.audio.delete(oldKey);
    }
    const copy = Buffer.from(wav); this.audio.set(key, copy); this.cacheBytes += copy.length;
  }
  close(): Promise<void> {
    this.closing ??= (async () => {
      await Promise.allSettled([...this.pending.values()].map(item => item.promise));
      for (const wav of this.audio.values()) wav.fill(0);
      this.audio.clear(); this.cacheBytes = 0;
      this.db.close();
    })();
    return this.closing;
  }
}
