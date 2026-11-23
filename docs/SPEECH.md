# View local speech (ASR and TTS)

`view/bridge/speech.ts` runs all speech recognition on the PC using Moonshine tiny q8 (ONNX
Runtime, `@huggingface/transformers`). `view/bridge/tts.ts` runs synthesis using Kokoro-82M
fp32 (via `kokoro-js` worker thread, voice `af_heart`, 24 kHz WAV). Neither model contacts any
server at run time (INV-G4).

## Bench scripts

| Script | Purpose |
|---|---|
| `npm run speech:dataset` | Assembles 100 utterances from LibriSpeech test-clean into `./speech-dataset` (70 short <15 s, 30 long 15–30 s). Requires `ffmpeg` and local LibriSpeech test-clean FLAC files. |
| `npm run speech:measure` | Measures WER and warm transcription time for a candidate model. Downloads model on first run. Run with `--model <id> --dtype q8 --dataset <dir> --models-dir <dir>`. |
| `npm run bench:tts` | Measures Kokoro synthesis latency across 15 trials per phrase class. |

## Measurement results (2026-11-24, 100 utterances from LibriSpeech test-clean)

Dataset: 100 utterances (70 short <15 s, 30 long 15–30 s) from LibriSpeech test-clean speakers.
All candidates measured at q8 dtype on the owner's PC (Node.js v22, WSL2, x64 CPU, no GPU).

| Candidate | WER all | WER long | Median warm (ms) | p95 (ms) | Status |
|---|---|---|---|---|---|
| moonshine-tiny-ONNX q8 | 5.1 % | 3.4 % | 766 | 2 544 | Current production model |
| moonshine-v2-small-ONNX q8 | — | — | — | — | Gated (401); not measured |
| moonshine-v2-medium-ONNX q8 | — | — | — | — | Gated (401); not measured |
| parakeet-tdt-0.6b-v2 | — | — | — | — | Reference only; size >2.5 GB |

Moonshine tiny q8 remains the production model per ADR
[20261123-speech-model-chosen-by-measurement](adr/20261123-speech-model-chosen-by-measurement.md):
the winning candidate must have the lowest WER among measurable candidates **and** median warm
time ≤1100 ms. With v2 models gated on HuggingFace Hub (HTTP 401 without an owner HF token), the
comparison cannot be completed. Tiny q8 is confirmed as default until a comparison run succeeds.

To re-run when v2 models become accessible:

```sh
# Set HF_TOKEN to an owner token with read access to onnx-community gated models, then:
npm run speech:dataset -- --out ./speech-dataset
npm run speech:measure -- --model onnx-community/moonshine-v2-small-ONNX \
  --dtype q8 --dataset ./speech-dataset --models-dir <models-dir>
npm run speech:measure -- --model onnx-community/moonshine-v2-medium-ONNX \
  --dtype q8 --dataset ./speech-dataset --models-dir <models-dir>
```

## TTS measurement results (2026-11-24, Kokoro-82M fp32, voice af_heart, 15 trials each)

| Phrase class | Median (ms) | Min (ms) | Max (ms) | Gate |
|---|---|---|---|---|
| Command feedback ("Model set to Sonnet.") | 942 | 792 | 1136 | ≤1000 ms ✓ |
| First sentence of 600-char reply | 1299 | 1022 | 1490 | ≤1500 ms ✓ |
| Subsequent sentences (RTF, all <1.0) | 0.416–0.529 | — | — | ≤1.0 ✓ |

Peak RSS over 60-phrase stress test: 0.72 GB (gate ≤2 GB ✓).

---

# Host speech

`host/src/speech.ts` implements `HostServices.speech` with real OpenAI HTTP requests. Tests inject fixtures; they are **not** provider or Quest evidence. No account, model, inference or TTS calls were made to verify this implementation.

## Activation is BLOCKED

The owner has not supplied speech credentials or approved USD limits. Real account authorization, current availability of the deprecated TTS-1 model, voice quality, Quest playback/capture and end-to-end receiver behavior remain **BLOCKED** until the owner authorizes those checks. Presence of a key only means it is present; readiness never sends a paid probe.

