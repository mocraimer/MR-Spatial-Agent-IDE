import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { it } from 'node:test';
import { TASK_TOOL_DEFINITIONS } from '../src/runtime-tools.js';
import { RuntimeProcess } from '../src/runtime-process.js';

for (const runtime of ['mcp', 'pi-extension']) {
  for (const mode of ['split', 'byte-bound', 'truncated'] as const) {
    it(`actual runtime-${runtime} selector ${mode} response preserves bytes or refuses acknowledgement`, async () => {
      const directory = mkdtempSync(join(tmpdir(), 'srw-'));
      const socketPath = join(directory, 's');
      const sockets = new Set<Socket>(); const requests: Record<string, unknown>[] = [];
      const server = createServer(socket => {
        sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => undefined);
        let buffer = Buffer.alloc(0);
        socket.on('data', chunk => {
          buffer = Buffer.concat([buffer, chunk]); const end = buffer.indexOf(10); if (end < 0) return;
          const request = JSON.parse(buffer.subarray(0, end).toString()) as Record<string, unknown>; requests.push(request);
          const text = mode === 'byte-bound' ? '€'.repeat(7_000_000) : 'exact € 🤖 result';
          const response = Buffer.from(JSON.stringify({ result: { content: [{ type: 'text', text }] } }) + '\n');
          if (mode === 'truncated') { socket.end(response.subarray(0, response.indexOf(Buffer.from('€')) + 1)); return; }
          if (mode === 'byte-bound') { socket.end(response); return; }
          const split = response.indexOf(Buffer.from('€')) + 1;
          socket.write(response.subarray(0, split)); setTimeout(() => socket.end(response.subarray(split)), 30);
        });
      });
      server.listen(socketPath); await once(server, 'listening');
      writeFileSync(join(directory, 'tools.json'), JSON.stringify(TASK_TOOL_DEFINITIONS));
      const extensionFixture = join(directory, 'extension.mjs');
      writeFileSync(extensionFixture, `import extension from ${JSON.stringify('file://' + resolve('scripts/runtime-pi-extension.mjs'))};
const tools=[];extension({registerTool:t=>tools.push(t),on:()=>{}});
try { console.log(JSON.stringify(await tools.find(t=>t.name==='task_write').execute('fixture',{path:'euro-€.txt',text:'preserve € 🤖'}))); }
catch(error) { console.log(JSON.stringify({error:error.message})); }`);
      const child = spawn(process.execPath, [runtime === 'mcp' ? resolve('scripts/runtime-mcp.mjs') : extensionFixture], {
        env: { PATH: process.env.PATH, SPATIAL_TOOL_SOCKET: socketPath, SPATIAL_TOOL_TOKEN: 'private-fixture', SPATIAL_TOOL_DEFINITIONS: join(directory, 'tools.json') }, stdio: ['pipe', 'pipe', 'pipe'],
      });
      let output = ''; let diagnostics = ''; child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { diagnostics += chunk; });
      const closed = once(child, 'close'); const timeout = setTimeout(() => child.kill('SIGKILL'), 10000);
      try {
        if (runtime === 'mcp') {
          const request = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 'fixture', method: 'tools/call', params: { name: 'task_write', arguments: { path: 'euro-€.txt', text: 'preserve € 🤖' } } }) + '\n');
          const split = request.indexOf(Buffer.from('€')) + 1; child.stdin.write(request.subarray(0, split));
          await new Promise(accept => setTimeout(accept, 30)); child.stdin.end(request.subarray(split));
        } else child.stdin.end();
        const [code] = await closed; assert.equal(code, 0, diagnostics);
        const value = JSON.parse(output) as { result?: { content: { text: string }[]; isError?: boolean }; content?: { text: string }[]; error?: string };
        if (mode === 'split') assert.equal((runtime === 'mcp' ? value.result!.content : value.content)![0]!.text, 'exact € 🤖 result');
        else if (runtime === 'mcp') assert.equal(value.result!.isError, true);
        else assert.match(value.error!, mode === 'byte-bound' ? /exceeds limit/ : /connection lost/);
        assert.equal(requests.length, 1); assert.equal(requests[0]!.token, 'private-fixture'); assert.equal(requests[0]!.name, 'task_write');
        assert.deepEqual(requests[0]!.args, { path: 'euro-€.txt', text: 'preserve € 🤖' });
      } finally {
        clearTimeout(timeout); child.kill('SIGKILL'); for (const socket of sockets) socket.destroy();
        await new Promise<void>(accept => server.close(() => accept())); rmSync(directory, { recursive: true, force: true });
      }
    });
  }
}

it('MCP stdin bounds raw bytes and never flushes incomplete records at EOF', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'srw-'));
  writeFileSync(join(directory, 'tools.json'), JSON.stringify(TASK_TOOL_DEFINITIONS));
  try {
    for (const payload of [Buffer.from('{"id":1,"method":"ping","text":"€').subarray(0, -1), Buffer.from(JSON.stringify({ id: 1, method: 'ping', text: '€'.repeat(700000) }) + '\n')]) {
      const child = spawn(process.execPath, [resolve('scripts/runtime-mcp.mjs')], { env: { SPATIAL_TOOL_DEFINITIONS: join(directory, 'tools.json') }, stdio: ['pipe', 'pipe', 'pipe'] });
      let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stdin.on('error', () => undefined);
      const closed = once(child, 'close'); child.stdin.end(payload);
      assert.equal((await closed)[0], 1); assert.equal(output, '');
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

it('RuntimeProcess rejects multibyte stdout above its raw-byte bound without acknowledging a record', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'srw-'));
  const file = join(directory, 'oversized.mjs');
  writeFileSync(file, `process.stdout.write(JSON.stringify({type:'oversized',text:'€'.repeat(7000000)})+'\\n');process.stdin.resume();`);
  const runtime = new RuntimeProcess(process.execPath, [file], directory, { PATH: process.env.PATH });
  const records: unknown[] = []; runtime.subscribe(record => records.push(record));
  try {
    await assert.rejects(runtime.waitFor(() => true, 5000), /protocol bound exceeded/);
    assert.equal(records.length, 0);
  } finally { await runtime.close(); rmSync(directory, { recursive: true, force: true }); }
});

it('RuntimeProcess byte frames split UTF-8 stdout and ignores truncated EOF', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'srw-'));
  const file = join(directory, 'fixture.mjs');
  writeFileSync(file, `const r=Buffer.from(JSON.stringify({type:'complete',text:'exact € 🤖'})+'\\n');const n=r.indexOf(Buffer.from('€'))+1;process.stdout.write(r.subarray(0,n));setTimeout(()=>{process.stdout.write(r.subarray(n));process.stdout.write(Buffer.from('{"type":"truncated","text":"€').subarray(0,-1));},30);process.stdin.on('end',()=>process.exit(0));process.stdin.resume();`);
  const runtime = new RuntimeProcess(process.execPath, [file], directory, { PATH: process.env.PATH });
  const records: unknown[] = []; runtime.subscribe(record => records.push(record));
  try {
    assert.equal((await runtime.waitFor(record => record.type === 'complete', 3000)).text, 'exact € 🤖');
    await runtime.close(); assert.equal(records.length, 1);
  } finally { await runtime.close(); rmSync(directory, { recursive: true, force: true }); }
});
