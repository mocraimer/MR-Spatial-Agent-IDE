import process from 'node:process';
import { Buffer } from 'node:buffer';
import { setTimeout, clearTimeout } from 'node:timers';
import { readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { StringDecoder } from 'node:string_decoder';

const tools = JSON.parse(readFileSync(process.env.SPATIAL_TOOL_DEFINITIONS, 'utf8'));
function call(name, args) {
  return new Promise((resolve, reject) => {
    const socket = connect(process.env.SPATIAL_TOOL_SOCKET); const decoder = new StringDecoder('utf8'); let buffer = ''; let bytes = 0; let consumed = false;
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('Task tool acknowledgement timed out; effect may be uncertain.')); }, 40000);
    socket.on('connect', () => socket.write(JSON.stringify({ token: process.env.SPATIAL_TOOL_TOKEN, type: 'tool', name, args }) + '\n'));
    socket.on('data', chunk => {
      if (consumed) return;
      bytes += chunk.length;
      if (bytes > 20000000) { consumed = true; socket.destroy(new Error('Tool output exceeds bound.')); return; }
      buffer += decoder.write(chunk);
      const end = buffer.indexOf('\n'); if (end < 0) return;
      consumed = true; clearTimeout(timer); socket.end();
      try { const result = JSON.parse(buffer.slice(0, end)); if (result.error) reject(new Error(result.error)); else resolve(result.result); } catch (error) { reject(error); }
    });
    socket.on('error', error => { clearTimeout(timer); reject(error); });
    socket.on('close', () => { clearTimeout(timer); if (!buffer.includes('\n')) reject(new Error('Tool connection lost; effect may be uncertain.')); });
  });
}
async function handle(request) {
  if (request.id === undefined) return;
  let result;
  if (request.method === 'initialize') result = { protocolVersion: request.params?.protocolVersion ?? '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'spatial-task', version: '1' } };
  else if (request.method === 'tools/list') result = { tools };
  else if (request.method === 'ping') result = {};
  else if (request.method === 'tools/call' && tools.some(tool => tool.name === request.params?.name)) {
    try { result = await call(request.params.name, request.params.arguments); }
    catch { result = { isError: true, content: [{ type: 'text', text: 'Task tool was not acknowledged. Refresh current authority/environment; do not replay uncertain effects.' }] }; }
  } else { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Only fixed task tools are available.' } }) + '\n'); return; }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
}
let buffer = Buffer.alloc(0); let failed = false;
process.stdin.on('data', chunk => {
  if (failed) return;
  if (buffer.length + chunk.length > 2000000) { failed = true; process.exitCode = 1; process.stdin.destroy(); return; }
  buffer = Buffer.concat([buffer, chunk]);
  for (let end; (end = buffer.indexOf(10)) >= 0;) {
    const line = buffer.subarray(0, end).toString('utf8'); buffer = buffer.subarray(end + 1);
    try { void handle(JSON.parse(line)).catch(() => { process.exitCode = 1; }); } catch { process.exitCode = 1; }
  }
});
// Newline is the completion boundary. Never flush a truncated UTF-8/JSON record into a request.
process.stdin.on('end', () => { if (buffer.length) process.exitCode = 1; });