There is no model-login fallback, synthetic default provider, silent model switch or inferred budget. `ANTHROPIC_API_KEY` does not configure this service. The service reads only `process.env.OPENAI_API_KEY`, at paid-call admission, from the host process. Neither an API key nor a base URL is a constructor option. Do not pass credentials, environment configuration or transports to task tools or clients.

Host deployment must prove that task processes/containers cannot read the host environment or speech files. The service does not provide an OS sandbox. Keep the host service under its protected account and speech state on a private persistent local filesystem, outside project/task mounts. POSIX mode tests do not prove Windows/WSL ACL protection; deployment must verify the actual boundary. Do not print environment files or provider/configuration bodies during setup.

## Exact interface

```ts
new OpenAiSpeechService(options: OpenAiSpeechOptions)
readiness(): Promise<ReadinessItem[]>
transcribe(wav: Buffer, context?: { idempotencyKey: string }): Promise<string>
synthesize(text: string, context?: { idempotencyKey: string }): Promise<Buffer>
close(): Promise<void>
```

The context is optional for structural compatibility, but every transcription/generation needs a stable, nonempty key of at most 2048 characters. Missing keys fail before billing. The server supplies `voice:<sha256-owner-request-key>` for transcription and `speech:<message-id>` for replies. Preserve these on retries. Before transcription, `store.captureVoiceIntent(key, receiver, sha256wav)` durably rejects a changed recipient or recording for that owner request; it stores a hash, not raw audio. Bind the recipient before transcription; never retarget a turn using its transcript. The service treats keys as opaque; recipient binding belongs to server/product storage.

| Constructor option | Contract |
|---|---|
| `journalPath` | Required absolute path to a dedicated durable SQLite file. Never use `:memory:`, the product database, a task directory or an ephemeral folder. |
| `initializeJournal` | Default `false`. `true` permits **one-time trusted initial provisioning** when both database and identity sidecar are absent. Do not leave this enabled in normal configured startup. |
| `approvedPerCallUsd` | Required positive explicit owner USD cap for each reservation; absent disables paid calls. |
| `approvedDailyUsd` | Required positive explicit owner USD cap; enforced as a rolling 24-hour bound, stricter than a UTC-day allowance. Absent disables paid calls. |
| `pricing` | Required `{ whisperUsdPerMinute, ttsUsdPerMillionCharacters, verifiedAt }`; reviewed upper bounds, not guessed estimates. Review must be no more than 30 days old, not future-dated, and no lower than the verified baseline below. No default prices enable billing. |
| `voice` | `alloy` (default), `echo`, `fable`, `onyx`, `nova` or `shimmer`. No custom voices or model instructions. |
| `timeoutMs` | Integer 1–25000, default 25000. Covers response headers **and** bounded body consumption; no automatic retry. |
| `audioCacheBytes` | Integer 0–64000000, default 16000000. Memory-only FIFO cache; zero disables retained reply audio. |
| `fetch` | Optional `(url: string, init: RequestInit) => Promise<Response>`. Trusted host/test injection only; production uses native `fetch`. Not accepted from client/tool requests. |

USD caps are rounded **down** to whole microdollars. Reviewed rates and reservations round **up**. Values must be finite and bounded (at most USD 1,000,000); values below one microdollar cannot approve a call. Copying fixture budgets or the published prices is not owner approval.

First provision the journal in trusted setup, then use the same path with `initializeJournal: false` on every normal startup. Configuration loaders must not infer permission to initialize from a missing file. A host-owned configuration uses these option names; credentials stay separately in its protected service environment. The service itself does not read `SPATIAL_SPEECH_MAX_USD` or any budget environment variable: trusted setup must explicitly supply both approved caps. Unset budget environment/configuration never authorizes spend.

`SpeechError` contains only `status`, `code`, a fixed safe message and an actionable `recovery`. The host maps it to the public error contract. Provider error bodies, request/configuration bodies, paths and credentials are neither echoed nor logged. There is no progress percentage.

## Fixed supported profile and official evidence

Public official documentation retrieved over HTTPS on **2026-10-02**:

