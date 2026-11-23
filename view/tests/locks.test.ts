/**
 * Structure the rest of the code leans on, held by reading the source: a change that breaks one
 * of these fails here, with the reason, before a test of behaviour has to notice.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { REPO } from '../bridge/config.js';

const bridgeDir = join(REPO, 'view', 'bridge');
const source = (name: string) => readFileSync(join(bridgeDir, name), 'utf8');

test('every file that starts a Herdr agent makes its name with agentName: Herdr refuses any other name', () => {
  // Herdr's rule for an agent name (lower case, letters, digits, "-", "_", at most 32) is held in
  // bridge/agent-name.ts; a name built any other way was refused for every project agent once.
  const starters = readdirSync(bridgeDir).filter(f => f.endsWith('.ts') && source(f).includes("'agent.start'"));
  assert.deepEqual(starters.sort(), ['agents.ts', 'level-tool.ts']);
  for (const file of starters) assert.match(source(file), /agentName\(/, `${file} makes the name it gives agent.start with agentName`);
});

/** Each call of a Herdr method in a source file, with the method of the class it sits in. */
function callsOf(file: string, methods: string[]): { method: string; in: string }[] {
  const found: { method: string; in: string }[] = [];
  let inside = '';
  for (const line of source(file).split('\n')) {
    const declared = /^ {2}(?:private |public )?(?:async )?(\w+)\(/.exec(line);
    if (declared) inside = declared[1] as string;
    for (const m of methods) if (line.includes(`'${m}'`)) found.push({ method: m, in: inside });
  }
  return found;
}

test('spoken words reach a session in one way each: typed by typeInto, or sent by prompt or order only while direct sending is on', () => {
  // The owner's rule: no spoken word is followed by Enter or a submit unless they said "go", or
  // direct sending is on. Any other call that writes to a session from the bridge breaks it.
  const calls = callsOf('bridge.ts', ['agent.prompt', 'pane.send_input', 'pane.send_text']);
  assert.deepEqual(calls.map(c => `${c.method} in ${c.in}`).sort(), [
    'agent.prompt in order',
    'agent.prompt in prompt',
    'pane.send_input in prompt',
    // The one other writer: the fixed command `/model <name>` or `/effort <level>`, never spoken words (asserted below).
    'pane.send_input in typeSetting',
    'pane.send_text in typeInto',
  ]);
  const bridge = source('bridge.ts');
  // order() and deliver() choose between typing and sending by the setting, and nothing else calls prompt().
  assert.match(bridge, /private async order\([^)]*\)[^{]*\{\s*if \(this\.settings\.direct\)/);
  assert.match(bridge, /if \(this\.settings\.direct\) \{\s*try \{ await this\.prompt\(/);
  assert.equal(bridge.split('this.prompt(').length - 1, 1, 'prompt() has the one caller that checks the setting');
  // typeSetting types text built from two registry-typed values, and its callers pass only those.
  assert.match(bridge, /private async typeSetting\([^)]*what: 'model' \| 'effort', value: ModelName \| EffortLevel\)/);
  assert.match(bridge, /const typed = `\/\$\{what\} \$\{value\}`;/);
  const callers = [...bridge.matchAll(/this\.typeSetting\(([^;]*)\)/g)].map(m => (m[1] as string).replace(/^shelf, [\w.]+, /, ''));
  assert.deepEqual(callers.sort(), ["'effort', action.level", "'effort', run.level", "'model', action.name", "'model', run.name"]);
});

test('text reaches the Windows voice as data only: the command line is fixed and the text goes on standard input', () => {
  // The text is an agent's reply or transcribed speech: never part of a command (see the tts tests).
  const tts = source('tts.ts');
  assert.equal(tts.split('spawn(').length - 1, 1, 'one place starts a process');
  assert.match(tts, /spawn\(this\.exe, \['-NoProfile', '-NonInteractive', '-Command', SCRIPT\]/);
  assert.match(tts, /child\.stdin\.end\(said, 'utf8'\)/);
  assert.doesNotMatch(tts.slice(tts.indexOf('const SCRIPT'), tts.indexOf('/** What the bridge needs')), /\$\{/, 'the script holds no interpolation');
});
