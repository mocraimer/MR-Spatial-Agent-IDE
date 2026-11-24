/**
 * The bridge's one HTTPS port. The page and its code are public; everything else needs the
 * pairing cookie. Nothing here logs a pairing code, a token, or session text.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer, type Server } from 'node:https';
import { join } from 'node:path';
import { AuthenticationError, type HostCertificate, type PairingAuthority } from '../../host/src/auth.js';
import { command, type WindowInput } from '../shared/actions.js';
import type { BridgeEvent } from '../shared/messages.js';
import type { Bridge } from './bridge.js';
import { compiled, REPO } from './config.js';
import { MAX_SECONDS, SAMPLE_RATE } from '../shared/audio.js';

const INDEX = join(REPO, 'view', 'page', 'index.html');
const FONTS = join(REPO, 'view', 'page', 'fonts');
const COOKIE = 'svw';
const MAX_AUDIO_BYTES = MAX_SECONDS * SAMPLE_RATE * 4;
/** A page that stops reading (headset asleep) is dropped past this; it reconnects and resyncs. */
const MAX_BUFFERED = 8 * 1024 * 1024;
/** A page with more than this not yet sent to it skips pictures until it catches up. */
const MAX_FRAME_BUFFERED = 1024 * 1024;
const HEARTBEAT_MS = 10_000;

export interface ServerOptions {
  bridge: Bridge;
  pairing: PairingAuthority;
  certificate: HostCertificate;
  host: string;
  port: number;
  /** Shows a new pairing code to the owner at the PC. */
  showPairingCode: (code: string) => void;
  log: (line: string) => void;
}

