/**
 * Deliverable 6: After /model or /effort, the owner's defaults for new Claude sessions are unchanged.
 *
 * AC-6.1: After /model <name> the settings file's "model" field is restored to its value before
 *   the command.
 * AC-6.2: After /effort <level> the settings file's "modelSettings" is restored to its value
 *   before the command.
 * A.3: Indent style (2-space, 4-space, tab) and final-newline presence are preserved; unrelated
 *   keys are byte-identical after restore.
 * A.4: The bridge catches a delayed write (file written after the confirmation line prints).
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { saveDefaults, restoreDefaults } from '../bridge/claude-settings.js';
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

// A.3 ─────────────────────────────────────────────────────────────────────────────────────────────

test('A.3: 4-space indent is preserved; unrelated keys are byte-identical after restore', () => {
  const dir = mkdtempSync('/tmp/svl-defaults-');
  try {
    const settingsPath = join(dir, 'settings.json');
    const original = { model: 'claude-opus-4-5', extra: 'untouched', nested: { a: 1, b: 'two' } };
    // Write with 4-space indent and trailing newline.
    const rawBefore = `${JSON.stringify(original, null, 4)}\n`;
    writeFileSync(settingsPath, rawBefore, 'utf8');

    const token = saveDefaults(settingsPath);
    // Simulate /model writing the file (Claude Code uses 2-space, but we keep our style).
    writeFileSync(settingsPath, `${JSON.stringify({ ...original, model: 'claude-haiku-4-5' }, null, 4)}\n`, 'utf8');
    restoreDefaults(token);

    const rawAfter = readFileSync(settingsPath, 'utf8');
    // The restored file must match the original byte-for-byte.
    assert.equal(rawAfter, rawBefore, '4-space indent and content preserved byte-for-byte');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('A.3: tab indent is preserved after restore', () => {
  const dir = mkdtempSync('/tmp/svl-defaults-');
  try {
    const settingsPath = join(dir, 'settings.json');
    const original = { model: 'claude-opus-4-5', extra: 'untouched' };
    const rawBefore = `${JSON.stringify(original, null, '\t')}\n`;
    writeFileSync(settingsPath, rawBefore, 'utf8');

    const token = saveDefaults(settingsPath);
    writeFileSync(settingsPath, `${JSON.stringify({ ...original, model: 'claude-haiku-4-5' }, null, '\t')}\n`, 'utf8');
    restoreDefaults(token);

    const rawAfter = readFileSync(settingsPath, 'utf8');
    assert.equal(rawAfter, rawBefore, 'tab indent preserved byte-for-byte');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('A.3: file without final newline is preserved after restore', () => {
  const dir = mkdtempSync('/tmp/svl-defaults-');
  try {
    const settingsPath = join(dir, 'settings.json');
    const original = { model: 'claude-opus-4-5', extra: 'untouched' };
    // No trailing newline.
    const rawBefore = JSON.stringify(original, null, 2);
    assert.ok(!rawBefore.endsWith('\n'), 'precondition: no trailing newline');
    writeFileSync(settingsPath, rawBefore, 'utf8');

    const token = saveDefaults(settingsPath);
    writeFileSync(settingsPath, JSON.stringify({ ...original, model: 'claude-haiku-4-5' }, null, 2), 'utf8');
    restoreDefaults(token);

    const rawAfter = readFileSync(settingsPath, 'utf8');
    assert.ok(!rawAfter.endsWith('\n'), 'no trailing newline after restore');
    assert.equal(rawAfter, rawBefore, 'content preserved byte-for-byte');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// A.4 ─────────────────────────────────────────────────────────────────────────────────────────────

test('A.4: bridge restores defaults when settings file is written before the confirmation line', async () => {
  // Default standin behaviour: settings written synchronously (before confirmation print).
  const dir = mkdtempSync('/tmp/svl-defaults-');
  try {
    const settingsPath = join(dir, 'settings.json');
    writeFileSync(settingsPath, `${JSON.stringify({ model: 'claude-opus-4-5' }, null, 2)}\n`, 'utf8');

    const s = await setup(LAYOUT, { claudeSettingsPath: settingsPath, confirmMs: 2000 });
    try {
      await front(s, 'a1'); await focusedIs(s, 'a1');
      await s.say('model sonnet');
      await shows(s, 'a1', 'a1 got: /model sonnet');
      const after = JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, unknown>;
      assert.equal(after.model, 'claude-opus-4-5', 'model restored (write before confirmation)');
    } finally { await s.stop(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('A.4: restoreDefaults restores when called after a delayed write (unit)', async () => {
  // Simulate the race: saveDefaults saved the original, the file is NOT yet written by Claude Code
  // (restoreDefaults sees no change), then Claude Code writes the file, then restoreDefaults is
  // called again (by the bridge's watch loop) and restores the original.
  const dir = mkdtempSync('/tmp/svl-defaults-');
  try {
    const settingsPath = join(dir, 'settings.json');
    writeFileSync(settingsPath, `${JSON.stringify({ model: 'claude-opus-4-5' }, null, 2)}\n`, 'utf8');

    const token = saveDefaults(settingsPath);

    // First restore: file unchanged → no write.
    restoreDefaults(token);
    assert.equal(JSON.parse(readFileSync(settingsPath, 'utf8')).model, 'claude-opus-4-5', 'no-op when nothing changed');

    // Claude Code writes the file (delayed — after confirmation was printed).
    writeFileSync(settingsPath, `${JSON.stringify({ model: 'claude-sonnet-4-5' }, null, 2)}\n`, 'utf8');

    // Bridge watch loop calls restoreDefaults again → must restore the original.
    restoreDefaults(token);
    assert.equal(JSON.parse(readFileSync(settingsPath, 'utf8')).model, 'claude-opus-4-5', 'restored after delayed write');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('A.4: bridge restores defaults when settings file is written after the confirmation line', async () => {
  // The standin writes the file 500 ms after printing the confirmation line.
  // The bridge's post-confirmation watch loop must catch this.
  const dir = mkdtempSync('/tmp/svl-defaults-');
  const prevSettingsFile = process.env.SPATIAL_CLAUDE_SETTINGS_FILE;
  const prevDelay = process.env.SPATIAL_CLAUDE_SETTINGS_WRITE_DELAY_MS;
  try {
    const settingsPath = join(dir, 'settings.json');
    writeFileSync(settingsPath, `${JSON.stringify({ model: 'claude-opus-4-5' }, null, 2)}\n`, 'utf8');
    // The standin reads these env vars directly (they are set before the bench starts).
    process.env.SPATIAL_CLAUDE_SETTINGS_FILE = settingsPath;
    process.env.SPATIAL_CLAUDE_SETTINGS_WRITE_DELAY_MS = '500';

    const s = await setup(LAYOUT, { claudeSettingsPath: settingsPath, confirmMs: 2000 });
    try {
      await front(s, 'a1'); await focusedIs(s, 'a1');
      await s.say('model sonnet');
      await shows(s, 'a1', 'a1 got: /model sonnet');
      // Wait long enough for the delayed write (500 ms) and the bridge's watch loop (up to 4 s).
      await new Promise(r => setTimeout(r, 2500));
      const after = JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, unknown>;
      assert.equal(after.model, 'claude-opus-4-5', 'model restored (write after confirmation, delayed)');
    } finally { await s.stop(); }
  } finally {
    if (prevSettingsFile !== undefined) process.env.SPATIAL_CLAUDE_SETTINGS_FILE = prevSettingsFile;
    else delete process.env.SPATIAL_CLAUDE_SETTINGS_FILE;
    if (prevDelay !== undefined) process.env.SPATIAL_CLAUDE_SETTINGS_WRITE_DELAY_MS = prevDelay;
    else delete process.env.SPATIAL_CLAUDE_SETTINGS_WRITE_DELAY_MS;
    rmSync(dir, { recursive: true, force: true });
  }
});
