/**
 * Deliverable 6: After /model or /effort, the owner's defaults for new Claude sessions are unchanged.
 *
 * AC-6.1: After /model <name> the settings file's "model" field is restored to its value before
 *   the command.
 * AC-6.2: After /effort <level> the settings file's "modelSettings" is restored to its value
 *   before the command.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { setup } from './desk.js';
import type { BenchWorkspace } from '../bench/bench.js';

const LAYOUT: BenchWorkspace[] = [
  { label: 'alpha', panes: [{ name: 'a1', kind: 'agent' }] },
];

const front = (s: Awaited<ReturnType<typeof setup>>, name: string) => s.bench.client.call('pane.focus', { pane_id: s.bench.pane(name) });
const focusedIs = (s: Awaited<ReturnType<typeof setup>>, name: string) => s.bench.waitFor(async () => s.mirror.shelf().focusedId === s.bench.pane(name), `${name} in front`);
const shows = (s: Awaited<ReturnType<typeof setup>>, name: string, words: string) => s.bench.waitFor(async () => (await s.text(s.bench.pane(name))).includes(words), `"${words}" in ${name}`, 15_000);

test('AC-6.1: after /model, the settings file model field is restored to its original value', async () => {
  // The bridge's claudeSettingsPath points to a pre-written settings file.
  const dir = mkdtempSync('/tmp/svl-defaults-');
  try {
    const settingsPath = join(dir, 'settings.json');
    const original = { model: 'claude-opus-4-5', otherKey: 'kept' };
    writeFileSync(settingsPath, `${JSON.stringify(original, null, 2)}\n`, 'utf8');

    const s = await setup(LAYOUT, { claudeSettingsPath: settingsPath, confirmMs: 2000 });
    try {
      await front(s, 'a1'); await focusedIs(s, 'a1');
      await s.say('model sonnet');
      await shows(s, 'a1', 'a1 got: /model sonnet');
      // After the command, the settings file should still have the original model.
      const after = JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, unknown>;
      assert.equal(after.model, 'claude-opus-4-5', 'original model restored');
      assert.equal(after.otherKey, 'kept', 'other keys preserved');
    } finally { await s.stop(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('AC-6.2: after /effort, the settings file modelSettings is restored to its original value', async () => {
  const dir = mkdtempSync('/tmp/svl-defaults-');
  try {
    const settingsPath = join(dir, 'settings.json');
    const original = {
      model: 'claude-opus-4-5',
      modelSettings: { 'claude-opus-4-5': { effortLevel: 'high' } },
    };
    writeFileSync(settingsPath, `${JSON.stringify(original, null, 2)}\n`, 'utf8');

    const s = await setup(LAYOUT, { claudeSettingsPath: settingsPath, confirmMs: 2000 });
    try {
      await front(s, 'a1'); await focusedIs(s, 'a1');
      await s.say('effort low');
      await shows(s, 'a1', 'a1 got: /effort low');
      // After the command, the settings file should have the original modelSettings.
      const after = JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, unknown>;
      const ms = after.modelSettings as Record<string, Record<string, unknown>> | undefined;
      assert.deepEqual(ms?.['claude-opus-4-5']?.effortLevel, 'high', 'original effort restored');
    } finally { await s.stop(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
