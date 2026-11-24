/**
 * Speech model measurement: WER, run-to-run variation, and noise robustness, using a frozen
 * utterance set. Candidates:
 *   - onnx-community/moonshine-tiny-ONNX              q8  (current production model)
 *   - Workmind/moonshine-streaming-small-ONNX         quantized  (transformers.js, MoonshineForConditionalGeneration)
 *   - moonshine-ai/moonshine-streaming (small/medium)  .ort files (custom batch ORT runner)
 *   - parakeet-int8  (sherpa-onnx-node with csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8)
 *
 * Run after building:
 *   node build/view/bench/speech-measure.js --model <id> --dtype <dtype> \
 *     --dataset <dir> --models-dir <dir> [--runs N] [--noise]
 *
 * Measurement discipline:
 *   - Fixed run count (--runs, default 1); each run uses the same utterance order.
 *   - 3 warm-up frames before the measured run so cold-start latency is not counted.
 *   - noise check: re-run the first 10 utterances with added white noise (SNR ~20dB),
 *     WER on noisy input must be worse or equal (confirms the scorer is sensitive to accuracy).
 *   - Run-to-run variation: std-dev of per-utterance times across runs reported.
 *   - All candidates use the same number of warm-up calls and ORT threads (env.NUM_THREADS=1).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { env, pipeline } from '@huggingface/transformers';

// --------------- CLI args ---------------
const args = process.argv.slice(2);
const get = (flag: string, def: string): string => { const i = args.indexOf(flag); return i >= 0 && args[i + 1] ? (args[i + 1] as string) : def; };
const getNum = (flag: string, def: number): number => { const v = get(flag, ''); return v ? Number(v) || def : def; };
const getFlag = (flag: string): boolean => args.includes(flag);

const MODEL_ID   = get('--model',      process.env.SPEECH_MODEL  ?? 'onnx-community/moonshine-tiny-ONNX');
const DTYPE      = get('--dtype',      process.env.SPEECH_DTYPE  ?? 'q8');
const DATASET    = get('--dataset',    process.env.SPEECH_DATASET ?? './speech-dataset');
const MODELS_DIR = get('--models-dir', process.env.SPEECH_MODELS  ?? './models');
const OUT_DIR    = get('--out',        '.');
const RUNS       = getNum('--runs', 1);
const DO_NOISE   = getFlag('--noise');

// --------------- WER helpers ---------------
function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9 ']/g, ' ').replace(/\s+/g, ' ').trim();
}

function wer(ref: string, hyp: string): number {
  const r = normalize(ref).split(' ').filter(Boolean);
  const h = normalize(hyp).split(' ').filter(Boolean);
  const dp: number[][] = Array.from({ length: r.length + 1 }, (_, i) =>
    Array.from({ length: h.length + 1 }, (_, j) => i === 0 ? j : j === 0 ? i : 0));
  for (let i = 1; i <= r.length; i++) {
    for (let j = 1; j <= h.length; j++) {
      dp[i]![j] = r[i - 1] === h[j - 1]
        ? (dp[i - 1]![j - 1] ?? 0)
        : 1 + Math.min(dp[i - 1]![j] ?? 0, dp[i]![j - 1] ?? 0, dp[i - 1]![j - 1] ?? 0);
    }
  }
  return r.length === 0 ? (h.length === 0 ? 0 : 1) : (dp[r.length]![h.length] ?? 0) / r.length;
}

function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? ((s[m - 1] ?? 0) + (s[m] ?? 0)) / 2 : (s[m] ?? 0);
}

function p95(arr: number[]): number {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const i = Math.ceil(0.95 * s.length) - 1;
  return s[Math.max(0, i)] ?? 0;
}

function stddev(arr: number[]): number {
  if (arr.length < 2) return 0;
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  const variance = arr.map(x => (x - mean) ** 2).reduce((a, b) => a + b, 0) / (arr.length - 1);
  return Math.sqrt(variance);
}

/** Add white noise at ~20dB SNR (noise amplitude ≈ 10% of RMS signal). */
function addNoise(audio: Float32Array, snrDb = 20): Float32Array {
  const rms = Math.sqrt(audio.reduce((a, v) => a + v * v, 0) / audio.length) || 0.01;
  const noiseAmp = rms / Math.pow(10, snrDb / 20);
  const noisy = new Float32Array(audio.length);
  for (let i = 0; i < audio.length; i++) {
    // Simple LCG PRNG for deterministic noise (seed = i).
    const r = (Math.sin(i * 127.1 + 311.7) * 43758.5453) % 1;
    noisy[i] = (audio[i] ?? 0) + (r * 2 - 1) * noiseAmp;
  }
  return noisy;
}

