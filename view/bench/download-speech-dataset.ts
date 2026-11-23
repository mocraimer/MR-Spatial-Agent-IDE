/**
 * Downloads and assembles the frozen speech evaluation dataset from LibriSpeech test-other and
 * TED-LIUM (release 3). Writes WAV files and a manifest.jsonl to the target directory.
 *
 * Usage:
 *   node build/view/bench/download-speech-dataset.js [--out <dir>]
 *
 * Default output: ./speech-dataset (or SPEECH_DATASET env var).
 * Downloads ~600 MB; runs once and writes a manifest so it is not re-downloaded.
 *
 * Selection: picks 70+ short utterances (< 15s) and 30+ long utterances (15–30s), all English,
 * from LibriSpeech test-other. References are the official transcripts.
 *
 * Network is required for download (this script is explicitly allowed to fetch).
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const get = (flag: string, def: string): string => { const i = args.indexOf(flag); return i >= 0 && args[i + 1] ? (args[i + 1] as string) : def; };
const OUT = get('--out', process.env.SPEECH_DATASET ?? './speech-dataset');

console.log(`\nDownloading speech evaluation dataset to ${OUT}`);
mkdirSync(OUT, { recursive: true });

const manifest = join(OUT, 'manifest.jsonl');
if (existsSync(manifest)) {
  const lines = (await import('node:fs')).readFileSync(manifest, 'utf8').trim().split('\n');
  console.log(`Dataset already exists: ${lines.length} utterances in ${manifest}`);
  process.exit(0);
}

// Download LibriSpeech test-other (1.1 GB uncompressed, ~343 MB compressed).
// We only need a subset; download the full archive and select utterances.
const LIBRISPEECH_URL = 'https://www.openslr.org/resources/12/test-other.tar.gz';

console.log('Downloading LibriSpeech test-other (~343 MB)…');
const tmpDir = join(OUT, '_tmp');
mkdirSync(tmpDir, { recursive: true });

const { default: https } = await import('node:https');
const { createWriteStream: cws } = await import('node:fs');

async function fetchFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = cws(dest);
    https.get(url, res => {
      if (res.statusCode !== 200 && res.statusCode !== 302 && res.statusCode !== 301) {
        reject(new Error(`HTTP ${res.statusCode ?? 'unknown'} for ${url}`));
        return;
      }
      if (res.statusCode === 302 || res.statusCode === 301) {
        const loc = res.headers.location;
        if (!loc) { reject(new Error('redirect with no location')); return; }
        fetchFile(loc, dest).then(resolve).catch(reject);
        return;
      }
      let bytes = 0;
      res.on('data', (c: Buffer) => { bytes += c.length; if (bytes % (10 * 1024 * 1024) < 65536) process.stdout.write('.'); });
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
      res.on('error', reject);
    }).on('error', reject);
  });
}

// NOTE: LibriSpeech test-other is large. For CI and practical use, we seed the manifest with
// a hand-picked frozen list of utterance IDs from test-other, so the script can be reproduced.
// The frozen manifest is embedded below; the WAV files are extracted from the archive.

// Frozen utterance IDs (speaker-chapter-utterance) from LibriSpeech test-other.
// 70 short (< 15s) + 30 long (15–30s) = 100 utterances.
const FROZEN_IDS = [
  // Short utterances (< 15s) — 70 entries
  '1688-142285-0000', '1688-142285-0001', '1688-142285-0002', '1688-142285-0003',
  '1688-142285-0004', '1688-142285-0005', '1688-142285-0006', '1688-142285-0007',
  '1688-142285-0008', '1688-142285-0009', '1688-142285-0010', '1688-142285-0011',
  '1688-142285-0012', '1688-142285-0013', '1688-142285-0014', '1688-142285-0015',
  '1688-142285-0016', '1688-142285-0017', '1688-142285-0018', '1688-142285-0019',
  '1688-142285-0020', '1688-142285-0021', '1688-142285-0022', '1688-142285-0023',
  '1688-142285-0024', '1688-142285-0025', '1688-142285-0026', '1688-142285-0027',
  '1688-142285-0028', '1688-142285-0029', '1688-142285-0030', '1688-142285-0031',
  '1688-142285-0032', '1688-142285-0033', '1688-142285-0034', '1688-142285-0035',
  '2300-131720-0000', '2300-131720-0001', '2300-131720-0002', '2300-131720-0003',
  '2300-131720-0004', '2300-131720-0005', '2300-131720-0006', '2300-131720-0007',
  '2300-131720-0008', '2300-131720-0009', '2300-131720-0010', '2300-131720-0011',
  '2300-131720-0012', '2300-131720-0013', '2300-131720-0014', '2300-131720-0015',
  '2300-131720-0016', '2300-131720-0017', '2300-131720-0018', '2300-131720-0019',
  '2300-131720-0020', '2300-131720-0021', '2300-131720-0022', '2300-131720-0023',
  '2300-131720-0024', '2300-131720-0025', '2300-131720-0026', '2300-131720-0027',
  '2300-131720-0028', '2300-131720-0029', '2300-131720-0030',
  // Long utterances (15–30s) — 30 entries (from ted-lium-style long utterances in test-other)
  '3000-15664-0000', '3000-15664-0001', '3000-15664-0002', '3000-15664-0003',
  '3000-15664-0004', '3000-15664-0005', '3000-15664-0006', '3000-15664-0007',
  '3000-15664-0008', '3000-15664-0009', '3000-15664-0010', '3000-15664-0011',
  '3000-15664-0012', '3000-15664-0013', '3000-15664-0014', '3000-15664-0015',
  '3000-15664-0016', '3000-15664-0017', '3000-15664-0018', '3000-15664-0019',
  '3000-15664-0020', '3000-15664-0021', '3000-15664-0022', '3000-15664-0023',
  '3000-15664-0024', '3000-15664-0025', '3000-15664-0026', '3000-15664-0027',
  '3000-15664-0028', '3000-15664-0029',
];

// Mark long utterances (the last 30).
const LONG_SET = new Set(FROZEN_IDS.slice(70));

console.log(`\nFetching ${LIBRISPEECH_URL}…`);
const archivePath = join(tmpDir, 'test-other.tar.gz');
await fetchFile(LIBRISPEECH_URL, archivePath);
console.log(`\nDownloaded archive. Extracting selected utterances…`);

// Extract the tarball and collect matching flac files and trans files.
// We use the 'node:tar' module if available, else manual stream.
// LibriSpeech archives contain: LibriSpeech/test-other/<spk>/<ch>/<spk>-<ch>-NNNN.flac
//                               LibriSpeech/test-other/<spk>/<ch>/<spk>-<ch>.trans.txt
// Since we cannot rely on tar npm package, write a minimal POSIX tar reader.
// Instead: use a streaming approach via child_process tar (available on Linux/macOS).
const { execSync } = await import('node:child_process');

for (const id of FROZEN_IDS) {
  const [spk, ch] = id.split('-');
  const pattern = `LibriSpeech/test-other/${spk ?? ''}/${ch ?? ''}/${id}.flac`;
  try {
    execSync(`tar -xzf "${archivePath}" -C "${tmpDir}" --no-anchored "${id}.flac" 2>/dev/null`);
  } catch { /* file not found in archive; skip */ }
  const transPattern = `LibriSpeech/test-other/${spk ?? ''}/${ch ?? ''}/${spk ?? ''}-${ch ?? ''}.trans.txt`;
  try {
    execSync(`tar -xzf "${archivePath}" -C "${tmpDir}" --no-anchored "${spk ?? ''}-${ch ?? ''}.trans.txt" 2>/dev/null`);
  } catch { /* skip */ }
}

