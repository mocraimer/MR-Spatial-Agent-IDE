import assert from 'node:assert/strict';
import { test } from 'node:test';
import { plain } from '../shared/ansi.js';
import { HerdrBench } from '../bench/bench.js';
import { DEFAULT_MIRROR, Mirror } from '../bridge/mirror.js';


/** Line numbers `stream <tag> L00042` of one run in a read of the pane, in screen order. */
function numbers(text: string, tag: string): number[] {
  return [...plain(text).matchAll(new RegExp(`stream ${tag} L(\\d{5})`, 'g'))].map(m => Number(m[1]));
}

test('Herdr carries live output, bursts and status changes through the mirror without loss or reordering', async t => {
  const bench = await HerdrBench.start([{ label: 'streams', panes: [{ name: 'stream', kind: 'agent' }, { name: 'typing', kind: 'shell' }] }]);
  const mirror = new Mirror(bench.client, DEFAULT_MIRROR);
  const reads: string[] = [];
  const statuses: string[] = [];
  const stop = mirror.listen({
    text: (id, text) => { if (id === bench.pane('stream')) reads.push(text); },
    shelf: shelf => {
      const status = shelf.sessions.find(s => s.id === bench.pane('stream'))?.status;
      if (status && statuses.at(-1) !== status) statuses.push(status);
    },
  });
  try {
    await bench.client.call('pane.focus', { pane_id: bench.pane('stream') });
    mirror.start();

    // Each run carries its own tag, so lines left on screen by an earlier run never count.
    for (const [command, tag, count] of [['/steady 300 5 s1', 's1', 300], ['/burst 400 b1', 'b1', 400], ['/steady 120 20 s2', 's2', 120], ['/burst 450 b2', 'b2', 450]] as const) {
      reads.length = 0;
      await bench.type('stream', command);
      await bench.waitFor(async () => reads.some(text => plain(text).includes(`stream ${tag} END ${count}`)), `${command} to finish`, 20_000);
      const seen = new Set<number>();
      for (const text of reads) {
        const window = numbers(text, tag);
        for (let i = 1; i < window.length; i += 1) {
          assert.equal((window[i] ?? 0) - (window[i - 1] ?? 0), 1, `${command}: read shows ${window[i - 1]} then ${window[i]}`);
        }
        for (const n of window) seen.add(n);
      }
      const missing = Array.from({ length: count }, (_, i) => i + 1).filter(n => !seen.has(n));
      assert.deepEqual(missing, [], `${command}: every printed line was read`);
    }

    for (const status of ['blocked', 'working', 'idle'] as const) {
      await bench.type('stream', `/status ${status}`);
      await bench.waitFor(async () => statuses.at(-1) === status, `status ${status} to reach the mirror`);
    }
    assert.deepEqual(statuses.slice(-3), ['blocked', 'working', 'idle']);

    await bench.client.call('pane.focus', { pane_id: bench.pane('typing') });
    const typing: string[] = [];
    const stopTyping = mirror.listen({ text: (id, text) => { if (id === bench.pane('typing')) typing.push(plain(text)); }, shelf: () => undefined });
    const delays: number[] = [];
    try {
      for (let i = 0; i < 25; i += 1) {
        const mark = `k${i}q`;
        const sent = performance.now();
        await bench.client.call('pane.send_text', { pane_id: bench.pane('typing'), text: mark });
        await bench.waitFor(async () => typing.some(text => text.includes(mark)), `typed ${mark} to be readable`);
        delays.push(performance.now() - sent);
        await bench.client.call('pane.send_keys', { pane_id: bench.pane('typing'), keys: ['ctrl+u'] });
        await new Promise(resolve => setTimeout(resolve, 60));
      }
    } finally { stopTyping(); }
    delays.sort((a, b) => a - b);
    const at = (q: number) => Math.round(delays[Math.min(delays.length - 1, Math.floor(q * delays.length))] ?? 0);
    t.diagnostic(`typed character -> readable in the mirror (ms, ${delays.length} samples): p50 ${at(0.5)}, p90 ${at(0.9)}, max ${at(1)}`);
  } finally {
    stop();
    mirror.stop();
    await bench.stop();
  }
});
