import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { accessSync, chmodSync, constants, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { GuardedLocalAdapter, claudeArguments, piArguments, type RuntimeEvent, type RuntimeProfile } from '../src/runtime-adapters.js';
import { TASK_TOOL_DEFINITIONS } from '../src/runtime-tools.js';
import { RuntimeProcess } from '../src/runtime-process.js';
import type { DispatchInput } from '../src/runtime-coordinator.js';

let directory: string;
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'srt-')); });
afterEach(() => rmSync(directory, { recursive: true, force: true }));
function profile(runtime: 'pi-local' | 'claude-local', bin: string, id: string): RuntimeProfile {
  const configDirectory = join(directory, runtime, 'config'); mkdirSync(configDirectory, { recursive: true, mode: 0o700 });
  return { runtime, bin, configDirectory, dataDirectory: join(directory, runtime, 'data'), scriptDirectory: resolve('scripts'), subscriptionId: 'fixture-account', models: [{ id, efforts: ['high'] }] };
}
function adapter(p: RuntimeProfile, events: RuntimeEvent[] = [], beforePrompt = () => undefined) {
  return new GuardedLocalAdapter(p, { authenticate: async () => true, beforePrompt, event: (_input, event) => events.push(event), tools: async () => async () => ({ content: [{ type: 'text', text: 'fixture tools only' }] }), readUsage: async () => ({ ok: false, unavailable: { subscriptionId: 'fixture', attemptedAt: new Date().toISOString(), source: 'fixture', reason: 'fixture', operatorAction: 'no inference' } }) });
}
function input(model: string): DispatchInput {
  return { taskId: 'fixture-task', runId: 'fixture-run', task: 'fixture turn', repoPath: '/never-task-cwd', evidenceDir: directory,
    settings: { model, effort: 'high' }, sessionId: 'core-session-ref', entry: 'interactive', interactive: { requestId: 'fixture-request', conversationId: 'fixture-conversation' } };
}
function fakeCli(runtime: string, callTool = false, toolBytes = false): string {
  const file = join(directory, 'fake-cli.mjs');
  writeFileSync(file, `#!/usr/bin/env node
import process from 'node:process';
import { connect } from 'node:net';
import { StringDecoder } from 'node:string_decoder';
import { appendFileSync, readFileSync } from 'node:fs';
const runtime=${JSON.stringify(runtime)};
const args=process.argv.slice(2), value=n=>args.indexOf(n)<0?undefined:args[args.indexOf(n)+1];
const names=JSON.parse(readFileSync(process.env.SPATIAL_TOOL_DEFINITIONS,'utf8')).map(t=>t.name);
if(runtime==='pi-local'){
 const socket=connect(process.env.SPATIAL_TOOL_SOCKET);
 socket.on('connect',()=>socket.write(JSON.stringify({token:process.env.SPATIAL_TOOL_TOKEN,type:'inventory',active:names,registered:names})+'\\n'));
 socket.on('data',()=>socket.end());
}
let buffer='';const decoder=new StringDecoder('utf8');
const write=r=>process.stdout.write(JSON.stringify(r)+'\\n');
process.stdin.on('data',async chunk=>{buffer+=decoder.write(chunk);for(let n;(n=buffer.indexOf('\\n'))>=0;){const q=JSON.parse(buffer.slice(0,n));buffer=buffer.slice(n+1);
 if(q.type==='control_request'){
 const sub=q.request.subtype;
 const result=sub==='initialize'?{commands:[],models:[{resolvedModel:value('--model'),supportedEffortLevels:['high']}]}:sub==='mcp_status'?{mcpServers:[{name:'spatial',status:'connected',tools:names.map(name=>({name}))}]}:{};
 write({type:'control_response',response:{subtype:'success',request_id:q.request_id,response:result}});
 if(sub==='interrupt')write({type:'result',session_id:value('--session-id')??value('--resume'),is_error:true,result:'partial turn aborted'});
 }else if(q.type==='get_state')write({type:'response',id:q.id,success:true,data:{model:{provider:value('--provider'),id:value('--model')},thinkingLevel:value('--thinking'),sessionId:value('--session-id'),sessionFile:value('--session')??value('--session-dir')+'/fixture.jsonl'}});
 else if(q.type==='get_commands')write({type:'response',id:q.id,success:true,data:{commands:[]}});
 else if(q.type==='prompt'||q.type==='user'){
 appendFileSync(${JSON.stringify(join(directory, 'fixture-inference-counter'))},'fixture\\n');
 ${callTool ? `await new Promise(resolve=>{const s=connect(process.env.SPATIAL_TOOL_SOCKET);let b='';s.on('connect',()=>{const request=Buffer.from(JSON.stringify({token:process.env.SPATIAL_TOOL_TOKEN,type:'tool',name:${toolBytes ? "'task_write'" : "'task_read'"},args:${toolBytes ? "{path:'euro-€.txt',text:'preserve € 🤖'}" : "{path:'missing.txt'}"}})+'\\n');const split=request.indexOf(Buffer.from('€'))+1;s.write(request.subarray(0,split));setTimeout(()=>s.write(request.subarray(split)),25);});s.on('data',c=>{b+=c;if(b.includes('\\n')){s.end();resolve();}});s.on('error',resolve);s.on('close',resolve);});` : ''}
 if((q.message?.content??q.message)==='wait-abort'){
 if(runtime==='pi-local'){write({type:'response',id:q.id,success:true,data:{disposition:'started'}});write({type:'message_start',message:{role:'assistant'}});write({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'partial'}});}
 else{write({type:'stream_event',event:{type:'message_start'}});write({type:'stream_event',event:{type:'content_block_delta',delta:{type:'text_delta',text:'partial'}}});}
 continue;
 }
 if(runtime==='pi-local'){
 write({type:'response',id:q.id,success:true,data:{disposition:'started'}});
 write({type:'message_start',message:{role:'assistant'}});
 write({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'hello \\u2028world'}});
 write({type:'message_end',message:{role:'assistant',provider:value('--provider'),model:value('--model'),thinkingLevel:'high',stopReason:'stop',content:[{type:'text',text:'hello \\u2028world'}]}});
 write({type:'agent_settled'});
 }else{
 write({type:'stream_event',event:{type:'message_start'}});
 write({type:'stream_event',event:{type:'content_block_delta',delta:{type:'text_delta',text:'hello world'}}});
 write({type:'assistant',message:{model:value('--model'),content:[{type:'text',text:'hello world'}]}});
 write({type:'result',session_id:value('--session-id')??value('--resume'),is_error:false,result:'hello world'});
 }
 }else{write({type:'response',id:q.id,success:true});if(q.type==='abort')write({type:'agent_settled'});}
}});
process.stdin.on('end',()=>process.exit(0));
`, { mode: 0o700 }); chmodSync(file, 0o700); return file;
}
describe('guarded bounded runtime implementation (fixture inference only)', () => {
  it('sets every isolation flag; never points runtime discovery at a task workspace or loads a project plugin', () => {
    const p = profile('pi-local', '/cli', 'anthropic/exact'); const session = { id: '00000000-0000-4000-8000-000000000000', hasHistory: false, runtime: 'pi-local' };
    const args = piArguments(p, 'anthropic/exact', 'high', session, '/private/runtime');
    for (const flag of ['--no-builtin-tools', '--no-extensions', '-e', '--no-context-files', '--no-skills', '--no-prompt-templates', '--offline']) assert.ok(args.includes(flag));
    const c = claudeArguments({ ...p, runtime: 'claude-local' }, 'exact-model', 'high', session, '{"mcpServers":{}}');
    for (const flag of ['--restricted', '--strict-mcp-config', '--setting-sources', '--disable-slash-commands', '--no-chrome']) assert.ok(c.includes(flag));
    assert.equal(c[c.indexOf('--tools') + 1], ''); assert.equal(c[c.indexOf('--setting-sources') + 1], '');
    assert.equal(c.includes('--safe-mode'), false); assert.equal(c.includes('--fallback-model'), false);
    assert.equal(JSON.parse(c[c.indexOf('--settings') + 1]!).disableAllHooks, true);
  });
  for (const runtime of ['pi-local', 'claude-local'] as const) {
    it(`${runtime} streams finalized messages, closes bounded workers and resumes exact conversation history`, async () => {
      const model = runtime === 'pi-local' ? 'anthropic/exact' : 'exact-model'; const p = profile(runtime, fakeCli(runtime), model); const events: RuntimeEvent[] = [];
      const a = adapter(p, events); const first = await a.dispatch(input(model));
      assert.equal(first.outcome.kind, 'completed'); assert.ok(events.some(event => event.type === 'delta')); assert.ok(events.some(event => event.type === 'message'));
      assert.equal(events.filter(event => event.type === 'delta')[0]?.messageId, events.filter(event => event.type === 'message')[0]?.messageId);
      // Pi fixture echoes caller id from first launch; resume restores it from the retained identity.
      if (runtime === 'pi-local') {
        const identityFile = events.find(event => event.type === 'session')!.sessionId;
        assert.ok(identityFile);
        const file = p.bin; const source = readFileSync(file, 'utf8');
        writeFileSync(file, source.replace("sessionId:value('--session-id')", `sessionId:${JSON.stringify(identityFile)}`));
      }
      const second = await a.dispatch({ ...input(model), runId: 'fixture-followup', task: 'fixture follow-up', interactive: { requestId: 'followup-request', conversationId: 'fixture-conversation' } });
      assert.equal(second.outcome.kind, 'completed'); assert.equal(events.filter(event => event.type === 'session')[0]?.sessionId, events.filter(event => event.type === 'session')[1]?.sessionId);
      assert.equal(readFileSync(join(directory, 'fixture-inference-counter'), 'utf8').trim().split('\n').length, 2);
      assert.equal((await a.reconcile(first.sessionId!, directory)).kind, 'completed');
    });
    it(`${runtime} does not treat isError alone as an unknown task effect`, async () => {
      const model = runtime === 'pi-local' ? 'anthropic/exact' : 'exact-model';
      const a = new GuardedLocalAdapter(profile(runtime, fakeCli(runtime, true), model), {
        authenticate: async () => true, beforePrompt: () => undefined, event: () => undefined,
        tools: async () => async () => ({ content: [{ type: 'text', text: 'File not found; no mutation.' }], isError: true }),
        readUsage: async () => { throw new Error('No provider calls in this fixture.'); },
      });
      assert.equal((await a.dispatch(input(model))).outcome.kind, 'completed');
    });
    it(`${runtime} aborts the current turn, preserves partial output/history and closes its worker`, async () => {
      const model = runtime === 'pi-local' ? 'anthropic/exact' : 'exact-model'; const events: RuntimeEvent[] = [];
      const a = adapter(profile(runtime, fakeCli(runtime), model), events);
      const running = a.dispatch({ ...input(model), task: 'wait-abort' });
      while (!events.some(event => event.type === 'delta')) await new Promise(resolve => setImmediate(resolve));
      assert.equal(await a.abortTurn('core-session-ref'), true);
      assert.equal((await running).outcome.kind, 'checks-failed');
      assert.ok(events.some(event => event.text?.includes('partial')));
      assert.equal(await a.abortTurn('core-session-ref'), false);
    });
    it(`${runtime} blocks before prompt if trusted authority preflight fails`, async () => {
      const model = runtime === 'pi-local' ? 'anthropic/exact' : 'exact-model'; const a = adapter(profile(runtime, fakeCli(runtime), model), [], () => { throw new Error('revoked'); });
      const result = await a.dispatch(input(model));
      assert.equal(result.outcome.kind, 'setup-blocked'); assert.equal(result.outcome.promptNotSent, true);
      assert.equal(existsSync(join(directory, 'fixture-inference-counter')), false);
    });
  }
  it('actual private tool bridge preserves split UTF-8 task_write args without changing error classification', async () => {
    const calls: unknown[] = [];
    const a = new GuardedLocalAdapter(profile('pi-local', fakeCli('pi-local', true, true), 'anthropic/exact'), {
      authenticate: async () => true, beforePrompt: () => undefined, event: () => undefined,
      tools: async () => async (name, args) => { calls.push({ name, args }); return { content: [{ type: 'text', text: 'known fixture failure without effects' }], isError: true }; },
      readUsage: async () => { throw new Error('No provider calls.'); },
    });
    assert.equal((await a.dispatch(input('anthropic/exact'))).outcome.kind, 'completed');
    assert.deepEqual(calls, [{ name: 'task_write', args: { path: 'euro-€.txt', text: 'preserve € 🤖' } }]);
  });
  it('actual private tool bridge rejects a multibyte request above its raw-byte bound before execution', async () => {
    const file = fakeCli('pi-local', true, true);
    writeFileSync(file, readFileSync(file, 'utf8').replace("text:'preserve € 🤖'", "text:'€'.repeat(700000)"));
    let calls = 0;
    const a = new GuardedLocalAdapter(profile('pi-local', file, 'anthropic/exact'), {
      authenticate: async () => true, beforePrompt: () => undefined, event: () => undefined,
      tools: async () => async () => { calls++; return { content: [] }; }, readUsage: async () => { throw new Error('No provider calls.'); },
    });
    await a.dispatch(input('anthropic/exact')); assert.equal(calls, 0);
  });
  it('private Pi command boundary rejects raw bash/session/config commands before writing to a child', async () => {
    const file = fakeCli('pi-local'); const p = new RuntimeProcess(file, [], directory, { PATH: process.env.PATH });
    try { await assert.rejects(() => p.pi('bash' as 'prompt', { command: 'touch /host' }), /Denied/); await assert.rejects(() => p.pi('switch_session' as 'prompt'), /Denied/); }
    finally { await p.close(); }
  });
  it('missing explicit account/profile authentication remains BLOCKED before inference', async () => {
    const p = profile('pi-local', fakeCli('pi-local'), 'anthropic/exact');
    const a = new GuardedLocalAdapter(p, { beforePrompt: () => undefined, event: () => undefined, tools: async () => async () => ({ content: [] }), readUsage: async () => { throw new Error('must not read provider'); } });
    assert.equal((await a.checkReadiness())?.kind, 'setup-blocked');
    const result = await a.dispatch(input('anthropic/exact'));
    assert.equal(result.outcome.promptNotSent, true); assert.equal(result.outcome.kind, 'setup-blocked');
    assert.equal(existsSync(join(directory, 'fixture-inference-counter')), false);
  });
  it('unsupported models and efforts fail rather than downgrade', async () => {
    const a = adapter(profile('pi-local', fakeCli('pi-local'), 'anthropic/exact'));
    await assert.rejects(() => a.dispatch({ ...input('anthropic/exact'), settings: { model: 'cheap/fallback', effort: 'high' } }), /Unsupported/);
    await assert.rejects(() => a.dispatch({ ...input('anthropic/exact'), settings: { model: 'anthropic/exact', effort: 'low' } }), /Unsupported/);
    assert.equal(existsSync(join(directory, 'fixture-inference-counter')), false);
  });
});
const onPath = (name: string): string | undefined => (process.env['PATH'] ?? '').split(delimiter).map(directory => join(directory, name)).find(path => { try { accessSync(path, constants.X_OK); return true; } catch { return false; } });
const piBin = process.env['SPATIAL_PI_BIN'] ?? onPath('pi');
const claudeBin = process.env['SPATIAL_CLAUDE_BIN'] ?? onPath('claude');
const missing = (tool: string, variable: string): string => `${tool} is not installed; put it on PATH or set ${variable}`;
describe('actual installed CLI tool discovery / preprompt handshake, ZERO inference/provider calls', () => {
  it('Pi 0.99.2 exposes ONLY custom bridged tools before prompt', { skip: piBin ? false : missing('pi', 'SPATIAL_PI_BIN') }, async () => {
    const a = adapter(profile('pi-local', piBin ?? 'pi', 'anthropic/claude-sonnet-4-6'));
    assert.deepEqual(await a.probe('anthropic/claude-sonnet-4-6', 'high'), { runtime: 'pi-local', inventory: TASK_TOOL_DEFINITIONS.map(tool => tool.name), inference: false });
  });
  it('Claude restricted + empty builtins retains explicit custom MCP (safe-mode deliberately absent)', { skip: claudeBin ? false : missing('claude', 'SPATIAL_CLAUDE_BIN') }, async () => {
    const a = adapter(profile('claude-local', claudeBin ?? 'claude', 'claude-opus-5-5'));
    assert.deepEqual(await a.probe('claude-opus-5-5', 'high'), { runtime: 'claude-local', inventory: TASK_TOOL_DEFINITIONS.map(tool => tool.name), inference: false });
  });
});
