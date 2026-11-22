import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { it } from 'node:test';

it('pure Python capture rules and PTY wrapper preserve bounds, deadlines and next-command service', () => {
  const result = spawnSync('python3', ['-B', 'environments/runtime_test.py'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /Ran 17 tests/);
});