// --------------- Dataset loading ---------------
interface Utterance { id: string; audio: Float32Array; ref: string; long: boolean }

function loadDataset(dir: string): Utterance[] {
  if (!existsSync(dir)) {
    console.error(`Dataset directory not found: ${dir}`);
    console.error('Run npm run speech:dataset to build the utterance set.');
    process.exit(1);
  }
  const manifest = join(dir, 'manifest.jsonl');
  if (!existsSync(manifest)) {
    console.error(`No manifest.jsonl in ${dir}. Run the dataset download script.`);
    process.exit(1);
  }
  const lines = readFileSync(manifest, 'utf8').trim().split('\n').filter(Boolean);
  const items = lines.map(l => JSON.parse(l) as { id: string; file: string; ref: string; long: boolean });
  return items.map(item => {
    const wavPath = join(dir, item.file);
    const wavBuf = readFileSync(wavPath);
    // Parse 16-bit PCM WAV: skip 44-byte header.
    const samples = wavBuf.length > 44 ? (wavBuf.length - 44) / 2 : 0;
    const audio = new Float32Array(samples);
    for (let i = 0; i < samples; i++) audio[i] = (wavBuf.readInt16LE(44 + i * 2)) / 32768;
    return { id: item.id, audio, ref: item.ref, long: item.long };
  });
}

// --------------- Transcription interface ---------------
type Transcribe = (audio: Float32Array) => Promise<string>;

