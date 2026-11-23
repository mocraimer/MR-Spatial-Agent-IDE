/**
 * Speech model measurement: WER and transcription time per candidate, using a frozen utterance
 * set drawn from LibriSpeech test-other and TED-LIUM. Run with node after building:
 *
 *   node build/view/bench/speech-measure.js [--model <id>] [--dtype <dtype>] [--dataset <dir>]
 *
 * Required env / arguments:
 *   --dataset <dir>   Path to the utterance manifest directory (see view/bench/dataset/README).
 *                     Defaults to SPEECH_DATASET env var or ./speech-dataset.
 *   --model <id>      HuggingFace model id to test (default: current SPEECH_MODEL).
 *   --dtype <dtype>   Quantization dtype (default: SPEECH_DTYPE).
 *   --models-dir <d>  Where the models cache lives. Defaults to SPEECH_MODELS env var.
 *
 * Downloads the model if not already cached. Outputs per-utterance results and a summary table
 * with WER, median warm transcription time, and p95 shelf delay.
 *
 * Candidates evaluated per the brief:
 *   - onnx-community/moonshine-tiny-ONNX              q8  (current, baseline)
 *   - onnx-community/moonshine-v2-small-ONNX          q8
 *   - onnx-community/moonshine-v2-medium-ONNX         q8
 *   - nvidia/parakeet-tdt-0.6b-v2 (reference only, non-local)
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { env, pipeline } from '@huggingface/transformers';

// --------------- CLI args ---------------
const args = process.argv.slice(2);
const get = (flag: string, def: string): string => { const i = args.indexOf(flag); return i >= 0 && args[i + 1] ? (args[i + 1] as string) : def; };
const MODEL_ID  = get('--model',      process.env.SPEECH_MODEL  ?? 'onnx-community/moonshine-tiny-ONNX');
const DTYPE     = get('--dtype',      process.env.SPEECH_DTYPE  ?? 'q8');
const DATASET   = get('--dataset',    process.env.SPEECH_DATASET ?? './speech-dataset');
const MODELS_DIR = get('--models-dir', process.env.SPEECH_MODELS ?? './models');

// --------------- WER helpers ---------------
function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9 ']/g, ' ').replace(/\s+/g, ' ').trim();
}

function wer(ref: string, hyp: string): number {
  const r = normalize(ref).split(' ');
  const h = normalize(hyp).split(' ');
  // Levenshtein on word level.
  const dp: number[][] = Array.from({ length: r.length + 1 }, (_, i) => Array.from({ length: h.length + 1 }, (_, j) => i === 0 ? j : j === 0 ? i : 0));
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

// --------------- Dataset loading ---------------
interface Utterance { id: string; audio: Float32Array; ref: string; long: boolean }

function loadDataset(dir: string): Utterance[] {
  if (!existsSync(dir)) {
    console.error(`Dataset directory not found: ${dir}`);
    console.error('Run view/bench/download-speech-dataset.ts to fetch LibriSpeech test-other and TED-LIUM.');
    process.exit(1);
  }
  const manifest = join(dir, 'manifest.jsonl');
  if (!existsSync(manifest)) {
    console.error(`No manifest.jsonl in ${dir}. Run the dataset download script.`);
    process.exit(1);
  }
  const lines = readFileSync(manifest, 'utf8').trim().split('\n');
  const items = lines.map(l => JSON.parse(l) as { id: string; file: string; ref: string; long: boolean });
  return items.map(item => {
    const wavPath = join(dir, item.file);
    const wavBuf = readFileSync(wavPath);
    // Parse 16-bit PCM WAV: skip 44-byte header, read int16 LE samples.
    const samples = wavBuf.length > 44 ? (wavBuf.length - 44) / 2 : 0;
    const audio = new Float32Array(samples);
    for (let i = 0; i < samples; i++) audio[i] = (wavBuf.readInt16LE(44 + i * 2)) / 32768;
    return { id: item.id, audio, ref: item.ref, long: item.long };
  });
}

// --------------- Main ---------------
console.log(`\nSpeech measurement: ${MODEL_ID} (${DTYPE})`);
console.log(`Dataset: ${DATASET}`);
console.log(`Models cache: ${MODELS_DIR}\n`);

mkdirSync(MODELS_DIR, { recursive: true });

// Set up transformers env.
env.allowRemoteModels = true;
env.cacheDir = MODELS_DIR;
env.allowLocalModels = true;

console.log('Loading model (may download ~31 MB)…');
const t0 = Date.now();
const recognizer = await pipeline('automatic-speech-recognition', MODEL_ID, { dtype: DTYPE as 'q8' });
const loadMs = Date.now() - t0;
console.log(`Model loaded in ${loadMs} ms.\n`);

const utterances = loadDataset(DATASET);
console.log(`Dataset: ${utterances.length} utterances (${utterances.filter(u => u.long).length} long)\n`);

// Warm up with a silent frame.
await recognizer(new Float32Array(16000));

const results: Array<{ id: string; ref: string; hyp: string; wer: number; ms: number; long: boolean }> = [];

for (const u of utterances) {
  const t = Date.now();
  const out = await recognizer(u.audio);
  const ms = Date.now() - t;
  const parts = Array.isArray(out) ? out : [out];
  const hyp = parts.map(r => (r as { text?: string }).text ?? '').join(' ').trim();
  const w = wer(u.ref, hyp);
  results.push({ id: u.id, ref: u.ref, hyp, wer: w, ms, long: u.long });
  process.stdout.write('.');
}
console.log('\n');

// Summary
const allWer = results.map(r => r.wer);
const allMs  = results.map(r => r.ms);
const longMs = results.filter(r => r.long).map(r => r.ms);

console.log('=== Summary ===');
console.log(`Model:         ${MODEL_ID}`);
console.log(`Dtype:         ${DTYPE}`);
console.log(`Utterances:    ${results.length} (${results.filter(r => r.long).length} long)`);
console.log(`WER (all):     ${(allWer.reduce((a, b) => a + b, 0) / allWer.length * 100).toFixed(1)}%`);
console.log(`WER (long):    ${results.filter(r => r.long).length > 0 ? (results.filter(r => r.long).map(r => r.wer).reduce((a, b) => a + b, 0) / results.filter(r => r.long).length * 100).toFixed(1) + '%' : 'n/a'}`);
console.log(`Median warm ms (all):  ${median(allMs).toFixed(0)}`);
console.log(`Median warm ms (long): ${longMs.length > 0 ? median(longMs).toFixed(0) : 'n/a'}`);
console.log(`p95 ms (all):  ${p95(allMs).toFixed(0)}`);
console.log(`Load ms:       ${loadMs}`);

// Save results to a JSON file for comparison.
const outFile = join(MODELS_DIR, `speech-measure-${MODEL_ID.replace(/[^a-z0-9]/gi, '-')}-${DTYPE}-${Date.now()}.json`);
writeFileSync(outFile, JSON.stringify({ model: MODEL_ID, dtype: DTYPE, loadMs, results }, null, 2));
console.log(`\nResults saved to ${outFile}`);
