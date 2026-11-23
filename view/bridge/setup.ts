/** `npm run view:setup`: fetches the speech and voice models once into the view's data directory. */
import { dataDirectory } from './config.js';
import { fetchModel, modelDirectory, SPEECH_MODEL } from './speech.js';
import { fetchKokoroModel } from './tts.js';

const models = modelDirectory(dataDirectory());

console.log(`Fetching ${SPEECH_MODEL} (about 31 MB) into ${models} …`);
await fetchModel(models);
console.log('Speech model ready.');

console.log('Fetching Kokoro-82M fp32 (about 311 MB) into models …');
await fetchKokoroModel(models);
console.log('Kokoro model ready. Start the view with `npm run view`.');
