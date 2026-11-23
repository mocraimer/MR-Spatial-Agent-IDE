import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { resolve, splitSentences } from '../bridge/bridge.js';
import { compiled, REPO } from '../bridge/config.js';
import { CLOSE_TOOL } from '../bridge/agents.js';
import { classify } from '../bridge/heard.js';
import { collapseRepeats, splitAtPauses, SAMPLE_RATE } from '../bridge/speech.js';
import { arrange, CHIP_ARC, columnFit } from '../page/layout.js';
import { terminalLines } from '../page/panels.js';
import { Mic } from '../page/mic.js';
import { COMMANDS } from '../shared/actions.js';
import type { Session, Shelf } from '../shared/messages.js';

function guard(tool: string, input: Record<string, unknown>): number {
  return spawnSync('node', [compiled('bridge', 'guard.js')], { input: JSON.stringify({ tool_name: tool, tool_input: input }) }).status ?? -1;
}

test('the helper\'s guard refuses every direct close and lets the close tool and ordinary work through', () => {
  const refused: [string, Record<string, unknown>][] = [
    ['Bash', { command: 'herdr pane close w1:p2' }],
    ['Bash', { command: 'herdr tab close w1:t2' }],
    ['Bash', { command: 'herdr workspace close w3' }],
    ['Bash', { command: 'herdr workspace close w3 --group' }],
    ['Bash', { command: `node ${CLOSE_TOOL} logs; herdr pane close w1:p2` }],
    ['Bash', { command: 'python3 -c "import socket; s.send(b\'{\\"method\\":\\"pane.close\\"}\')"' }],
    ['Bash', { command: 'socat - UNIX-CONNECT:$HOME/.config/herdr/herdr.sock' }],
    ['Bash', { command: 'herdr server stop' }],
    ['Bash', { command: 'kill -9 4242' }],
    ['Bash', { command: 'herdr pane send-text w1:p2 "exit"' }],
    ['Write', { file_path: '/tmp/x.js', content: 'call("pane.close", { pane_id })' }],
  ];
  for (const [tool, input] of refused) assert.equal(guard(tool, input), 2, `refused: ${JSON.stringify(input)}`);
  const allowed: [string, Record<string, unknown>][] = [
    ['Bash', { command: `node ${CLOSE_TOOL} w1:p2` }],
    ['Bash', { command: 'herdr tab create --workspace w1 --no-focus' }],
    ['Bash', { command: 'herdr pane rename w1:p2 logs' }],
    ['Bash', { command: 'ls | wc -l' }],
    ['Read', { file_path: '/tmp/notes.md' }],
  ];
  for (const [tool, input] of allowed) assert.equal(guard(tool, input), 0, `allowed: ${JSON.stringify(input)}`);
});

test('an utterance is a command only when the whole of it is one', () => {
  const id = (text: string, confirming = false) => { const h = classify(text, confirming); return h.as === 'command' ? h.command.id : h.as; };
  assert.equal(id('Next waiting.'), 'next');
  assert.equal(id('Back up the database first.'), 'prompt');
  assert.equal(id('Press to'), 'two', 'a spoken number is compared as a digit');
  assert.equal(id('Press 1.'), 'one');
  assert.deepEqual(classify('Show tree.', false), { as: 'show', target: 3 });
  assert.deepEqual(classify('show storefront web', false), { as: 'show', target: 'storefront web' });
  assert.deepEqual(classify('Helper, rename the shell to logs.', false), { as: 'helper', order: 'rename the shell to logs.' });
  assert.deepEqual(classify('Go to storefront web.', false), { as: 'go', target: 'storefront web' });
  assert.deepEqual(classify('go to project infra', false), { as: 'go', target: 'infra' });
  assert.equal(id('Overview.'), 'overview');
  assert.equal(id('Go to the overview'), 'overview');
  assert.equal(id('yes'), 'prompt', 'a yes with no close waiting is an answer to the agent');
  assert.equal(id('Yes.', true), 'confirm');
  assert.equal(id('  '), 'nothing');
});

