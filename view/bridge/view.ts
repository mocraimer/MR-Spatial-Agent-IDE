/** Puts the bridge together. `main.ts` runs it on the owner's Herdr; tests run it on a bench. */
import type { Server as NetServer } from 'node:net';
import type { Server } from 'node:https';
import { join } from 'node:path';
import { ensureHostCertificate, PairingAuthority } from '../../host/src/auth.js';
import { claudeAgents, HerdrLevelAgents, serveCloseRequests, type LevelAgents } from './agents.js';
import { Bridge, type Transcriber } from './bridge.js';
import { HerdrClient } from './herdr.js';
import { fileLog } from './log.js';
import { DEFAULT_MIRROR, Mirror, type MirrorOptions } from './mirror.js';
import { Mirrors } from './mirrors.js';
import { HelperWindows, type Windows } from './windows.js';
import { startServer } from './server.js';
import { Settings } from './settings.js';
import { KokoroVoice, WindowsVoice, KOKORO_MODEL, KOKORO_VOICE, type Voice } from './tts.js';
import { existsSync } from 'node:fs';
import { LocalSpeech, modelDirectory } from './speech.js';

export interface ViewOptions {
  herdrSocket: string;
  dataDirectory: string;
  host: string;
  port: number;
  showPairingCode: (code: string) => void;
  log: (line: string) => void;
  /** Tests may stand in for the speech model or the level agents; by default both are real. */
  speech?: Transcriber;
  agents?: LevelAgents;
  /** The voice for spoken answers: by default the Windows voice; null for none (tests). */
  voice?: Voice | null;
  /** Where Claude Code's transcripts are; by default the owner's. */
  transcripts?: string;
  confirmMs?: number;
  mirror?: MirrorOptions;
  closeAnswerMs?: number;
  standbyAnswerMs?: number;
  /** The PC's windows; by default the helper on Windows (or the stand-in SPATIAL_WINDOW_HELPER names). */
  windows?: Windows;
}

export interface RunningView {
  /** The view's log: the terminal and `view.log` in the data directory. */
  log: (line: string) => void;
  bridge: Bridge;
  mirror: Mirror;
  pairing: PairingAuthority;
  server: Server;
  url: string;
  stop(): Promise<void>;
}

export async function startView(options: ViewOptions): Promise<RunningView> {
  const log = fileLog(options.dataDirectory, options.log);
  const herdr = new HerdrClient(options.herdrSocket);
  const mirror = new Mirror(herdr, options.mirror ?? DEFAULT_MIRROR);
  let speech = options.speech;
  if (!speech) {
    const local = new LocalSpeech(modelDirectory(options.dataDirectory));
    await local.load();
    const speechState = local.state();
    if (!speechState.ready) log(`speech unavailable: ${speechState.reason}`);
    speech = local;
  }
  const closeSocket = join(options.dataDirectory, 'helper.sock');
  const agents = options.agents ?? new HerdrLevelAgents(herdr, claudeAgents(join(options.dataDirectory, 'agents')), closeSocket);
  const settings = new Settings(options.dataDirectory);
  // A mutable ref for the bridge, so Kokoro callbacks (which fire ~7 s after startup) can
  // reach the bridge that is created below. The closure captures the ref object by reference.
  const ref: { bridge?: Bridge } = {};
  let voice: Voice | null;
  if (options.voice !== undefined) {
    voice = options.voice;
  } else {
    const kokoro_model = join(modelDirectory(options.dataDirectory), KOKORO_MODEL);
    const windows = new WindowsVoice();
    if (!existsSync(kokoro_model)) {
      log(`Kokoro model not found; using Windows voice. Run \`npm run view:setup\` once to download it.`);
      voice = windows;
    } else {
      voice = new KokoroVoice(
        kokoro_model,
        KOKORO_VOICE,
        windows,
        () => {
          log('Kokoro voice ready');
          ref.bridge?.announceVoice(); // Broadcast updated voice state (standingIn → false).
        },
        reason => {
          log(`Kokoro voice failed: ${reason}`);
          ref.bridge?.notice(`The Kokoro voice failed to load. The Windows voice is being used instead.`);
          ref.bridge?.announceVoice(); // Broadcast voice state so pages show the trouble state.
        },
      );
    }
  }
  const mirrors = new Mirrors(herdr, options.windows ?? new HelperWindows(log), join(options.dataDirectory, 'mirror.sock'), log);
  const speechKeepDir = join(options.dataDirectory, 'speech-kept');
  const bridge = new Bridge(herdr, mirror, speech, agents, { closeAnswerMs: options.closeAnswerMs, standbyAnswerMs: options.standbyAnswerMs, log, settings, mirrors, speechKeepDir, ...(voice ? { voice } : {}), ...(options.transcripts ? { transcripts: options.transcripts } : {}), ...(options.confirmMs ? { confirmMs: options.confirmMs } : {}) });
  ref.bridge = bridge;
  const closeServer: NetServer = serveCloseRequests(closeSocket, ref => bridge.requestClose(ref), log);
  mirrors.serve(order => bridge.mirrorOrder(order));
  const pairing = new PairingAuthority(join(options.dataDirectory, 'pairing'));
  const tls = join(options.dataDirectory, 'tls');
  let certificate;
  try { certificate = ensureHostCertificate(tls); } catch (error) {
    // The shared certificate code speaks of the earlier host's setup; say what to do here.
    throw new Error(`The view's certificate cannot be used (${(error as Error).message}). Delete ${tls}, start the view again, and accept the new certificate once on the headset.`);
  }
  let lastLink = '';
  mirror.listen({
    shelf: shelf => {
      const link = shelf.herdr.state === 'up' ? 'Herdr connected' : `Herdr unavailable: ${shelf.herdr.reason}`;
      if (link !== lastLink) { lastLink = link; log(link); }
    },
    text: () => undefined,
  });
  mirror.start();
  const server = await startServer({ bridge, pairing, certificate, host: options.host, port: options.port, showPairingCode: options.showPairingCode, log });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : options.port;
  return {
    log, bridge, mirror, pairing, server,
    url: `https://127.0.0.1:${port}`,
    async stop() {
      mirror.stop();
      bridge.stop();
      if (voice instanceof KokoroVoice) voice.stop();
      mirrors.close();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      await new Promise(resolve => closeServer.close(resolve));
    },
  };
}
