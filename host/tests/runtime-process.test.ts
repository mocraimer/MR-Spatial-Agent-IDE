import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { RuntimeProcess } from '../src/runtime-process.js';

it('teardown escalates against the whole PGID after leader/stdio close; unproven absence stays uncertain', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'sgp-'));
  const marker = join(directory, 'must-not-run-after-stop');
  const childFile = join(directory, 'descendant.mjs'), leaderFile = join(directory, 'leader.mjs');
  writeFileSync(childFile, `import process from 'node:process';import {writeFileSync} from 'node:fs';process.on('SIGTERM',()=>{});setTimeout(()=>writeFileSync(${JSON.stringify(marker)},'escaped effect'),6500);setInterval(()=>{},1000);`);
  writeFileSync(leaderFile, `import process from 'node:process';import {spawn} from 'node:child_process';const child=spawn(process.execPath,[${JSON.stringify(childFile)}],{stdio:'ignore'});child.unref();process.stdout.write(JSON.stringify({type:'descendant',pid:child.pid})+'\\n');setTimeout(()=>process.exit(0),150);`);
  const runtime = new RuntimeProcess(process.execPath, [leaderFile], directory, { PATH: process.env.PATH });
  try {
    const descendant = await runtime.waitFor(record => record.type === 'descendant', 3000);
    await new Promise(resolve => setTimeout(resolve, 350));
    assert.equal(runtime.liveLeader, false);
    let uncertain = false;
    try { await runtime.close(); }
    catch (error) { uncertain = true; assert.match(String(error), /group.*uncertain/); }
    assert.equal(existsSync(marker), false, 'TERM/KILL escalation must continue after leader exit');
    if (!uncertain) assert.throws(() => process.kill(-runtime.processId!, 0), { code: 'ESRCH' });
    // Some hosts retain orphan zombies. They cannot act, but do not satisfy full PGID-absence proof.
    try { assert.equal(readFileSync(`/proc/${String(descendant.pid)}/stat`, 'utf8').split(') ')[1]?.startsWith('Z'), true); }
    catch (error) { assert.equal((error as NodeJS.ErrnoException).code, 'ENOENT'); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