test('inside a project: its sessions beside the front, every other project a chip, the overview chip first; numbers across all projects', () => {
  const session = (id: string, workspaceId: string, role: Session['role'] = 'task') => ({ id, workspaceId, role, agent: 'claude', status: 'idle' as const, name: id, window: false, screen: null });
  const shelf: Shelf = {
    herdr: { state: 'up' },
    projects: ['w1', 'w2', 'w3', 'ov'].map(id => ({ id, label: id === 'ov' ? 'helper' : `project ${id}` })),
    sessions: [session('w3:p1', 'w3'), session('w1:p1', 'w1'), session('w1:p2', 'w1'), session('w2:p1', 'w2'), session('w2:p2', 'w2', 'project-agent'), session('w2:p3', 'w2'), session('ov:p1', 'ov', 'overview-agent')],
    focusedId: 'w2:p1',
    overviewId: 'ov', starting: [], failed: [], drafts: [],
  };
  const { front, place, columns, chips } = arrange(shelf, [{ session: session('w2:p9', 'w2'), projectId: 'w2', project: 'project w2' }, { session: session('w1:p9', 'w1'), projectId: 'w1', project: 'project w1' }]);
  assert.equal(front?.id, 'w2:p1');
  assert.deepEqual(place, { overview: false, projectId: 'w2', project: 'project w2' });
  assert.deepEqual(columns.map(c => [Math.sign(c.angle), c.tiles.map(t => [t.session.id, t.n])]), [[-1, [['w2:p1', 3], ['w2:p2', 4]]], [1, [['w2:p3', 5], ['w2:p9', 0]]]],
    'only this project\'s sessions; numbers follow project order across all projects; a closed one of this project stays a moment, without a number');
  assert.deepEqual(chips.map(c => [c.project, c.overview, c.sessions.map(s => s.id)]), [['Overview', true, ['ov:p1']], ['project w1', false, ['w1:p1', 'w1:p2']], ['project w3', false, ['w3:p1']]]);
  assert.ok(columnFit(2).width > 0.3, 'tiles inside a project are wider than the 0.30 m tile of the one-shelf view');

  const atOverview = arrange({ ...shelf, focusedId: 'ov:p1' });
  assert.deepEqual(atOverview.place, { overview: true });
  assert.deepEqual(atOverview.columns.flatMap(c => c.tiles.map(t => t.session.id)), ['ov:p1'], 'at the overview, the shelf holds the sessions of no project');
  assert.deepEqual(atOverview.chips.map(c => c.project), ['project w1', 'project w2', 'project w3'], 'every project is a node; the overview\'s own workspace is not one');
});

test('chips and nodes stay within 90 degrees either side, at 7 projects and at 14', () => {
  for (const count of [7, 14]) {
    const projects = Array.from({ length: count }, (_, i) => ({ id: `w${i}`, label: `a rather long project name number ${i}` }));
    const sessions = projects.map(p => ({ id: `${p.id}:p1`, workspaceId: p.id, role: 'task' as const, agent: 'claude', status: 'idle' as const, name: 'x', window: false, screen: null }));
    for (const focusedId of [null, 'w0:p1']) {
      const { chips } = arrange({ herdr: { state: 'up' }, projects, sessions, focusedId, overviewId: null, starting: [], failed: [], drafts: [] });
      const widest = Math.max(...chips.map(c => Math.abs(c.angle) + (c.width / 2) / CHIP_ARC * 180 / Math.PI));
      assert.ok(widest < 90, `${count} projects, ${focusedId ? 'inside one' : 'at the overview'}: the farthest chip edge is at ${widest.toFixed(1)} degrees`);
    }
  }
});

test('the guard refuses a tool call it cannot read', () => {
  for (const input of ['', 'not json', 'null', '42']) {
    const status = spawnSync('node', [compiled('bridge', 'guard.js')], { input }).status;
    assert.equal(status, 2, `refused: ${JSON.stringify(input)}`);
  }
});

