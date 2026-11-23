/**
 * An agent's order to show a page or a PC window in a project, sent to the bridge over its mirror
 * socket. The project agent sends it through the level tool, for its own project only; the helper
 * through `mirror-tool.js`, for any project.
 */
import { connect } from 'node:net';
import { join } from 'node:path';
import { dataDirectory } from './config.js';

/** A web address (with or without http://, or localhost:port), else a window's name. */
export function asOrder(target: string, workspace: string): { open: string; workspace: string } | { mirror: string; workspace: string } {
  const t = target.trim();
  if (/^https?:\/\//i.test(t)) return { open: t, workspace };
  if (/^(localhost|127\.0\.0\.1)(:\d+)?(\/\S*)?$/i.test(t) || /^[\w-]+(\.[\w-]+)+(:\d+)?(\/\S*)?$/.test(t)) return { open: `http://${t}`, workspace };
  return { mirror: t, workspace };
}

export function sendOrder(order: object, socketPath = process.env.SPATIAL_VIEW_MIRROR_SOCKET ?? join(dataDirectory(), 'mirror.sock')): Promise<{ ok: boolean; answer: string }> {
  return new Promise(resolve => {
    const socket = connect(socketPath);
    let buffer = '';
    socket.on('connect', () => socket.write(`${JSON.stringify(order)}\n`));
    socket.on('data', chunk => { buffer += chunk.toString('utf8'); });
    socket.on('error', () => resolve({ ok: false, answer: 'The view is not running on the PC (npm run view), so nothing can be mirrored.' }));
    socket.on('close', () => {
      try { const m = JSON.parse(buffer.trim()) as { ok?: unknown; answer?: unknown }; resolve({ ok: m.ok === true, answer: typeof m.answer === 'string' ? m.answer : 'No answer.' }); } catch { resolve({ ok: false, answer: 'The view gave no answer.' }); }
    });
  });
}