| Source | Evidence |
|---|---|
| [Whisper model](https://developers.openai.com/api/docs/models/whisper-1) | `whisper-1`: transcription **USD 0.006 per minute**. |
| [TTS-1 model](https://developers.openai.com/api/docs/models/tts-1) | `tts-1`: speech generation **USD 15 per million characters**. The page labels TTS-1 **Deprecated**. This is not evidence that this owner's account can still use it. |
| [Create transcription](https://developers.openai.com/api/reference/resources/audio/subresources/transcriptions/methods/create) | `POST https://api.openai.com/v1/audio/transcriptions`, multipart audio file with extension/MIME metadata, `whisper-1`, JSON transcript. |
| [Create speech](https://developers.openai.com/api/reference/resources/audio/subresources/speech/methods/create) | `POST https://api.openai.com/v1/audio/speech`, `tts-1`, voice/input, `pcm` output supported; input maximum 4096 characters. |
| [Text-to-speech guide](https://developers.openai.com/api/docs/guides/text-to-speech) | PCM is signed 16-bit little-endian, 24 kHz, without a WAV header. The guide still describes TTS-1 and its supported voices. |
| [Official Python audio helper](https://github.com/openai/openai-python/blob/main/src/openai/helpers/local_audio_player.py) | Uses 24 kHz, one channel, and interprets PCM response bytes as `int16`; supports the mono wrapping profile. |

Profile `openai-whisper-1-tts-1-v1` never changes endpoints/models from content or client parameters. Redirects fail rather than forwarding authorization. TTS requests raw PCM and wraps it as canonical mono 24 kHz PCM16 WAV; this avoids accepting unknown-size streaming RIFF headers. No token-priced model replaces TTS-1 without a separate owner-reviewed implementation/profile and cost bound.

Before activation, the owner must review current official prices and set upper bounds at least as high as the baseline. The 30-day check bounds the review age; it does not prove that provider prices cannot change within that period. The service enforces **local reservation bounds**, not an account-wide OpenAI spending limit or an invoice guarantee. Other applications/account calls, taxes and changed provider prices are outside this ledger. Owner-reviewed provider account controls remain necessary.

## Audio and text bounds

- Transcription independently matches the current server contract: complete RIFF/WAVE, only one `fmt ` and one `data` chunk, PCM format 1, mono, 16 kHz, 16-bit, matching byte-rate/block alignment, nonempty samples, maximum **30 seconds / 960044 bytes**. Extra chunks, duplicate chunks, truncated chunks, invalid alignment and trailing bytes fail before billing.
- Provider transcript response is bounded to 262144 bytes; useful text must be nonempty after trimming, at most 65536 characters, without invalid control characters. Empty speech yields a retained failure with push-to-talk/text recovery, not an invented transcript.
- Speech input is valid nonempty Unicode text, at most 4096 UTF-16 code units (conservatively within the provider character limit). No input is shortened, summarized or silently split. Longer replies stay readable as text; a shorter generation needs a deliberate owner request.
- TTS PCM responses are nonempty/even-length and bounded to 5,760,000 bytes. Returned WAV is PCM16 mono 24 kHz and at most 120 seconds, within the public mono/stereo 8–96 kHz, 120-second / 8 MB contract. The exported WAV inspector also validates that wider reply contract. Known non-PCM media types fail; raw PCM has no codec header to inspect.

## Billing and durable replay

The SQLite database uses `BEGIN IMMEDIATE`, `synchronous=FULL`, a busy timeout and a durable rollback journal. Admission, policy matching, budget sum and insertion commit **before** invoking HTTP. Different service instances/processes share the same budget when they use the same path. This is a provider billing reservation, not coordinator admission or a second dispatch/permission system.

Each service instance allows at most four in-flight requests to bound transient memory. A fifth new request returns `speech-busy` before reservation; retry its same unbilled key after capacity returns. Same-key pending callers still coalesce, and durable completed replays remain available. This local speech transport bound does not grant or schedule agent tasks.

Reservations are intentionally conservative:

- Whisper reserves the reviewed per-minute upper rate for each **rounded-up whole minute** of input, so a valid turn of up to 30 seconds reserves at least USD 0.006 at the baseline. This does not assume a cheaper undocumented billing increment.
- TTS reserves its reviewed per-million-character upper rate against the UTF-8 **byte count**, which is no smaller than the character count, rounded up to a microdollar. Non-ASCII text can therefore reserve more than the eventual charge.
- Every successful request retains its full reservation as the charged upper bound for 24 hours from admission. Midnight does not free a request. Every in-flight, lost-acknowledgement or **post-send failed** request remains a liability regardless of age. No silence, bad response, timeout, HTTP rejection or storage-acknowledgement failure automatically refunds a reservation.

The journal retains hashed key, payload/profile digest, operation, state, admission timestamp/day, reserved microUSD, useful transcript and safe error code. It contains no raw audio, generated audio, full reply input or credentials.

| Situation | Result |
|---|---|
| Same key + payload concurrently in one instance | One call, callers share its promise; reply buffers are separate writable copies. |
| Same key in another instance/process while pending | No second call; actionable uncertain/pending response. Refresh/replay later, not a blind paid retry. |
| Same key + changed audio/text/model/voice | Conflict; no new paid call. |
| Completed transcript replay after restart | Durable transcript returned without another call, even if credentials/budget are now absent. |
| Completed reply replay while cached | Memory-only WAV returned without billing. |
| Reply audio evicted, cache disabled, or host restarted | `speech-audio-not-retained`; use retained text. **No automatic paid regeneration.** An explicit new owner generation needs a new key and available approved budget. |
| Crash/lost provider or storage acknowledgement | Durable reserved/uncertain entry prevents rerun. Keep the upper bound. |
| Silence/malformed provider response/rejection | Retained safe functional error, still uncertain for billing and charged at the upper bound. Replay never bills again. |
| Missing/corrupt/replaced journal | Service blocked. No fresh budget is inferred from missing storage. |

A fsynced `<journalPath>.identity` sidecar must match the identity stored inside SQLite. Preserve both. A missing database with the sidecar present, a missing sidecar with a database present, or a replacement empty database fails closed. If the entire directory is lost, normal startup still fails because initialization is disabled. Explicit initial provisioning is not permission to reset a previously used ledger.

Financial policy (caps and upper rates) is fixed in the ledger after its first reservation. A new owner price review can refresh `verifiedAt` with unchanged financial bounds. A changed cap/rate blocks until a stopped-host, owner-approved migration preserves **all** rows/identities and unresolved liabilities. No automatic migration, reconciliation/refund, compaction or journal-reset tool is provided. Until that audited migration exists, changed-policy operation remains blocked. Do not regain budget by deleting files, changing paths, editing states/dates or restoring an old snapshot.

## Retention, shutdown and recovery

Raw microphone retention is off and has no opt-in path in this service. Transcription builds a private mutable in-memory multipart copy, passes it only to the fixed provider transport, then zeroes it on success, failure and timeout. The caller owns its original recording and must release/zero it after the turn; the server does that in its `finally` path. No audio temporary files are created. Managed runtimes, networking stacks and OS memory can make internal copies: buffer wiping is not a claim of forensic memory erasure.

Useful transcripts remain durable. Generated reply audio stays in a bounded memory-only cache; eviction/shutdown zeroes the cache buffers. Returned audio belongs to the caller and should be released after playback. `close()` refuses new calls, waits for bounded in-flight attempts, wipes cached audio and closes SQLite; it does not assert that aborting HTTP cancelled billing.

Backup/restore must stop all speech writers or use a consistent SQLite backup and preserve its matching sidecar plus the newest reservations. Restore/update tooling must not activate a stale journal over newer/uncertain calls. Do not destroy speech state as task-environment cleanup. An unknown call needs provider/account evidence and an owner-approved recovery decision, not automatic rerun or release.

## Verification

From the product root:

```sh
npm run typecheck
npm run lint
npm run build
node --test build/host/tests/speech.test.js
```

Fixtures cover protected-environment-only key use, official endpoint/request shapes, canonical input/output bounds, missing config, reviewed-price/cap enforcement, UTF-8 reservation bounds, same-key/changed-payload concurrency, independent service/process budgeting, bounded in-flight memory, killed-process recovery, lost headers/body acknowledgement, failed journal writes, cross-midnight/prior-day liabilities, silence, malformed/oversized replies, journal loss/replacement, restart/eviction text fallback, nonsecret diagnostics, raw request-buffer cleanup and audio-free persisted state. SQLite write-failure triggers are fault fixtures, not proof of a physical disk-full rehearsal.

Real credentials/budgets, account/model availability, protected deployment boundary, actual device speech and the full voice workflow still require authorized evidence. Fixture success does not pass those gates.