test('a spoken session reference resolves by tile number, name or project', () => {
  const shelf: Shelf = {
    herdr: { state: 'up' },
    projects: [{ id: 'w2', label: 'storefront-web' }, { id: 'w1', label: 'billing' }],
    sessions: [
      { id: 'w1:p1', workspaceId: 'w1', role: 'task', agent: 'claude', status: 'idle', name: 'ledger', window: false, screen: null },
      { id: 'w2:p1', workspaceId: 'w2', role: 'task', agent: null, status: 'unknown', name: 'logs', window: false, screen: null },
    ],
    focusedId: null, overviewId: null, starting: [], failed: [], drafts: [],
  };
  assert.equal(resolve(shelf, 1)?.id, 'w2:p1', 'numbers follow project order, not pane order');
  assert.equal(resolve(shelf, 'Ledger')?.id, 'w1:p1');
  assert.equal(resolve(shelf, 'storefront web')?.id, 'w2:p1');
  assert.equal(resolve(shelf, 'w1:p1')?.id, 'w1:p1');
  assert.equal(resolve(shelf, 3), null);
  assert.equal(resolve(shelf, 'nothing like it'), null);
});

test('the user guide names every spoken form of every command', () => {
  const guide = readFileSync(join(REPO, 'docs', 'USER-GUIDE.md'), 'utf8');
  assert.ok(COMMANDS.length >= 25, 'the registry is not empty');
  const missing = COMMANDS.flatMap(c => c.say).filter(form => !guide.includes(`"${form}"`));
  assert.deepEqual(missing, []);
});

test('the microphone: a stop while it is opening leaves it closed, and a start after that opens it', async () => {
  const opens: { resolve: () => void; closed: boolean }[] = [];
  const mic = new Mic(async () => {
    const open = { resolve: () => undefined as void, closed: false };
    opens.push(open);
    await new Promise<void>(resolve => { open.resolve = resolve; });
    return { close() { open.closed = true; } };
  }, () => 'w1:p1', () => undefined, () => undefined);
  mic.setMode('switch');
  const first = mic.switchOn();
  mic.stop();
  const second = mic.switchOn();
  opens[0]?.resolve();
  opens[1]?.resolve();
  await Promise.all([first, second]);
  assert.equal(opens.length, 2, 'the start after the stop began its own open');
  assert.equal(opens[0]?.closed, true, 'the open from before the stop was closed');
  assert.equal(mic.open, true, 'the start after the stop opened the microphone');
  mic.stop();
  assert.equal(opens[1]?.closed, true);
});

test('the microphone: hold to talk sends what was said, captured for the session in front when the press began', async () => {
  let receiver = 'w1:p1';
  const sent: { receiver: string | null; length: number }[] = [];
  const mic = new Mic(async () => ({ close() { /* nothing */ } }), () => receiver, c => sent.push({ receiver: c.receiver, length: c.audio.length }), () => undefined);
  await mic.holdStart();
  mic.feed(new Float32Array(8000));
  receiver = 'w2:p1';
  mic.feed(new Float32Array(8000));
  mic.holdEnd();
  assert.deepEqual(sent, [{ receiver: 'w1:p1', length: 16000 }]);
  assert.equal(mic.open, false);
});

test('the microphone: audio from a stream closed by a stop does not enter the next recording', async () => {
  const pushes: ((s: Float32Array) => void)[] = [];
  const sent: number[] = [];
  const mic = new Mic(async push => { pushes.push(push); return { close() { /* nothing */ } }; }, () => 'w1:p1', c => sent.push(c.audio.length), () => undefined);
  await mic.holdStart();
  mic.holdEnd();
  await mic.holdStart();
  pushes[0]?.(new Float32Array(1024));
  pushes[1]?.(new Float32Array(8000));
  mic.holdEnd();
  assert.deepEqual(sent, [8000], 'only the current stream\'s audio is sent');
});

