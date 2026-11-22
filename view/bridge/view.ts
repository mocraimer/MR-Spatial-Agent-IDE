/** Puts the bridge together. `main.ts` runs it on the owner's Herdr; tests run it on a bench. */
import type { Server as NetServer } from 'node:net';
import type { Server } from 'node:https';
import { join } from 'node:path';
import { ensureHostCertificate, PairingAuthority } from '../../host/src/auth.js';
import { Bridge, type HelperAgent, type Transcriber } from './bridge.js';
import { claudeHaiku, Helper, serveCloseRequests } from './helper.js';
import { HerdrClient } from './herdr.js';
import { DEFAULT_MIRROR, Mirror, type MirrorOptions } from './mirror.js';
import { startServer } from './server.js';
import { LocalSpeech, modelDirectory } from './speech.js';

export interface ViewOptions {
  herdrSocket: string;
  dataDirectory: string;
  host: string;
  port: number;
  showPairingCode: (code: string) => void;
  log: (line: string) => void;
  /** Tests may stand in for the speech model or the helper; by default both are real. */
  speech?: Transcriber;
  helper?: HelperAgent;
  mirror?: MirrorOptions;
  closeAnswerMs?: number;
}

export interface RunningView {
  bridge: Bridge;
  mirror: Mirror;
  pairing: PairingAuthority;
  server: Server;
  url: string;
  stop(): Promise<void>;
}

export async function startView(options: ViewOptions): Promise<RunningView> {
  const herdr = new HerdrClient(options.herdrSocket);
  const mirror = new Mirror(herdr, options.mirror ?? DEFAULT_MIRROR);
  let speech = options.speech;
  if (!speech) {
    const local = new LocalSpeech(modelDirectory(options.dataDirectory));
    await local.load();
    const speechState = local.state();
    if (!speechState.ready) options.log(`speech unavailable: ${speechState.reason}`);
    speech = local;
  }
  const closeSocket = join(options.dataDirectory, 'helper.sock');
  const helper = options.helper ?? new Helper(herdr, claudeHaiku(join(options.dataDirectory, 'helper')), closeSocket);
  const bridge = new Bridge(herdr, mirror, speech, helper, options.closeAnswerMs);
  const closeServer: NetServer = serveCloseRequests(closeSocket, ref => bridge.requestClose(ref));
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
      if (link !== lastLink) { lastLink = link; options.log(link); }
    },
    text: () => undefined,
  });
  mirror.start();
  const server = await startServer({ bridge, pairing, certificate, host: options.host, port: options.port, showPairingCode: options.showPairingCode, log: options.log });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : options.port;
  return {
    bridge, mirror, pairing, server,
    url: `https://127.0.0.1:${port}`,
    async stop() {
      mirror.stop();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      await new Promise(resolve => closeServer.close(resolve));
    },
  };
}
