/** `npm run view:setup`: fetches the free speech model once into the view's data directory. */
import { dataDirectory } from './config.js';
import { fetchModel, modelDirectory, SPEECH_MODEL } from './speech.js';

const models = modelDirectory(dataDirectory());
console.log(`Fetching ${SPEECH_MODEL} (about 31 MB) into ${models} …`);
await fetchModel(models);
console.log('Speech model ready. Start the view with `npm run view`.');
