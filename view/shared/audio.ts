/** What the page sends and the bridge accepts: 16 kHz mono 32-bit float samples. */
export const SAMPLE_RATE = 16_000;
/** Longest utterance, in seconds. The page sends what it has at this length. */
export const MAX_SECONDS = 30;

/** Phrases of spoken output that may wait behind the one being made or played, on the bridge and on the page alike. */
export const VOICE_WAITING_MAX = 3;
