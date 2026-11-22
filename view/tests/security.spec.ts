import { expect, test } from '@playwright/test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { join } from 'node:path';
import { pair, rig, type Rig } from './fixture.js';

test.use({ ignoreHTTPSErrors: true });
let r: Rig;
test.afterEach(async () => { await r?.stop(); });

const MARKER = 'SECRET-PANE-MARKER-7f3a';
interface Reply { status: number; body: string; headers: Record<string, string | string[] | undefined> }
function call(port: number, method: string, path: string, body?: string | Buffer, headers: Record<string, string> = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest({ host: '127.0.0.1', port, method, path, rejectUnauthorized: false, headers }, res => {
      let data = '';
      res.on('data', c => { data += String(c); if (path === '/api/events' && data.length > 0) req.destroy(); });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data, headers: res.headers }));
      res.on('close', () => resolve({ status: res.statusCode ?? 0, body: data, headers: res.headers }));
    });
    req.on('error', reject);
    req.end(body);
  });
}
/** Every file under a directory, as text. */
function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) return filesUnder(path);
    return stat.isFile() ? [readFileSync(path, 'latin1')] : [];
  });
}

test('only a paired headset reads or drives sessions; nothing logs a secret or session text', async ({ page }) => {
  test.setTimeout(90_000);
  r = await rig([{ label: 'alpha', panes: [{ name: 'a1', kind: 'agent' }, { name: 'sh', kind: 'shell' }] }]);
  await r.bench.type('sh', `echo ${MARKER}`);
  await expect.poll(async () => (await r.bench.client.read(r.bench.pane('sh'), 10)).includes(MARKER)).toBe(true);
  const port = Number(new URL(r.view.url).port);
  const focusedBefore = (await r.bench.client.snapshot()).focusedPaneId;

  // Every endpoint the server routes, without credentials. The page's own files are public and
  // hold no session data; everything under /api refuses.
  expect((await call(port, 'GET', '/')).status).toBe(200);
  expect((await call(port, 'GET', '/app/page/main.js')).status).toBe(200);
  expect((await call(port, 'GET', '/app/fonts/Inter-Regular.woff2')).status).toBe(200);
  expect((await call(port, 'GET', '/app/fonts/..%2Findex.woff2')).status).toBe(404);
  for (const [method, path, body] of [
    ['GET', '/api/session', undefined], ['GET', '/api/events', undefined],
    ['POST', '/api/action', JSON.stringify({ focus: r.bench.pane('sh') })], ['POST', '/api/action', JSON.stringify({ command: 'enter' })],
    ['POST', `/api/utterance?receiver=${r.bench.pane('sh')}`, Buffer.alloc(64000)],
  ] as const) {
    const reply = await call(port, method, path, body);
    expect(reply.status, `${method} ${path}`).toBe(401);
    expect(reply.body).not.toContain(MARKER);
    expect(reply.body).not.toContain('alpha');
  }
  // A forged cookie is no pairing.
  expect((await call(port, 'GET', '/api/events', undefined, { cookie: `svw=sw_${'a'.repeat(64)}` })).status).toBe(401);

  // Plain HTTP on the same port gets no answer with data.
  const plain = await new Promise<string>(resolve => {
    const req = httpRequest({ host: '127.0.0.1', port, path: '/api/session' }, res => { let d = ''; res.on('data', c => { d += String(c); }); res.on('end', () => resolve(`${res.statusCode} ${d}`)); });
    req.on('error', e => resolve(`error ${e.message}`));
    req.end();
  });
  expect(plain).not.toContain(MARKER);
  expect(plain).not.toContain('paired');

  // A page of another origin in the same browser as the paired page.
  await pair(page, r);
  const other = createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<!doctype html><title>other</title>'); });
  await new Promise<void>(resolve => other.listen(0, '127.0.0.1', resolve));
  const otherPort = (other.address() as { port: number }).port;
  try {
    const evil = await page.context().newPage();
    await evil.goto(`http://127.0.0.1:${otherPort}/`);
    const attempts = await evil.evaluate(async ({ bridge, pane }) => {
      const out: string[] = [];
      for (const [path, init] of [
        ['/api/session', { credentials: 'include' }],
        ['/api/action', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ focus: pane }) }],
      ] as const) {
        try { const res = await fetch(`${bridge}${path}`, init as RequestInit); out.push(`${res.status} ${await res.text()}`); } catch (e) { out.push(`blocked ${(e as Error).message}`); }
      }
      return out;
    }, { bridge: r.view.url, pane: r.bench.pane('sh') });
    for (const a of attempts) expect(a).toMatch(/^blocked/);
    await evil.close();
  } finally { other.close(); }
  expect((await r.bench.client.snapshot()).focusedPaneId, 'the other page moved nothing').toBe(focusedBefore);

  // A wrong code, repeated, until the bridge's own limit answers; then even the right code waits.
  const code = r.view.pairing.setupCode().code;
  let status = 0;
  for (let i = 0; i < 30 && status !== 429; i += 1) status = (await call(port, 'POST', '/api/pair', JSON.stringify({ code: 'WRONG' }), { 'content-type': 'application/json' })).status;
  expect(status).toBe(429);
  expect((await call(port, 'POST', '/api/pair', JSON.stringify({ code }), { 'content-type': 'application/json' })).status).toBe(429);

  // No pairing code, token or session text in anything the bridge logged or wrote.
  const token = (await page.context().cookies()).find(c => c.name === 'svw')?.value as string;
  expect(token).toMatch(/^sw_/);
  const written = [...r.logs, ...filesUnder(r.data)].join('\n');
  for (const secret of [code, token, MARKER]) expect(written.includes(secret), `${secret.slice(0, 6)}… not written`).toBe(false);
});
