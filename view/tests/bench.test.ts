import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { plain } from '../shared/ansi.js';
import { HerdrBench, benchProcesses, subscribe } from '../bench/bench.js';

const LIVE_SOCKET = join(homedir(), '.config', 'herdr', 'herdr.sock');
const LONG_PROJECT = 'billing-reconciliation-service-with-a-very-long-project-name';

test('the bench runs a Herdr of its own: reads stand-ins, sees a status event, delivers a prompt, stops clean', async () => {
  const bench = await HerdrBench.start([
    { label: LONG_PROJECT, panes: [{ name: 'alpha', kind: 'agent' }, { name: 'tests', kind: 'shell' }] },
    { label: 'docs', panes: [{ name: 'beta', kind: 'agent' }] },
    { label: 'infra', panes: [{ name: 'gamma', kind: 'agent' }, { name: 'delta', kind: 'agent' }] },
  ]);
  const directory = bench.directory;
  try {
    assert.notEqual(bench.socketPath, LIVE_SOCKET);
    assert.ok(bench.socketPath.startsWith(`${directory}/`), 'socket lives in the bench directory');

    const snapshot = await bench.client.snapshot();
    assert.deepEqual(snapshot.workspaces.map(w => w.label), [LONG_PROJECT, 'docs', 'infra']);
    assert.equal(snapshot.panes.length, 5);
    assert.deepEqual(snapshot.panes.filter(p => p.agent !== null).length, 4, 'four stand-ins are agents, one pane is a shell');

    for (const name of ['alpha', 'beta', 'gamma', 'delta']) {
      assert.match(plain(await bench.client.read(bench.pane(name), 20)), new RegExp(`${name}.*\\(stand-in claude\\).* ready`));
    }

    const statuses: string[] = [];
    const close = subscribe(bench.socketPath, [{ type: 'pane.agent_status_changed', pane_id: bench.pane('beta') }], (_name, data) => {
      statuses.push(String(data.agent_status));
    });
    try {
      await new Promise(resolve => setTimeout(resolve, 200));
      await bench.type('beta', '/status blocked');
      await bench.waitFor(async () => statuses.includes('blocked'), 'a blocked status event from beta');
    } finally { close(); }

    await bench.client.call('agent.prompt', { target: bench.pane('gamma'), text: 'summarize the ledger change' });
    await bench.waitFor(async () => plain(await bench.client.read(bench.pane('gamma'), 40)).includes('received: summarize the ledger change'), 'gamma answering the prompt');
  } finally {
    await bench.stop();
  }
  assert.deepEqual(benchProcesses(directory), [], 'no bench process is left running');
  assert.equal(existsSync(directory), false, 'the bench directory is removed');
});