export function startServer(options: ServerOptions): Promise<Server> {
  const { bridge, pairing, log } = options;
  const server = createServer({ key: options.certificate.key, cert: options.certificate.cert }, (req, res) => {
    route(req, res).catch(error => {
      const tooLarge = error instanceof Error && error.message === 'request body too large';
      if (!tooLarge) log(`request failed: ${req.method} ${pathOf(req)}: ${(error as Error).message}`);
      if (!res.headersSent) send(res, tooLarge ? 413 : 500, { error: tooLarge ? 'Too large a request.' : 'The bridge hit an error; see its terminal.' });
      else res.destroy();
    });
  });

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = pathOf(req);
    res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:");
    res.setHeader('Permissions-Policy', 'microphone=(self), xr-spatial-tracking=(self)');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');

    if (req.method === 'GET' && path === '/') return file(res, INDEX, 'text/html; charset=utf-8');
    const code = /^\/app\/(page|shared)\/([a-z-]+)\.js$/.exec(path);
    if (req.method === 'GET' && code) return file(res, compiled(code[1] as string, `${code[2] as string}.js`), 'text/javascript; charset=utf-8');
    const font = /^\/app\/fonts\/([A-Za-z-]+)\.woff2$/.exec(path);
    if (req.method === 'GET' && font) return file(res, join(FONTS, `${font[1] as string}.woff2`), 'font/woff2');

    if (req.method === 'POST' && path === '/api/pair') {
      if (!sameOrigin(req)) return send(res, 403, { error: 'Wrong origin.' });
      const body = await json(req, 1024);
      try {
        const paired = pairing.pair(typeof body.code === 'string' ? body.code : '', 'Quest headset');
        res.setHeader('Set-Cookie', `${COOKIE}=${paired.token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=34560000`);
        log('a headset paired');
        return send(res, 200, { ok: true });
      } catch (error) {
        if (!(error instanceof AuthenticationError)) throw error;
        log(`pairing refused: ${error.code}`);
        // The shared pairing code speaks of the earlier host's setup screen; this view's code is in its terminal.
        const say = error.code === 'pairing-rate-limited'
          ? 'Too many wrong codes. Wait a minute, then enter the newest code from the PC.'
          : 'That code is not current. Enter the code shown in the terminal where `npm run view` runs, or choose "Show a new code on the PC".';
        return send(res, error.code === 'pairing-rate-limited' ? 429 : 400, { error: say });
      }
    }
    if (req.method === 'POST' && path === '/api/pair/new') {
      if (!sameOrigin(req)) return send(res, 403, { error: 'Wrong origin.' });
      options.showPairingCode(pairing.setupCode().code);
      return send(res, 200, { ok: true });
    }

    if (!path.startsWith('/api/')) return send(res, 404, { error: 'Not found.' });
    if (!paired(req)) return send(res, 401, { error: 'This headset is not paired.' });
    if (req.method !== 'GET' && !sameOrigin(req)) return send(res, 403, { error: 'Wrong origin.' });

    if (req.method === 'GET' && path === '/api/session') return send(res, 200, { paired: true });
    if (req.method === 'GET' && path === '/api/events') return events(req, res);
    const said = /^\/api\/say\/([A-Za-z0-9-]{1,64})$/.exec(path);
    if (req.method === 'GET' && said) {
      const wav = bridge.clip(said[1] as string);
      if (!wav) return send(res, 404, { error: 'That phrase is gone.' });
      res.writeHead(200, { 'Content-Type': 'audio/wav', 'Cache-Control': 'no-store', 'Content-Length': wav.length });
      return void res.end(wav);
    }
    if (req.method === 'POST' && path === '/api/log') {
      const body = await json(req, 256);
      if (body.event === 'visibility' && typeof body.state === 'string' &&
          (body.state === 'visible' || body.state === 'visible-blurred' || body.state === 'hidden')) {
        log(`[page] visibility: ${body.state}`);
        return send(res, 200, { ok: true });
      }
      if (body.event === 'keyboard' && typeof body.open === 'boolean') {
        log(`[page] keyboard: ${body.open ? 'show' : 'close'}`);
        return send(res, 200, { ok: true });
      }
      if (body.event === 'keys' && typeof body.count === 'number' && Number.isFinite(body.count)) {
        log(`[page] keys per minute: ${Math.round(body.count)}`);
        return send(res, 200, { ok: true });
      }
      return send(res, 400, { error: 'Unknown event.' });
    }
    if (req.method === 'POST' && path === '/api/action') {
      const body = await json(req, 4096);
      if (typeof body.focus === 'string') return send(res, 200, await bridge.act({ kind: 'focus', sessionId: body.focus }));
      if (typeof body.go === 'string') return send(res, 200, await bridge.act({ kind: 'go', projectId: body.go }));
      if (typeof body.pick === 'number' && Number.isInteger(body.pick)) return send(res, 200, await bridge.act({ kind: 'pick', n: body.pick }));
      if (typeof body.window === 'string') {
        const input = windowInput(body.input);
        if (!input) return send(res, 400, { error: 'A click is {type:"click", x, y} and a scroll {type:"wheel", x, y, delta}, with x and y from 0 to 1.' });
        return send(res, 200, await bridge.act({ kind: 'window-input', sessionId: body.window, events: [input] }));
      }
      if (typeof body.type_text === 'string') {
        return send(res, 200, await bridge.act({ kind: 'type-text', text: body.type_text }));
      }
      if (typeof body.key === 'string') {
        const validKeys = ['enter','escape','ctrl+c','up','down','left','right','tab','backspace','y','n','1','2','3'] as const;
        type ValidKey = typeof validKeys[number];
        if (!validKeys.includes(body.key as ValidKey)) return send(res, 400, { error: 'Unknown key.' });
        return send(res, 200, await bridge.act({ kind: 'key', key: body.key as ValidKey }));
      }
      let found;
      try { found = command(String(body.command)); } catch { return send(res, 400, { error: 'Unknown action.' }); }
      if (!('bridge' in found.run)) return send(res, 400, { error: 'That action is done by the page.' });
      return send(res, 200, await bridge.act(found.run.bridge));
    }
    if (req.method === 'POST' && path === '/api/utterance') {
      const url = new URL(req.url ?? '/', 'https://view');
      // An id the page did not send (or sent empty) is no id: this utterance is new.
      const id = url.searchParams.get('id') || randomUUID();
      const receiver = url.searchParams.get('receiver');
      // Speech heard while listening is off: the bridge acts on commands only, each after a yes.
      const standby = url.searchParams.get('standby') === '1';
      const bytes = await body(req, MAX_AUDIO_BYTES);
      if (bytes.length === 0 || bytes.length % 4 !== 0) return send(res, 400, { error: 'Audio must be 16 kHz mono 32-bit float samples.' });
      const audio = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length));
      if (!audio.every(Number.isFinite)) return send(res, 400, { error: 'Audio samples must be finite numbers.' });
      return send(res, 200, await bridge.utterance(id, audio, receiver, standby));
    }
    if (req.method === 'POST' && path === '/api/mr') {
      const body2 = await json(req, 256);
      const pageId = typeof body2.pageId === 'string' ? body2.pageId : randomUUID();
      bridge.setMixedReality(pageId, body2.inMR === true);
      return send(res, 200, { ok: true });
    }
    return send(res, 404, { error: 'Not found.' });
  }

  function events(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write('retry: 1000\n\n');
    const push = (event: BridgeEvent | { type: 'ping' }) => {
      // A picture waits for nobody: a page still taking the last one skips this one; a later one follows.
      if (event.type === 'frame' && res.writableLength > MAX_FRAME_BUFFERED) return;
      if (res.writableLength > MAX_BUFFERED) { log('dropped a page that stopped reading; it will reconnect'); res.destroy(); return; }
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    const leave = bridge.connect(push);
    // A pairing revoked while the page is connected ends its stream; the page then sees 401.
    const beat = setInterval(() => { if (paired(req)) push({ type: 'ping' }); else res.end(); }, HEARTBEAT_MS);
    log('a page connected');
    req.on('close', () => { clearInterval(beat); leave(); log('a page disconnected'); });
  }

  function paired(req: IncomingMessage): boolean {
    const token = (req.headers.cookie ?? '').split(/;\s*/).find(c => c.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
    return token !== undefined && pairing.authenticate(`Bearer ${token}`) !== null;
  }

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => { server.off('error', reject); resolve(server); });
  });
}

