/** `npm run view:setup`: fetches the speech and voice models once into the view's data directory. */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { dataDirectory } from './config.js';
import { fetchModel, modelDirectory, SPEECH_MODEL } from './speech.js';
import { fetchKokoroModel, KOKORO_MODEL } from './tts.js';

const models = modelDirectory(dataDirectory());

console.log(`Fetching ${SPEECH_MODEL} (about 100 MB) into ${models} …`);
await fetchModel(models);
console.log('Speech model ready.');

console.log('Fetching Kokoro-82M fp32 (about 311 MB) into models …');
await fetchKokoroModel(models);

// Verify the model landed where the view will look for it. If the cacheDir was not correctly
// redirected, from_pretrained stores files in kokoro-js's nested transformers cache instead,
// and the view falls back to the Windows voice without explaining why.
const kokoroPath = join(models, KOKORO_MODEL);
if (!existsSync(kokoroPath)) {
  console.error(`\nError: Kokoro model not found at ${kokoroPath} after setup.`);
  console.error('The model may have been downloaded to the wrong location.');
  console.error('Check view/bridge/fetch-kokoro-child.ts cacheDir wiring.');
  process.exit(1);
}
console.log('Kokoro model ready. Start the view with `npm run view`.');
