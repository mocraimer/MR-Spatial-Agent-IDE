import process from 'node:process';
import { setTimeout, clearTimeout } from 'node:timers';
import { readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { StringDecoder } from 'node:string_decoder';

const definitions = JSON.parse(readFileSync(process.env.SPATIAL_TOOL_DEFINITIONS, 'utf8'));
function bridge(request) {
  return new Promise((resolve, reject) => {
    const socket = connect(process.env.SPATIAL_TOOL_SOCKET);
    const decoder = new StringDecoder('utf8'); let buffer = ''; let bytes = 0; let consumed = false;
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('Private task tool acknowledgement timed out; do not replay uncertain effects.')); }, 40000);
    socket.on('connect', () => socket.write(JSON.stringify({ ...request, token: process.env.SPATIAL_TOOL_TOKEN }) + '\n'));
    socket.on('data', chunk => {
      if (consumed) return;
      bytes += chunk.length;
      if (bytes > 20000000) { consumed = true; socket.destroy(new Error('Task tool result exceeds limit.')); return; }
      buffer += decoder.write(chunk);
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      consumed = true; clearTimeout(timer); socket.end();
      try { const result = JSON.parse(buffer.slice(0, end)); if (result.error) reject(new Error(result.error)); else resolve(result.result); } catch (error) { reject(error); }
    });
    socket.on('error', error => { clearTimeout(timer); reject(error); });
    socket.on('close', () => { clearTimeout(timer); if (!buffer.includes('\n')) reject(new Error('Task tool connection lost; effect may be uncertain.')); });
  });
}
export default function (pi) {
  const names = definitions.map(tool => tool.name);
  for (const tool of definitions) pi.registerTool({
    name: tool.name, label: tool.name, description: tool.description, parameters: tool.inputSchema,
    async execute(_id, args, signal) {
      if (signal?.aborted) throw new Error('Turn aborted before tool execution.');
      const result = await bridge({ type: 'tool', name: tool.name, args });
      return { ...result, details: undefined };
    },
  });
  const inventory = () => ({ active: pi.getActiveTools(), registered: pi.getAllTools().map(tool => tool.name) });
  pi.on('session_start', async () => { await bridge({ type: 'inventory', ...inventory() }); });
  pi.on('before_agent_start', () => {
    if (JSON.stringify([...pi.getActiveTools()].sort()) !== JSON.stringify([...names].sort())) throw new Error('Unexpected active tool inventory.');
  });
  pi.on('tool_call', event => names.includes(event.toolName) ? undefined : { block: true, reason: 'Only this task’s bridged tools are available.' });
  pi.on('user_bash', () => { throw new Error('Host bash is unavailable. Use the confined task_exec tool.'); });
  pi.on('cache_warming_decision', () => ({ action: 'stop' }));
}
