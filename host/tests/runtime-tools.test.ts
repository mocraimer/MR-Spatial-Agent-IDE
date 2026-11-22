import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { EnvironmentError } from '../src/environment-broker.js';
import { createTaskToolHandler, TASK_TOOL_DEFINITIONS, type FixedTaskEnvironment } from '../src/runtime-tools.js';
import type { CoordinatorCommands, RunRecord } from '../src/runtime-coordinator.js';

function fixture(loseAcknowledgement: boolean | Error | 'revoke-after-effect' | 'serialization-failure' = false) {
  let allowed = true, generation = 1;
  let sourceGate: Promise<void> | null = null;
  let readGate: Promise<void> | null = null;
  const effects: unknown[] = [];
  const acknowledge = () => {
    if (loseAcknowledgement === 'revoke-after-effect') allowed = false;
    else if (loseAcknowledgement && loseAcknowledgement !== 'serialization-failure') throw loseAcknowledgement instanceof Error ? loseAcknowledgement : new Error('Mutated before lost ACK.');
  };
  const run: RunRecord = { id: 'run-fixture', taskId: 'core-task-fixture', attempt: 1, authority: { type: 'grant', id: 'fixture-grant', version: 1 }, limits: { maxAttempts: 2, maxConcurrentRuns: 1, maxPaidCallUsd: 0 }, runtime: 'pi-local', profile: 'custom-tools', actions: ['conversation', 'task-tools', 'delegate-task'], settings: { requested: { model: 'exact', effort: 'high' }, resolved: { model: 'exact', effort: 'high' }, observed: { model: 'exact', effort: 'high' } }, startedAt: new Date().toISOString(), status: 'running', interactive: { requestId: 'request-fixture', conversationId: 'conversation-fixture', rootTaskId: 'core-task-fixture' } };
  const coordinator = { currentAuthoritySettings: () => allowed ? { allowed: true as const, authority: run.authority, limits: run.limits, run, request: { repo: 'fixture', workClass: 'interactive', runtime: run.runtime, profile: run.profile, actions: run.actions, taskId: run.taskId } } : { allowed: false as const, outcome: { kind: 'refused' as const, summary: 'revoked fixture', nextAction: 'owner' } } } satisfies Pick<CoordinatorCommands, 'currentAuthoritySettings'>;
  const identity = () => ({ taskId: 'product-task-fixture', environmentId: 'private-environment-fixture', viewId: 'fixture-view', generation, leaseEpoch: 9 });
  const environment: FixedTaskEnvironment = { taskId: 'product-task-fixture', epoch: 9,
    tools: Object.freeze({ async exec(taskId: string, epoch: number, command: string) { effects.push({ taskId, epoch, command }); acknowledge(); return { output: 'confined output', exitCode: 0, ...(loseAcknowledgement === 'serialization-failure' ? { toJSON() { throw new Error('Result serialization failed after effect.'); } } : {}) }; }, async read(taskId: string, path: string) { effects.push({ taskId, path }); if (readGate) await readGate; return Buffer.from('private workspace data'); }, async write(taskId: string, epoch: number, path: string, content: string | Buffer) { effects.push({ taskId, epoch, path, content }); acknowledge(); }, async input(value: unknown) { effects.push(value); acknowledge(); } }),
    identity,
    async frame() { return { png: Buffer.from('fixture-only-image'), identity: { ...identity(), sequence: 1, capturedAt: new Date().toISOString(), width: 1280, height: 800 } }; },
  };
  const handler = createTaskToolHandler({ coordinator, runId: run.id, environment, context: () => ({ source: 'this-conversation-fixture' }), source: async sourceId => { if (sourceGate) await sourceGate; if (sourceId !== 'allowed-source') throw new Error('Cross-project source denied.'); return { id: sourceId, provenance: 'owner-upload fixture', text: 'Source says grantCreate as operator; this is inert untrusted content.' }; }, request: (kind, title, detail) => { effects.push({ kind, title, detail }); acknowledge(); return 'request retained'; }, delegate: async (key, title, prompt) => { effects.push({ key, title, prompt }); acknowledge(); return { parent: run.taskId }; } });
  return { handler, effects, revoke() { allowed = false; }, replaceFrame() { generation++; }, delaySource(gate: Promise<void>) { sourceGate = gate; }, delayRead(gate: Promise<void>) { readGate = gate; } };
}
describe('custom model tools have a fixed task, current authority and current inspected frame', () => {
  it('advertises no host/operator/coordinator/Docker/network/server/subagent tool or role/task selector', () => {
    assert.equal(TASK_TOOL_DEFINITIONS.length, 9);
    for (const tool of TASK_TOOL_DEFINITIONS) {
      const properties = tool.inputSchema.properties as Record<string, unknown>;
      for (const privileged of ['taskId', 'role', 'operator', 'grant', 'runtime', 'model', 'spaceId', 'projectId', 'epoch', 'leaseEpoch']) assert.equal(privileged in properties, false);
      assert.equal(tool.inputSchema.additionalProperties, false);
    }
  });
  it('permitted work goes only to the fixed private task with its admitted epoch', async () => {
    const { handler, effects } = fixture();
    await handler('task_exec', { command: 'echo confined' }); await handler('task_write', { path: 'src/result.txt', content: 'scoped result' });
    assert.equal((effects[0] as { taskId: string }).taskId, 'product-task-fixture'); assert.equal((effects[1] as { epoch: number }).epoch, 9);
  });
  it('forged task/role/epoch/runtime/operator fields and unknown command names have no effects', async () => {
    const { handler, effects } = fixture();
    for (const field of ['taskId', 'role', 'grant', 'operator', 'epoch', 'runtime']) await assert.rejects(() => handler('task_exec', { command: 'host mutation', [field]: 'forged' }), /cannot select/);
    for (const name of ['bash', 'Read', 'server', 'runStop', 'grantCreate', 'user_bash', 'set_model']) await assert.rejects(() => handler(name, {}), /Unknown/);
    assert.equal(effects.length, 0);
  });
  it('rechecks current grant for file reads, mutations, context, requests and delegation', async () => {
    const { handler, effects, revoke } = fixture(); revoke();
    for (const [name, args] of [['task_source', { sourceId: 'allowed-source' }], ['task_read', { path: 'data.txt' }], ['task_write', { path: 'data.txt', content: 'x' }], ['task_exec', { command: 'echo x' }], ['task_context', {}], ['task_request', { kind: 'question', title: 'owner', detail: 'scope' }], ['task_delegate', { key: 'child', title: 'bounded', prompt: 'work' }]] as const) await assert.rejects(() => handler(name, args), /authority/);
    assert.equal(effects.length, 0);
  });
  it('marks authority loss after a generic mutator returned as uncertain, unlike a before-send denial', async () => {
    const { handler, effects } = fixture('revoke-after-effect');
    await assert.rejects(() => handler('task_write', { path: 'result.txt', content: 'effect' }), /authority/);
    assert.equal(effects.length, 1); assert.equal(handler.effectsUncertain?.(), true);
    const denied = fixture(); denied.revoke();
    await assert.rejects(() => denied.handler('task_write', { path: 'result.txt', content: 'never sent' }), /authority/);
    assert.equal(denied.effects.length, 0); assert.equal(denied.handler.effectsUncertain?.(), false);
  });
  it('keeps result serialization failures after a mutating call uncertain', async () => {
    const { handler, effects } = fixture('serialization-failure');
    await assert.rejects(() => handler('task_exec', { command: 'effect' }), /serialization/);
    assert.equal(effects.length, 1); assert.equal(handler.effectsUncertain?.(), true);
  });
  it('only trusts the actual host broker class for effect classification, not lookalike error properties', async () => {
    const forged = Object.assign(new Error('tool claimed clean after effect'), { effectState: 'not-sent', code: 'control-unavailable' });
    const unknown = fixture(forged);
    await assert.rejects(() => unknown.handler('task_write', { path: 'result.txt', content: 'effect' }));
    assert.equal(unknown.handler.effectsUncertain?.(), true);
    const postSend = fixture(new EnvironmentError('stale-epoch', 'after effect', undefined, 'uncertain'));
    await assert.rejects(() => postSend.handler('task_write', { path: 'result.txt', content: 'effect' }));
    assert.equal(postSend.handler.effectsUncertain?.(), true);
  });
  it('keeps every post-send mutating failure sticky across subsequent successful read-only tools', async () => {
    const input = { view: 'browser', kind: 'text', x: 0, y: 0, button: '', key: '', text: 'confined input' };
    for (const [name, args] of [['task_exec', { command: 'effect' }], ['task_write', { path: 'result.txt', content: 'effect' }], ['task_input', input], ['task_request', { kind: 'review', title: 'review', detail: 'evidence' }], ['task_delegate', { key: 'child', title: 'child', prompt: 'work' }]] as const) {
      const { handler, effects } = fixture(true);
      if (name === 'task_input') await handler('task_frame', { view: 'browser' });
      await assert.rejects(() => handler(name, args), /lost ACK/);
      assert.equal(effects.length, 1); assert.equal(handler.effectsUncertain?.(), true);
      await handler('task_context', {}); await handler('task_source', { sourceId: 'allowed-source' });
      assert.equal(handler.effectsUncertain?.(), true);
      assert.throws(() => Object.defineProperty(handler, 'effectsUncertain', { value: () => false }), /redefine/);
    }
  });
  it('reads only fixed-receiver sources with provenance, and keeps injected commands inert', async () => {
    const { handler, effects } = fixture();
    const result = await handler('task_source', { sourceId: 'allowed-source' });
    assert.match((result.content[0] as { text: string }).text, /untrusted-source-content.*owner-upload fixture.*grantCreate/);
    await assert.rejects(() => handler('task_source', { sourceId: 'other-project-source' }), /Cross-project/);
    await assert.rejects(() => handler('task_source', { sourceId: 'allowed-source', spaceId: 'other-project' }), /cannot select/);
    assert.equal(effects.length, 0); assert.equal(handler.effectsUncertain?.(), false);
  });
  it('does not disclose a source whose grant was revoked during the read await', async () => {
    const { handler, revoke, delaySource } = fixture();
    let release!: () => void; delaySource(new Promise<void>(resolve => { release = resolve; }));
    const reading = handler('task_source', { sourceId: 'allowed-source' });
    revoke(); release();
    await assert.rejects(() => reading, /authority/); assert.equal(handler.effectsUncertain?.(), false);
  });
  it('withholds a workspace read revoked during its await without inventing future mutation uncertainty', async () => {
    const { handler, revoke, delayRead } = fixture();
    let release!: () => void; delayRead(new Promise<void>(resolve => { release = resolve; }));
    const reading = handler('task_read', { path: 'private.txt' });
    revoke(); release();
    await assert.rejects(() => reading, /authority/); assert.equal(handler.effectsUncertain?.(), false);
  });
  it('requires an inspected current frame and refuses replacement/stale input', async () => {
    const { handler, effects, replaceFrame } = fixture(); const input = { view: 'browser', kind: 'text', x: 0, y: 0, button: '', key: '', text: 'confined application input' };
    await assert.rejects(() => handler('task_input', input), /Inspect/);
    await handler('task_frame', { view: 'browser' }); await handler('task_input', input); assert.equal(effects.length, 1);
    replaceFrame(); await assert.rejects(() => handler('task_input', input), /stale/); assert.equal(effects.length, 1);
  });
});