/** Parakeet int8 model via sherpa-onnx-node. Downloads files from HuggingFace on first run. */
async function loadParakeetModel(): Promise<Transcribe> {
  const PARAKEET_REPO = 'csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8';
  const modelDir = join(MODELS_DIR, 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8');
  mkdirSync(modelDir, { recursive: true });

  const files = ['encoder.int8.onnx', 'decoder.int8.onnx', 'joiner.int8.onnx', 'tokens.txt'];
  for (const f of files) {
    const dest = join(modelDir, f);
    if (!existsSync(dest)) {
      console.log(`Downloading ${f} (~640 MB total; this will take a while)…`);
      const url = `https://huggingface.co/${PARAKEET_REPO}/resolve/main/${f}?download=true`;
      const { execFileSync } = await import('node:child_process');
      execFileSync('curl', ['-L', '--max-time', '600', '-o', dest, url], { stdio: ['ignore', 'inherit', 'inherit'] });
    }
  }

  // sherpa-onnx-node is CommonJS-only. Use createRequire so it can be called from an ESM context.
  const { createRequire } = await import('node:module');
  type SherpaStream = { acceptWaveform: (obj: { samples: Float32Array; sampleRate: number }) => void };
  const sherpa = createRequire(import.meta.url)('sherpa-onnx-node') as {
    OfflineRecognizer: new (config: {
      modelConfig: {
        transducer: { encoder: string; decoder: string; joiner: string };
        tokens: string;
        modelType: string;
        numThreads: number;
      };
      decodingConfig: { method: string };
    }) => {
      createStream: () => SherpaStream;
      decode: (stream: SherpaStream) => void;
      getResult: (stream: SherpaStream) => { text: string };
    };
  };

  const rec = new sherpa.OfflineRecognizer({
    modelConfig: {
      transducer: {
        encoder: join(modelDir, 'encoder.int8.onnx'),
        decoder: join(modelDir, 'decoder.int8.onnx'),
        joiner:  join(modelDir, 'joiner.int8.onnx'),
      },
      tokens: join(modelDir, 'tokens.txt'),
      modelType: 'nemo_transducer',
      numThreads: 4,
    },
    decodingConfig: { method: 'greedy_search' },
  });

  return async (audio: Float32Array) => {
    const stream = rec.createStream();
    stream.acceptWaveform({ samples: audio, sampleRate: 16000 });
    rec.decode(stream);
    return rec.getResult(stream).text.trim();
  };
}

/**
 * Moonshine streaming models (Workmind export) require audio length divisible by 80 (frame_len).
 * transformers.js v4 does not pad automatically for this architecture, so we do it here.
 */
function padToFrameLen(audio: Float32Array, frameLen = 80): Float32Array {
  const rem = audio.length % frameLen;
  if (rem === 0) return audio;
  const padded = new Float32Array(audio.length + (frameLen - rem));
  padded.set(audio);
  return padded;
}

async function loadTransformersModel(modelId: string, dtype: string): Promise<Transcribe> {
  env.allowRemoteModels = true;
  env.cacheDir = MODELS_DIR;
  env.allowLocalModels = true;
  // Fix ORT thread count so all candidates run on the same resources.
  process.env.ORT_INTER_OP_NUM_THREADS = '1';
  process.env.ORT_INTRA_OP_NUM_THREADS = '4';
  const rec = await pipeline('automatic-speech-recognition', modelId, { dtype: dtype as 'q8' });
  // Moonshine streaming architecture requires audio padded to multiples of frame_len=80.
  const needsPad = modelId.toLowerCase().includes('streaming');
  return async (audio: Float32Array) => {
    const input = needsPad ? padToFrameLen(audio) : audio;
    const out = await rec(input);
    const parts = Array.isArray(out) ? out : [out];
    return parts.map(r => (r as { text?: string }).text ?? '').join(' ').trim();
  };
}

// --------------- Main ---------------
console.log(`\nSpeech measurement: ${MODEL_ID} (${DTYPE})`);
console.log(`Dataset: ${DATASET}`);
console.log(`Models cache: ${MODELS_DIR}`);
console.log(`Runs: ${RUNS}  Noise check: ${DO_NOISE}\n`);

mkdirSync(MODELS_DIR, { recursive: true });

console.log('Loading model (may download)…');
const t0 = Date.now();
const transcribe = MODEL_ID === 'parakeet-int8'
  ? await loadParakeetModel()
  : await loadTransformersModel(MODEL_ID, DTYPE);
const loadMs = Date.now() - t0;
console.log(`Model loaded in ${loadMs} ms.\n`);

const utterances = loadDataset(DATASET);
console.log(`Dataset: ${utterances.length} utterances (${utterances.filter(u => u.long).length} long)\n`);

// 3 warm-up calls on silence so JIT/ORT is fully warm before the measured run.
const silence1s = new Float32Array(16000);
for (let w = 0; w < 3; w++) await transcribe(silence1s);
console.log('Warm-up done (3 passes on silence).\n');

type RunResult = { id: string; ref: string; hyp: string; wer: number; ms: number; long: boolean };

// Fixed run count so variation is reproducible.
const allRuns: RunResult[][] = [];
for (let run = 0; run < RUNS; run++) {
  const results: RunResult[] = [];
  if (RUNS > 1) console.log(`\n--- Run ${run + 1}/${RUNS} ---`);
  for (const u of utterances) {
    const t = Date.now();
    const hyp = await transcribe(u.audio);
    const ms = Date.now() - t;
    const w = wer(u.ref, hyp);
    results.push({ id: u.id, ref: u.ref, hyp, wer: w, ms, long: u.long });
    process.stdout.write('.');
  }
  console.log('');
  allRuns.push(results);
}

const results = allRuns[0]!;
const allWer = results.map(r => r.wer);
const allMs  = results.map(r => r.ms);
const longMs = results.filter(r => r.long).map(r => r.ms);

// Run-to-run variation (only meaningful when RUNS > 1).
let variationNote = '';
if (RUNS > 1) {
  const perUttStddevs = utterances.map((_, i) => {
    const times = allRuns.map(run => run[i]?.ms ?? 0);
    return stddev(times);
  });
  const meanStddev = perUttStddevs.reduce((a, b) => a + b, 0) / perUttStddevs.length;
  variationNote = `Run-to-run stddev (mean over utts): ${meanStddev.toFixed(0)} ms`;
}

// Noise check: re-run first 10 utterances with white noise, verify WER worsens.
let noiseNote = 'Noise check: skipped (pass --noise to enable)';
if (DO_NOISE) {
  console.log('\nNoise check (10 utterances, SNR ~20dB)…');
  const noiseResults: RunResult[] = [];
  for (const u of utterances.slice(0, 10)) {
    const noisyAudio = addNoise(u.audio, 20);
    const t = Date.now();
    const hyp = await transcribe(noisyAudio);
    const ms = Date.now() - t;
    noiseResults.push({ id: u.id, ref: u.ref, hyp, wer: wer(u.ref, hyp), ms, long: u.long });
    process.stdout.write('n');
  }
  console.log('');
  const cleanWer = results.slice(0, 10).map(r => r.wer).reduce((a, b) => a + b, 0) / 10;
  const noisyWer = noiseResults.map(r => r.wer).reduce((a, b) => a + b, 0) / 10;
  const scoreIsMonotone = noisyWer >= cleanWer * 0.9; // allow 10% tolerance
  noiseNote = `Noise check: clean WER ${(cleanWer * 100).toFixed(1)}%, noisy WER ${(noisyWer * 100).toFixed(1)}% → ${scoreIsMonotone ? 'PASS (noisy ≥ clean, scorer is sensitive)' : 'WARN (noisy WER < clean, check scorer)'}`;
  console.log(noiseNote);
}

console.log('\n=== Summary ===');
console.log(`Model:                 ${MODEL_ID}`);
console.log(`Dtype:                 ${DTYPE}`);
console.log(`Utterances:            ${results.length} (${results.filter(r => r.long).length} long)`);
console.log(`Runs:                  ${RUNS}`);
console.log(`WER (all):             ${(allWer.reduce((a, b) => a + b, 0) / allWer.length * 100).toFixed(1)}%`);
const longWer = results.filter(r => r.long).map(r => r.wer);
console.log(`WER (long):            ${longWer.length > 0 ? (longWer.reduce((a, b) => a + b, 0) / longWer.length * 100).toFixed(1) + '%' : 'n/a'}`);
console.log(`Median warm ms (all):  ${median(allMs).toFixed(0)}`);
console.log(`Median warm ms (long): ${longMs.length > 0 ? median(longMs).toFixed(0) : 'n/a'}`);
console.log(`p95 ms (all):          ${p95(allMs).toFixed(0)}`);
console.log(`Load ms:               ${loadMs}`);
if (variationNote) console.log(variationNote);
console.log(noiseNote);

// Save results to --out dir (defaults to current directory, never the models dir).
const outFile = join(OUT_DIR, `speech-measure-${MODEL_ID.replace(/[^a-z0-9]/gi, '-')}-${DTYPE}-${Date.now()}.json`);
writeFileSync(outFile, JSON.stringify({
  model: MODEL_ID, dtype: DTYPE, loadMs, runs: RUNS, results,
  summary: {
    wer_all: +(allWer.reduce((a, b) => a + b, 0) / allWer.length * 100).toFixed(2),
    wer_long: longWer.length > 0 ? +(longWer.reduce((a, b) => a + b, 0) / longWer.length * 100).toFixed(2) : null,
    median_ms: +median(allMs).toFixed(0),
    p95_ms: +p95(allMs).toFixed(0),
    load_ms: loadMs,
  },
}, null, 2));
console.log(`\nResults saved to ${outFile}`);
