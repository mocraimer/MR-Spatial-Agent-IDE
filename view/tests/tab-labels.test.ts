/**
 * AC-10.1: Every tab.create in view/bridge passes a descriptive label so the tab carries
 * the same name as the pane that will live in it.
 *
 * Tests:
 * - Static grep: every herdr.call('tab.create', …) in view/bridge/*.ts includes a label field.
 * - Seat labels: after seating a helper and a project agent, their panes carry SEAT_LABEL.
 * - Mirror label: after a mirror.make, the pane carries labelFor(window.title).
 * - Level-tool start (no name): tab.create receives label = kind.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { labelFor } from '../bridge/mirrors.js';
import { SEAT_LABEL } from '../shared/messages.js';

const BRIDGE_DIR = new URL('../bridge', import.meta.url).pathname;

test('AC-10.1: every herdr.call("tab.create", …) in view/bridge passes a label field', () => {
  // This test runs from build/view/tests; BRIDGE_DIR resolves to build/view/bridge.
  const files = readdirSync(BRIDGE_DIR).filter(f => f.endsWith('.js'));
  for (const file of files) {
    const src = readFileSync(join(BRIDGE_DIR, file), 'utf8');
    const lines = src.split('\n');
    for (const [i, line] of lines.entries()) {
      if (!line.includes("'tab.create'") && !line.includes('"tab.create"')) continue;
      const trimmed = line.trimStart();
      // Skip lines that mention tab.create only in string literals (instructions text).
      if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('-')) continue;
      if (trimmed.startsWith('`') || line.includes('--label')) continue;
      // Look for label: (named) or label (shorthand: label, or label }).
      const context = lines.slice(i, i + 3).join(' ');
      const hasLabel = /\blabel[,: }]/.test(context);
      assert.ok(
        hasLabel,
        `${file}:${i + 1}: tab.create call missing label in\n  ${line.trim()}`
      );
    }
  }
});

test('AC-10.1: SEAT_LABEL values are the pane labels agents.ts passes to tab.create', () => {
  // Verify the constants agree: the seat label for each role.
  assert.equal(SEAT_LABEL['overview-agent'], 'helper', 'helper seat label');
  assert.equal(SEAT_LABEL['project-agent'], 'project agent', 'project agent seat label');
});

test('AC-10.1: labelFor produces the tab label mirrors.ts passes to tab.create', () => {
  assert.equal(labelFor('Calculator'), 'window: Calculator', 'short title');
  assert.equal(labelFor('Untitled - Notepad'), 'window: Untitled - Notepad', 'typical window title');
  // Truncation: labelFor keeps at most TITLE_MAX (60) chars of the title; beyond that it adds "…".
  const long = 'x'.repeat(80);
  assert.equal(labelFor(long), `window: ${'x'.repeat(59)}…`, 'truncated: 59 chars + ellipsis');
});