/** A click or scroll on a mirrored window, as the page sends it; null when it is not one. */
function windowInput(v: unknown): WindowInput | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  const at = (n: unknown) => typeof n === 'number' && n >= 0 && n <= 1;
  if (!at(o.x) || !at(o.y)) return null;
  if (o.type === 'click') return { type: 'click', x: o.x as number, y: o.y as number };
  if (o.type === 'wheel' && typeof o.delta === 'number' && Number.isInteger(o.delta) && Math.abs(o.delta) <= 20) return { type: 'wheel', x: o.x as number, y: o.y as number, delta: o.delta };
  return null;
}

function pathOf(req: IncomingMessage): string { return new URL(req.url ?? '/', 'https://view').pathname; }

/** A browser sends Origin on these requests; a page of another origin is refused. */
function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  return origin === undefined || origin === `https://${req.headers.host ?? ''}`;
}

function send(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

function file(res: ServerResponse, path: string, type: string): void {
  let content: Buffer;
  try { content = readFileSync(path); } catch { return send(res, 404, { error: 'Not found.' }); }
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
  res.end(content);
}

function body(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      // Past the limit, keep draining so the 413 answer can still be sent.
      if (size > limit) { chunks.length = 0; reject(new Error('request body too large')); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** A JSON object body; anything else reads as {}. Too large a body still answers 413. */
async function json(req: IncomingMessage, limit: number): Promise<Record<string, unknown>> {
  const bytes = await body(req, limit);
  try {
    const value: unknown = JSON.parse(bytes.toString('utf8'));
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch { return {}; }
}