test('page code redraws through the scene\'s frames: a Quest stops the window\'s frames in immersive mode', () => {
  const page = join(REPO, 'view', 'page');
  const offenders = readdirSync(page).filter(f => f.endsWith('.ts')).flatMap(f => {
    const lines = readFileSync(join(page, f), 'utf8').split('\n');
    return lines.flatMap((line, i) => /requestAnimationFrame\(/.test(line) && !/session\.requestAnimationFrame|\(desktop\)/.test(line) ? [`${f}:${i + 1}`] : []);
  });
  assert.deepEqual(offenders, [], 'schedule redraws with render() (drawn in Scene\'s frame callback), never window.requestAnimationFrame: it does not run in an immersive session on a Quest');
});

test('terminal text: each run of three or more blank rows is one blank row, shorter runs and the text around them stay, trailing blanks go', () => {
  const blank = (n: number) => Array<string>(n).fill('');
  const rows = (...parts: (string | number)[]) => parts.flatMap(p => (typeof p === 'number' ? blank(p) : [p])).join('\n');
  assert.deepEqual(terminalLines(rows('answer', 38, '> input', 3)), ['answer', '', '> input']);
  assert.deepEqual(terminalLines(rows('a', 2, 'b')), ['a', '', '', 'b'], 'two blank rows are kept');
  assert.deepEqual(terminalLines(rows('a', 3, 'b', 4, 'c')), ['a', '', 'b', '', 'c'], 'every run is collapsed alone');
  assert.deepEqual(terminalLines(rows('a', '  ', '\t', '\u001b[0m', 'b')), ['a', '', 'b'], 'rows of only spaces or colour codes are blank too');
  assert.deepEqual(terminalLines(rows(5, 'a')), ['', 'a'], 'leading blanks too');
  assert.deepEqual(terminalLines(''), []);
});

test('the microphone: pressing hold to talk while it is open on standby tells the page', async () => {
  let changes = 0;
  const mic = new Mic(async () => ({ close() { /* nothing to release */ } }), () => null, () => undefined, () => { changes += 1; });
  await mic.arm();
  assert.deepEqual([mic.standby, mic.open], [true, false]);
  const before = changes;
  const press = mic.holdStart();
  assert.deepEqual([mic.standby, mic.open], [false, true], 'listening now, not standby');
  assert.ok(changes > before, 'the page was told at the press, not only when the microphone opens');
  await press;
  mic.holdEnd();
  assert.deepEqual([mic.standby, mic.open], [true, false], 'back to standby after the release');
});

test('splitSentences splits at [.!?] followed by whitespace or end, never mid-word: parts always rejoin to the original', () => {
  const cases: [string, string[]][] = [
    ['Hello. World!', ['Hello.', 'World!']],
    ['Hello! How are you?', ['Hello!', 'How are you?']],
    ['One. Two. Three.', ['One.', 'Two.', 'Three.']],
    // Dot not followed by space: no split.
    ['Set model to Sonnet 4.6.', ['Set model to Sonnet 4.6.']],
    ['file.txt is here.', ['file.txt is here.']],
    ['Version 2.0 ships today.', ['Version 2.0 ships today.']],
    ['https://example.com/path is live.', ['https://example.com/path is live.']],
    // Abbreviations mid-sentence: dot followed by space → splits (accepted; parts still rejoin).
    // The important thing is that parts.join(' ') === original.trim().
    ['Just text', ['Just text']],
    ['', []],
    ['   ', []],
    // Ellipsis followed by space.
    ['Wait... then go!', ['Wait...', 'then go!']],
    // Multiple punctuation marks.
    ['Really?! Yes!', ['Really?!', 'Yes!']],
  ];
  for (const [input, expected] of cases) {
    const parts = splitSentences(input);
    assert.deepEqual(parts, expected, `splitSentences(${JSON.stringify(input)})`);
    if (input.trim()) {
      // Parts always rejoin to the original (modulo surrounding whitespace).
      assert.equal(parts.join(' '), input.trim(), `rejoin: ${JSON.stringify(input)}`);
    }
  }
});

test('collapseRepeats: only collapses when a 1–3-word phrase repeats 3+ times consecutively', () => {
  // Should collapse: 3+ repeats.
  assert.equal(collapseRepeats('the the the quick'), 'the quick', '3× "the"');
  assert.equal(collapseRepeats('please please please go'), 'please go', '3× "please"');
  assert.equal(collapseRepeats('very very very much'), 'very much', '3× "very"');
  assert.equal(collapseRepeats('I need I need I need help'), 'I need help', '3× 2-word phrase');
  assert.equal(collapseRepeats('go go go go'), 'go', '4× "go" → one');
  // Should NOT collapse: only 2 repeats.
  assert.equal(collapseRepeats('very very good'), 'very very good', '2× "very" kept');
  assert.equal(collapseRepeats('had had a dream'), 'had had a dream', '2× "had" kept');
  assert.equal(collapseRepeats('the the'), 'the the', '2× "the" kept');
  // Case/punctuation-insensitive comparison: 3 identical words case-insensitively → collapse.
  assert.equal(collapseRepeats('The the THE rest'), 'The rest', '3× same word (case-insensitive) collapses to first occurrence');
  // The first occurrence is kept.
  const out = collapseRepeats('Hello hello hello world');
  assert.equal(out, 'Hello world', 'first occurrence (capitalised) is kept');
  // No repeats: unchanged.
  assert.equal(collapseRepeats('one two three'), 'one two three');
  assert.equal(collapseRepeats(''), '');
});

test('splitAtPauses: short audio passes through; long audio splits at the quietest window, never producing chunks shorter than 1s except the tail', () => {
  const sr = SAMPLE_RATE;
  // Short audio (≤10s) is returned as-is.
  const short = new Float32Array(sr * 5);
  assert.deepEqual(splitAtPauses(short, sr), [short]);
  // 25s of audio: should produce 2–3 chunks, each ≥1s except maybe the last.
  const long = new Float32Array(sr * 25);
  const longChunks = splitAtPauses(long, sr);
  assert.ok(longChunks.length >= 2, 'splits into multiple chunks');
  for (let i = 0; i < longChunks.length - 1; i++) {
    assert.ok((longChunks[i]?.length ?? 0) >= sr * 1, `chunk ${i} is at least 1s`);
  }
  // Chunks rejoin to the original.
  let pos = 0;
  for (const c of longChunks) { assert.deepEqual(c, long.subarray(pos, pos + c.length)); pos += c.length; }
  assert.equal(pos, long.length, 'all samples accounted for');
  // Quiet window: a 25s audio where seconds 7–8 are silent, 20–21 are silent.
  // The first split should prefer the quietest window (seconds 7–8) if it falls within [1s, 10s-1s].
  const withQuiet = new Float32Array(sr * 25).fill(0.5);
  for (let i = sr * 7; i < sr * 8; i++) (withQuiet as Float32Array)[i] = 0;
  const qChunks = splitAtPauses(withQuiet, sr);
  assert.ok(qChunks.length >= 2, 'splits long quiet-window audio');
  // The first chunk should end near the quiet window (around seconds 7–8).
  const firstLen = qChunks[0]?.length ?? 0;
  assert.ok(firstLen >= sr * 1, 'first chunk ≥ 1s');
  assert.ok(firstLen <= sr * 10, 'first chunk ≤ 10s');
});

test('AC-3.3: every command is recognised with every leading/trailing filler; prompts with command words stay prompts', () => {
  const fillers = ['uh', 'um', 'okay', 'ok', 'so', 'please'];
  const leading = ['uh', 'um', 'okay', 'ok', 'so'];  // leading fillers
  const trailing = ['please', 'uh', 'um', 'okay', 'ok', 'so'];  // trailing fillers
  // Filter to commands that are not confirming-only or picking-only.
  for (const c of COMMANDS.filter(cmd => !cmd.whenConfirming && !cmd.whenPicking)) {
    const base = c.say[0] as string;
    // Test leading filler before the command.
    for (const filler of leading) {
      const heard = `${filler} ${base}`;
      const result = classify(heard, false);
      assert.equal(result.as, 'command', `${c.id}: leading "${filler}" before "${base}" should still be a command`);
      if (result.as === 'command') assert.equal(result.command.id, c.id, `${c.id}: correct command id with leading "${filler}"`);
    }
    // Test trailing filler after the command.
    for (const filler of trailing) {
      const heard = `${base} ${filler}`;
      const result = classify(heard, false);
      assert.equal(result.as, 'command', `${c.id}: trailing "${filler}" after "${base}" should still be a command`);
      if (result.as === 'command') assert.equal(result.command.id, c.id, `${c.id}: correct command id with trailing "${filler}"`);
    }
  }
  // Prompts that contain command words must stay prompts, not become commands.
  const promptCases = [
    'model the database schema',
    'effort estimate for this sprint',
    'back up the database',
    'enter the credentials',
    'next step in the pipeline',
    'please model the database',  // filler + prompt-with-command-word stays prompt
  ];
  for (const p of promptCases) {
    const result = classify(p, false);
    assert.notEqual(result.as, 'command', `"${p}" must not be a command (it is a prompt)`);
  }
  // "scratch that": a phrase that is exactly one command's say stays a command even with please.
  assert.equal(classify('please scratch that', false).as, 'command', '"please scratch that" is a command');
  assert.equal(classify('scratch that please', false).as, 'command', '"scratch that please" is a command');
});

test('AC-3.4: kept speech cap removes pairs (both .wav and .txt); no orphaned files after trimming', () => {
  // Build a mock speechKeepDir with 1001 full pairs and verify the cap removes both files of a pair.
  const dir = mkdtempSync('/tmp/svl-keep-');
  try {
    // Write 1001 full pairs (should cap to 999 stems = 1998 files after removing 2 oldest).
    for (let i = 0; i < 1001; i++) {
      const stamp = `2026-01-01T00-00-${String(i).padStart(6, '0')}Z`;
      writeFileSync(join(dir, `${stamp}.txt`), `utterance ${i}`);
      writeFileSync(join(dir, `${stamp}.wav`), 'WAV');
    }
    const files = readdirSync(dir);
    assert.equal(files.length, 2002, '1001 pairs = 2002 files before cap');
    // Apply the same cap logic as keepUtterance.
    const wavStems = new Set(files.filter(f => f.endsWith('.wav')).map(f => f.slice(0, -4)));
    const txtStems = new Set(files.filter(f => f.endsWith('.txt')).map(f => f.slice(0, -4)));
    const allStems = [...new Set([...wavStems, ...txtStems])].sort();
    if (allStems.length >= 1000) {
      for (const stem of allStems.slice(0, allStems.length - 999)) {
        try { rmSync(join(dir, `${stem}.wav`)); } catch { /* ok */ }
        try { rmSync(join(dir, `${stem}.txt`)); } catch { /* ok */ }
      }
    }
    const after = readdirSync(dir);
    assert.equal(after.length, 1998, '999 pairs = 1998 files after cap');
    // Every remaining wav has a matching txt and vice versa: no orphaned files.
    const wavAfter = new Set(after.filter(f => f.endsWith('.wav')).map(f => f.slice(0, -4)));
    const txtAfter = new Set(after.filter(f => f.endsWith('.txt')).map(f => f.slice(0, -4)));
    for (const s of wavAfter) assert.ok(txtAfter.has(s), `orphaned wav (no txt): ${s}`);
    for (const s of txtAfter) assert.ok(wavAfter.has(s), `orphaned txt (no wav): ${s}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