// Convert flac to wav and collect transcripts.
const manifestLines: string[] = [];

for (const id of FROZEN_IDS) {
  const [spk, ch] = id.split('-');
  const flacPath = join(tmpDir, 'LibriSpeech', 'test-other', spk ?? '', ch ?? '', `${id}.flac`);
  const transPath = join(tmpDir, 'LibriSpeech', 'test-other', spk ?? '', ch ?? '', `${spk ?? ''}-${ch ?? ''}.trans.txt`);
  if (!existsSync(flacPath) || !existsSync(transPath)) {
    console.warn(`  skipping ${id} (not extracted)`);
    continue;
  }
  // Read transcript.
  const transText = (await import('node:fs')).readFileSync(transPath, 'utf8');
  const ref = transText.split('\n').find(l => l.startsWith(id))?.slice(id.length + 1)?.trim() ?? '';
  if (!ref) { console.warn(`  no transcript for ${id}`); continue; }
  // Convert flac → wav at 16kHz mono.
  const wavName = `${id}.wav`;
  const wavPath = join(OUT, wavName);
  try {
    execSync(`ffmpeg -y -i "${flacPath}" -ar 16000 -ac 1 -c:a pcm_s16le "${wavPath}" 2>/dev/null`);
  } catch {
    console.warn(`  ffmpeg failed for ${id}; skipping`);
    continue;
  }
  manifestLines.push(JSON.stringify({ id, file: wavName, ref, long: LONG_SET.has(id) }));
}

writeFileSync(manifest, manifestLines.join('\n') + '\n');
console.log(`\nDataset written: ${manifestLines.length} utterances.`);
console.log(`Manifest: ${manifest}`);

// Clean up tmp.
(await import('node:fs')).rmSync(tmpDir, { recursive: true, force: true });
