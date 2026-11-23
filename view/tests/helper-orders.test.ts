/**
 * The real helper (Claude Code with Haiku) on the bench, given the orders this view added: make
 * a project, add an existing folder only after the owner's yes, and show a page in a project.
 * It spends the owner's model quota, so it runs only when asked:
 *   VIEW_HELPER_TESTS=1 node --test build/view/tests/helper-orders.test.js
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { HerdrBench } from '../bench/bench.js';
import { claudeHelper, claudeProjectAgent, HerdrLevelAgents, OVERVIEW } from '../bridge/agents.js';
import { Bridge, type Transcriber } from '../bridge/bridge.js';
import { compiled } from '../bridge/config.js';
import { DEFAULT_MIRROR, Mirror } from '../bridge/mirror.js';
import { Mirrors } from '../bridge/mirrors.js';
import { HelperWindows } from '../bridge/windows.js';
import { plain } from '../shared/ansi.js';

class Heard implements Transcriber {
  readonly queue: string[] = [];
  state() { return { ready: true as const }; }
  async transcribe(): Promise<string> { return this.queue.shift() ?? ''; }
}

test('the real helper makes a project, adds a folder only after the owner\'s yes, and mirrors a page into a project', { skip: process.env.VIEW_HELPER_TESTS !== '1' && 'spends model quota; set VIEW_HELPER_TESTS=1', timeout: 900_000 }, async () => {
  const bench = await HerdrBench.start([{ label: 'docs', panes: [{ name: 'd1', kind: 'shell' }] }]);
  const data = mkdtempSync('/tmp/svh-');
  const roots = ['home', 'd'].map(x => join(data, x));
  for (const r of roots) mkdirSync(r);
  mkdirSync(join(roots[1] as string, 'shop'));
  execFileSync('git', ['init', '-q'], { cwd: join(roots[1] as string, 'shop') });
  process.env.SPATIAL_WINDOW_HELPER = `node ${compiled('bench', 'fake-windows.js')}`;
  const env = { HOME: homedir(), SPATIAL_PROJECT_ROOTS: roots.join(':'), SPATIAL_NEW_PROJECT_ROOT: roots[0] as string, SPATIAL_VIEW_MIRROR_SOCKET: join(data, 'mirror.sock') };
  const agents = new HerdrLevelAgents(bench.client, {
    helper: { ...claudeHelper('/tmp/spatial-view-test-agents/helper'), env },
    project: { ...claudeProjectAgent('/tmp/spatial-view-test-agents/project-agent'), env },
  }, join(data, 'helper.sock'));
  const mirror = new Mirror(bench.client, DEFAULT_MIRROR);
  const speech = new Heard();
  const mirrors = new Mirrors(bench.client, new HelperWindows(), join(data, 'mirror.sock'));
  const bridge = new Bridge(bench.client, mirror, speech, agents, { mirrors });
  mirrors.serve(o => bridge.mirrorOrder(o));
  mirror.start();
  let n = 0;
  const helperPane = async () => (await agents.seat(OVERVIEW)).paneId;
  const order = async (words: string) => { speech.queue.push(`helper, ${words}`); return await bridge.utterance(`h${++n}`, new Float32Array(10), null); };
  const text = async () => plain(await bench.client.read(await helperPane(), 200));
  /** Waits until the helper has taken the order (its window changed) and has finished with it. */
  const answered = async (before: string) => {
    const id = await helperPane();
    await bench.waitFor(async () => (await text()) !== before, 'the helper to take the order', 120_000);
    await new Promise(resolve => setTimeout(resolve, 2000));
    await bench.waitFor(async () => ['idle', 'done'].includes((await bench.client.snapshot()).panes.find(p => p.id === id)?.status ?? ''), 'the helper to finish', 240_000);
  };
  const orderAndWait = async (words: string) => {
    const before = await text();
    const u = await order(words);
    assert.equal(u.ok, true, u.outcome);
    await answered(before);
  };
  const workspace = async (label: string) => (await bench.client.snapshot()).workspaces.find(w => w.label.toLowerCase() === label);
  try {
    await bridge.act({ kind: 'overview' });
    await agents.ready(await helperPane());
    // Claude Code takes a prompt once its input line is drawn.
    await bench.waitFor(async () => (await text()).includes('❯'), 'the helper\'s input line', 60_000);
    await new Promise(resolve => setTimeout(resolve, 3000));

    await orderAndWait('add the folder shop as a project');
    const asked = await text();
    assert.ok(asked.replace(/\s+/g, '').includes(join(roots[1] as string, 'shop')), `the helper names the folder it found:\n${asked.slice(-1500)}`);
    assert.equal(await workspace('shop'), undefined, 'nothing is added before the owner\'s yes');
    await orderAndWait('yes, add it');
    await bench.waitFor(async () => (await workspace('shop')) !== undefined, 'the project to be added', 60_000);

    await orderAndWait('new project garden tools');
    assert.ok(existsSync(join(roots[0] as string, 'garden-tools', '.git')), 'the folder is made with git');

    const docs = (await workspace('docs'))?.id as string;
    await orderAndWait('show me localhost 3000 in docs');
    await mirror.tick();
    assert.ok(mirror.shelf().sessions.some(s => s.window && s.workspaceId === docs), 'a mirror session in docs');
  } finally {
    bridge.stop(); mirrors.close(); mirror.stop(); await bench.stop(); rmSync(data, { recursive: true, force: true });
  }
});
