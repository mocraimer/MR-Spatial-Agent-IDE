/** How the level agents are started: on Sonnet at medium effort, also when Herdr resumes them with no arguments. */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { claudeAgents, LEVEL_EFFORT, LEVEL_MODEL } from '../bridge/agents.js';
import { compiled } from '../bridge/config.js';

const GUARD = compiled('bridge', 'guard.js');
const LEVEL_TOOL = compiled('bridge', 'level-tool.js');

test('both kinds of level agent start on Sonnet at medium effort, by argument and in their own folder settings', () => {
  const data = mkdtempSync('/tmp/svl-agents-');
  try {
    const { helper, project } = claudeAgents(data);
    for (const [agent, folder] of [[helper, 'helper'], [project, 'project-agent']] as const) {
      const at = (flag: string) => agent.args[agent.args.indexOf(flag) + 1];
      assert.equal(at('--model'), 'sonnet', `${folder} model argument`);
      assert.equal(at('--effort'), 'medium', `${folder} effort argument`);
      agent.prepare?.();
      const settings = JSON.parse(readFileSync(join(data, folder, '.claude', 'settings.json'), 'utf8')) as Record<string, unknown>;
      // A resumed agent runs with no arguments: the folder alone must say it.
      assert.equal(settings.model, 'sonnet');
      assert.equal(settings.effortLevel, 'medium');
    }
    assert.deepEqual([LEVEL_MODEL, LEVEL_EFFORT], ['sonnet', 'medium']);
  } finally { rmSync(data, { recursive: true, force: true }); }
});

test('what the level agents may do is unchanged: the guard on every tool call, the helper unprompted, the project agent reading and its one tool', () => {
  const data = mkdtempSync('/tmp/svl-agents-');
  try {
    const { helper, project } = claudeAgents(data);
    helper.prepare?.(); project.prepare?.();
    const read = (folder: string) => JSON.parse(readFileSync(join(data, folder, '.claude', 'settings.json'), 'utf8')) as Record<string, unknown>;
    const guard = { PreToolUse: [{ matcher: '.*', hooks: [{ type: 'command', command: `node ${GUARD}` }] }] };
    assert.deepEqual(read('helper'), { model: 'sonnet', effortLevel: 'medium', permissions: { defaultMode: 'bypassPermissions' }, skipDangerousModePermissionPrompt: true, hooks: guard });
    assert.deepEqual(read('project-agent'), { model: 'sonnet', effortLevel: 'medium', permissions: { allow: ['Read', 'Glob', 'Grep', `Bash(node ${LEVEL_TOOL}:*)`], defaultMode: 'default' }, skipDangerousModePermissionPrompt: true, hooks: guard });
    assert.deepEqual(helper.args.filter(a => ['--permission-mode', 'bypassPermissions', '--strict-mcp-config'].includes(a)), ['--permission-mode', 'bypassPermissions', '--strict-mcp-config']);
    assert.equal(project.args.includes('--permission-mode'), false, 'the project agent does not run unprompted');
  } finally { rmSync(data, { recursive: true, force: true }); }
});
