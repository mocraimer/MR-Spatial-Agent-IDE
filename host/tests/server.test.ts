import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { createHash } from 'node:crypto';
import type { TLSSocket } from 'node:tls';
import { DatabaseSync } from 'node:sqlite';
import { PairingAuthority, ensureHostCertificate } from '../src/auth.js';
import { EnvironmentBroker, type EnvironmentEngine, type ManagedEnvironment } from '../src/environment-broker.js';
import { WorkspaceStore } from '../src/store.js';
import { createHostServer, HostApiError, type HostOwner, type HostServices } from '../src/server.js';
import type { Message, Receiver, Snapshot } from '../src/protocol.js';
import { OpenAiSpeechService } from '../src/speech.js';

function wav(): Buffer { const b = Buffer.alloc(364); b.write('RIFF'); b.writeUInt32LE(356, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(320, 40); return b; }
const target: Receiver = { spaceId: 'overview', conversationId: 'conversation-overview', taskId: null };
async function fixture(storePath?: ':memory:') {
  const directory = mkdtempSync(join(tmpdir(), 'spatial-http-test-'));
  const auth = new PairingAuthority(join(directory, 'auth'));
  const cert = ensureHostCertificate(join(directory, 'tls'));
  const store = new WorkspaceStore(storePath ?? join(directory, 'workspace.sqlite'));
  const queued: { id: string; owner: HostOwner }[] = [], decided: { action: string; owner: HostOwner }[] = [];
  let transcript = 'A real provider is replaced by a test adapter in this test';
  const services: HostServices = {
    execution: {
      readiness: async () => [{ id: 'test-execution-fixture', state: 'ready', detail: 'Test fixture; NOT real agent proof' }],
      validateSettings: async settings => { if (settings.runtime === 'blocked') throw new HostApiError(403, 'runtime-blocked', 'This runtime is not permitted.', 'Choose an admitted runtime.'); },
      queue: async (s, owner) => { queued.push({ id: s.id, owner }); store.updateSubmission(s.id, { state: 'submitted', detail: 'Test adapter acknowledged, not actual execution evidence' }); },
      interrupt: async (_task, mode) => ({ state: 'uncertain', detail: `${mode} cancellation not acknowledged by test fixture` }),
      decide: async (_request, decision, owner) => { decided.push({ action: decision.action, owner }); },
    },
    // Explicit trusted absence fixture; not coordinator or Docker acceptance evidence.
    lifecycle: { readiness: () => ({ id: 'archive-reader-fixture', state: 'ready', detail: 'Fixture only: no coordinator cutoffs exist' }), assertDestinationAvailable() {}, archive: async () => { throw new Error('No archive writer installed in this ingress fixture'); } },
    speech: { readiness: async () => [{ id: 'speech-test-fixture', state: 'ready', detail: 'Not real transcription proof' }], transcribe: async () => transcript, synthesize: async () => wav() },
  };
  const host = createHostServer({ store, auth, certificate: cert, services });
  const ports = await host.listen();
  const base = `http://127.0.0.1:${ports.consolePort}`;
  const setup = await (await fetch(base + '/setup')).json() as { pairing: { code: string }; fingerprint: string };
  const paired = auth.pair(setup.pairing.code, 'Fixture headset');
  async function native(path: string, method = 'GET', data?: unknown, authorization: string | null = paired.token, headers: Record<string, string> = {}) {
    return new Promise<{ status: number; headers: import('node:http').IncomingHttpHeaders; bytes: Buffer; json: () => Record<string, unknown> }>((resolve, reject) => {
      // Self-signed TLS in isolated test only. Pin is independently obtained from trusted setup.
      const req = httpsRequest({ hostname: '127.0.0.1', port: ports.nativePort, path, method, agent: false, rejectUnauthorized: false, headers: { ...(authorization ? { Authorization: 'Bearer ' + authorization } : {}), ...(data !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers } }, res => {
        const chunks: Buffer[] = []; res.on('data', chunk => chunks.push(Buffer.from(chunk as Buffer))); res.on('end', () => { const bytes = Buffer.concat(chunks); resolve({ status: res.statusCode!, headers: res.headers, bytes, json: () => JSON.parse(bytes.toString()) as Record<string, unknown> }); });
      });
      req.once('socket', socket => { const tls = socket as TLSSocket; tls.once('secureConnect', () => { if (createHash('sha256').update(tls.getPeerCertificate().raw).digest('hex') !== setup.fingerprint) req.destroy(new Error('TLS peer does not match independently obtained setup pin')); }); });
      req.on('error', reject); if (data !== undefined) req.write(JSON.stringify(data)); req.end();
    });
  }
  return { auth, cert, store, services, host, native, base, ports, paired, queued, decided, directory, setTranscript: (text: string) => { transcript = text; }, close: async () => { await host.close(); store.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test('booted TLS/loopback server guards private setup, pairing, revoked callers and DNS rebinding (private SQLite)', async () => {
  const f = await fixture();
  try {
    const health = await f.native('/v1/health', 'GET', undefined, null); assert.equal(health.status, 200); assert.deepEqual(health.json(), { protocolVersion: 1, state: 'listening' });
    assert.equal(health.bytes.includes(Buffer.from(f.cert.fingerprint)), false);
    assert.equal((await f.native('/setup')).status, 404);
    assert.equal((await f.native('/v1/snapshot', 'GET', undefined, null)).status, 401);
    assert.equal((await f.native('/v1/snapshot', 'GET', undefined, f.paired.token, { Origin: 'http://evil.example' })).status, 403);
    for (const headers of [{ Host: 'evil.example:' + f.ports.consolePort }, { Origin: 'https://localhost:' + f.ports.consolePort }, { Origin: 'http://evil.example' }]) {
      const response = await new Promise<{ status: number; text: string; cors: string | string[] | undefined }>((resolve, reject) => {
        const req = httpRequest(f.base + '/setup', { headers }, res => { let output = ''; res.on('data', chunk => { output += String(chunk); }); res.on('end', () => resolve({ status: res.statusCode!, text: output, cors: res.headers['access-control-allow-origin'] })); }); req.on('error', reject); req.end();
      });
      assert.equal(response.status, 403); assert.equal(response.text.includes(f.cert.fingerprint), false); assert.equal(response.cors, undefined);
    }
    const setup = await (await fetch(f.base + '/setup')).json() as { pairing: { code: string }; fingerprint: string };
    assert.equal(setup.fingerprint, f.cert.fingerprint);
    const pair = await f.native('/v1/pair', 'POST', { code: setup.pairing.code, label: 'Another test device' }, null); assert.equal(pair.status, 200); assert.equal((await f.native('/v1/pair', 'POST', { code: setup.pairing.code, label: 'Replay' }, null)).status, 401);
    f.auth.revoke(f.paired.clientId); assert.equal((await f.native('/v1/snapshot')).status, 401);
    assert.equal((await f.native('/v1/projects', 'POST', { name: 'Forbidden', purpose: '' })).status, 401); assert.equal(f.store.snapshot().projects.length, 0);
  } finally { await f.close(); }
});

test('real SQLite routes preserve projects, spaces, links, settings, layout, fixed receiver and idempotent request identity', async () => {
  const f = await fixture();
  try {
    const p = (await f.native('/v1/projects', 'POST', { name: 'Owner test project', purpose: '<img src=x onerror=alert(1)>' })).json();
    assert.equal(typeof p.id, 'string');
    const root = f.store.getSpace(String(p.rootSpaceId));
    const child = (await f.native('/v1/spaces', 'POST', { projectId: p.id, parentId: root.id, name: 'Child', purpose: '' })).json();
    assert.equal((await f.native('/v1/spaces/' + child.id, 'PATCH', { name: 'Updated child', position: { x: 1, y: 2, z: 3 } })).status, 200);
    assert.equal((await f.native('/v1/links', 'POST', { fromId: root.id, toId: child.id, label: 'Go to child' })).status, 201);
    assert.equal((await f.native('/v1/projects/' + p.id, 'PATCH', { name: 'Renamed project' })).status, 200);
    assert.equal(f.store.getSpace(root.id).name, 'Renamed project');
    const receiver = { spaceId: root.id, conversationId: root.conversationId, taskId: null };
    assert.equal((await f.native('/v1/conversations/' + root.conversationId + '/settings', 'PATCH', { runtime: 'test', model: '', effort: '' })).status, 200);
    const turn = { idempotencyKey: 'one-turn', receiver, text: 'Fixture turn' };
    const first = await f.native('/v1/turns', 'POST', turn); assert.equal(first.status, 202);
    assert.equal((await f.native('/v1/turns', 'POST', turn)).json().requestId, first.json().requestId); assert.equal(f.queued.length, 1);
    assert.deepEqual(f.queued[0]!.owner, { clientId: f.paired.clientId, surface: 'native' }); assert.equal('token' in f.queued[0]!.owner, false);
    assert.equal((await f.native('/v1/turns', 'POST', { ...turn, text: 'Different' })).status, 409);
    assert.equal((await f.native('/v1/turns', 'POST', { ...turn, idempotencyKey: 'wrong', receiver: { ...receiver, spaceId: 'overview' } })).status, 400);
    assert.equal((await f.native('/v1/turns', 'POST', { ...turn, owner: { clientId: 'forged' } })).status, 400);
    const taskInput = { idempotencyKey: 'task-one', spaceId: root.id, title: 'Adapter task', prompt: 'Private fixture task', runtime: 'test', model: '', effort: '' };
    const task = (await f.native('/v1/tasks', 'POST', taskInput)).json();
    assert.equal((await f.native('/v1/tasks', 'POST', taskInput)).json().id, task.id); assert.equal(f.queued.length, 2);
    const layout = { position: { x: 1, y: 2, z: 3 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } };
    assert.equal((await f.native('/v1/tasks/' + task.id + '/layout', 'PATCH', layout)).status, 200); assert.deepEqual(f.store.getTask(String(task.id)).layout, layout);
    const history = await f.native('/v1/conversations/' + root.conversationId + '/messages'); assert.equal((history.json().messages as unknown[]).length, 1);
    const snap = (await f.native('/v1/snapshot')).json() as unknown as Snapshot; assert.equal(snap.projects[0]?.name, 'Renamed project'); assert.equal(snap.readiness.some(r => r.id === 'environment' && r.state === 'missing'), true);
    assert.equal((await f.native('/v1/tasks/' + task.id + '/terminal')).status, 503);
    assert.equal((await f.native('/v1/conversations/' + root.conversationId + '/settings', 'PATCH', { runtime: 'blocked', model: '', effort: '' })).status, 403);
    assert.equal((await f.native('/v1/snapshot', 'GET', undefined, f.paired.token, { 'X-Protocol-Version': '99' })).status, 426);
    assert.equal((await f.native('/v1/turns', 'POST', { idempotencyKey: 'oversized', receiver, text: 'x'.repeat(150000) })).status, 413);
  } finally { await f.close(); }
});

test('Inbox refuses stale/forged/invalid approvals before coordinator effects; questions are never grants', async () => {
  const f = await fixture();
  try {
    const approval = f.store.createInboxRequest({ spaceId: 'overview', taskId: null, kind: 'approval', title: 'Approve test fixture scope', detail: 'Test only', evidence: ['evidence-1'] });
    f.store.updateInboxRequest(approval.id, 1, { evidence: ['evidence-2'] });
    assert.equal((await f.native('/v1/inbox/' + approval.id + '/respond', 'POST', { version: 1, action: 'approve', text: '' })).status, 409); assert.equal(f.decided.length, 0);
    const question = f.store.createInboxRequest({ spaceId: 'overview', taskId: null, kind: 'question', title: 'Question', detail: 'Not a grant', evidence: [] });
    assert.equal((await f.native('/v1/inbox/' + question.id + '/respond', 'POST', { version: 1, action: 'approve', text: '' })).status, 400); assert.equal(f.decided.length, 0);
    assert.equal((await f.native('/v1/inbox/' + question.id + '/respond', 'POST', { version: 1, action: 'answer', text: 'Owner answer', owner: 'forged' })).status, 400);
    assert.equal((await f.native('/v1/inbox/' + question.id + '/respond', 'POST', { version: 1, action: 'answer', text: 'Owner answer' })).status, 200); assert.equal(f.decided[0]?.action, 'answer');
    assert.equal((await f.native('/v1/inbox/' + approval.id + '/respond', 'POST', { version: 2, action: 'approve', text: 'yes' })).status, 400); assert.equal(f.decided.length, 1);
    const typed = { version: 2, action: 'approve', text: '', authorityId: 'fixture-existing-receipt', authorityVersion: 1 };
    assert.equal((await f.native('/v1/inbox/' + approval.id + '/respond', 'POST', typed)).status, 503, 'A void fixture service cannot claim atomic authority confirmation'); assert.equal(f.decided[1]?.action, 'approve');
    assert.equal(f.store.getInboxRequest(approval.id).state, 'open'); assert.equal(f.store.listInboxDecisions(approval.id).length, 0);
    assert.equal((await f.native('/v1/inbox/' + approval.id + '/respond', 'POST', { ...typed, authorityVersion: 1.5 })).status, 400); assert.equal(f.decided.length, 2);
    const denied = f.store.createInboxRequest({ spaceId: 'overview', taskId: null, kind: 'approval', title: 'Denied', detail: '', evidence: [] });
    f.services.execution!.decide = async () => { throw new HostApiError(403, 'revoked-authority', 'Authority has been revoked.', 'Request current owner authorization.'); };
    assert.equal((await f.native('/v1/inbox/' + denied.id + '/respond', 'POST', { version: 1, action: 'approve', text: '', authorityId: 'fixture-revoked-receipt', authorityVersion: 1 })).status, 403); assert.equal(f.store.getInboxRequest(denied.id).state, 'open');
    assert.equal((await f.native('/v1/inbox/' + denied.id + '/respond', 'POST', { version: 1, action: 'defer', text: '' })).status, 200);
  } finally { await f.close(); }
});

test('bounded voice validates PCM, intercepts exact owner navigation before dispatch, and keeps other turns on captured receiver (speech fixture)', async () => {
  const f = await fixture();
  try {
    f.setTranscript('  OPEN  my global INBOX  ');
    const request = { idempotencyKey: 'navigation-one', receiver: target, wavBase64: wav().toString('base64') };
    const result = await f.native('/v1/voice', 'POST', request); assert.equal(result.status, 200); assert.deepEqual(result.json(), { requestId: f.store.getSubmissionByKey('navigation-one')!.id, conversationId: target.conversationId, taskId: null, state: 'local-command', detail: 'open-global-inbox', transcript: '  OPEN  my global INBOX  ' }); assert.equal(f.queued.length, 0);
    f.setTranscript('please open my global inbox');
    const other = await f.native('/v1/voice', 'POST', { ...request, idempotencyKey: 'normal-turn' }); assert.equal(other.status, 202); assert.equal(other.json().conversationId, target.conversationId); assert.equal(f.queued.length, 1);
    const bad = wav(); bad.writeUInt32LE(48000, 24); assert.equal((await f.native('/v1/voice', 'POST', { ...request, idempotencyKey: 'bad-wave', wavBase64: bad.toString('base64') })).status, 400);
    assert.equal((await f.native('/v1/voice', 'POST', { ...request, wavBase64: 'not base64!' })).status, 400);
    assert.equal((await f.native('/v1/voice', 'POST', { ...request, receiver: { ...target, conversationId: 'missing' } })).status, 404);
    const message = f.store.appendMessage({ conversationId: target.conversationId, role: 'agent', text: 'open my global inbox' });
    const audio = await f.native('/v1/speech/' + message.id); assert.equal(audio.status, 200); assert.match(String(audio.headers['content-type']), /audio\/wav/); assert.equal(f.queued.length, 1);
    f.services.speech!.synthesize = async () => Buffer.from('RIFFgarbageWAVE');
    assert.equal((await f.native('/v1/speech/' + message.id)).status, 502);
    assert.equal((await f.native('/v1/turns', 'POST', { idempotencyKey: request.idempotencyKey, receiver: target, text: 'open my global inbox' })).status, 409);
    f.services.speech!.transcribe = async () => { throw new Error('SECRET-PROVIDER-TOKEN'); };
    const failure = await f.native('/v1/voice', 'POST', { ...request, idempotencyKey: 'provider-failure' }); assert.equal(failure.status, 500); assert.equal(failure.bytes.includes(Buffer.from('SECRET-PROVIDER-TOKEN')), false);
  } finally { await f.close(); }
});

test('reply speech rejects retained delegation instructions before synthesis or billing, but preserves real replies and their keys (offline HTTP fixture)', async () => {
  const f = await fixture(':memory:');
  const previousKey = process.env['OPENAI_API_KEY'];
  // Process-local fixture sentinel only; the injected transport never accesses an account/network.
  process.env['OPENAI_API_KEY'] = 'server-speech-fixture-NOT-A-REAL-KEY';
  const journalPath = join(f.directory, 'reply-speech.sqlite');
  const providerRequests: { model: string; input: string }[] = [];
  const synthesisRequests: { text: string; idempotencyKey: string | undefined }[] = [];
  const speech = new OpenAiSpeechService({
    journalPath, initializeJournal: true, approvedPerCallUsd: 0.1, approvedDailyUsd: 1,
    pricing: { whisperUsdPerMinute: 0.006, ttsUsdPerMillionCharacters: 15, verifiedAt: new Date().toISOString() },
    fetch: async (url, init) => {
      assert.equal(url, 'https://api.openai.com/v1/audio/speech');
      providerRequests.push(JSON.parse(Buffer.from(init.body as Uint8Array).toString()) as { model: string; input: string });
      return new Response(new Uint8Array(wav().subarray(44)), { headers: { 'Content-Type': 'audio/pcm' } });
    },
  });
  function billing() {
    const db = new DatabaseSync(journalPath);
    try { return db.prepare('SELECT key, kind, state, reserved_micro_usd FROM speech_calls ORDER BY rowid').all().map(row => ({ ...row })); }
    finally { db.close(); }
  }
  f.services.speech = {
    readiness: () => speech.readiness(), transcribe: () => { throw new Error('No voice capture in reply-speech fixture'); },
    synthesize: (text, context) => { synthesisRequests.push({ text, idempotencyKey: context?.idempotencyKey }); return speech.synthesize(text, context); },
  };
  try {
    const taskInput = { spaceId: 'overview', title: 'Speech fixture task', prompt: 'Initial fixture instructions', runtime: 'fixture', model: '', effort: '' };
    const parent = f.store.createTask({ ...taskInput, idempotencyKey: 'speech-parent' });
    const origin = { kind: 'agent-delegation' as const, parentConversationId: parent.conversationId, parentTaskId: parent.id, coordinatorParentRunId: 'fixture-trusted-parent-run' };
    const child = f.store.createTask({ ...taskInput, idempotencyKey: 'speech-delegated-child', parentTaskId: parent.id, origin });
    const submission = f.store.getSubmissionByKey('speech-delegated-child')!;
    const initial = f.store.updateMessage(submission.messageId, { state: 'complete' });
    f.store.updateSubmission(submission.id, { state: 'settled' });
    assert.equal(initial.role, 'agent'); assert.equal(initial.state, 'complete'); assert.ok(initial.text.trim()); assert.deepEqual(initial.origin, origin);
    const before = f.store.exportHistory(), revision = f.store.revision;
    for (let retry = 0; retry < 2; retry++) {
      const rejected = await f.native('/v1/speech/' + initial.id);
      assert.equal(rejected.status, 400); assert.equal(rejected.json().error, 'invalid-request');
    }
    assert.equal(synthesisRequests.length, 0, 'initial instructions never enter the speech supplier');
    assert.equal(providerRequests.length, 0, 'initial instructions never request provider audio');
    assert.deepEqual(billing(), [], 'initial instructions never reserve budget');
    assert.deepEqual({ ...f.store.exportHistory(), capturedAt: before.capturedAt }, before, 'rejection keeps instructions, submission history and provenance intact (excluding export observation time)');
    assert.equal(f.store.revision, revision);

    const negative: Message[] = [];
    for (const state of ['pending', 'streaming', 'failed', 'uncertain'] as const) negative.push(f.store.appendMessage({ conversationId: child.conversationId, role: 'agent', text: 'Partial fixture reply', state }));
    for (const text of ['', ' \t\r\n ']) negative.push(f.store.appendMessage({ conversationId: child.conversationId, role: 'agent', text, state: 'complete' }));
    for (const role of ['owner', 'system'] as const) negative.push(f.store.appendMessage({ conversationId: child.conversationId, role, text: 'Not an agent reply', state: 'complete' }));
    // A public owner-selected parent task links history; it does not establish delegation authorship.
    const ownerInput = { ...taskInput, idempotencyKey: 'speech-owner-child', parentTaskId: parent.id };
    const ownerCreated = await f.native('/v1/tasks', 'POST', ownerInput); assert.equal(ownerCreated.status, 202);
    const ownerSubmission = f.store.getSubmissionByKey(ownerInput.idempotencyKey)!;
    const ownerInitial = f.store.updateMessage(ownerSubmission.messageId, { state: 'complete' });
    assert.equal(ownerInitial.role, 'owner'); assert.equal(ownerInitial.origin, undefined);
    assert.equal(f.store.getTask(String(ownerCreated.json().id)).parentTaskId, parent.id);
    negative.push(ownerInitial);
    assert.equal((await f.native('/v1/tasks', 'POST', { ...ownerInput, idempotencyKey: 'forged-speech-origin', origin })).status, 400);
    for (const message of negative) assert.equal((await f.native('/v1/speech/' + message.id)).status, 400, `${message.role}/${message.state}/${JSON.stringify(message.text)} must not be spoken`);
    const unknown = await f.native('/v1/speech/unknown-fixture-message'); assert.equal(unknown.status, 404); assert.equal(unknown.json().error, 'not_found');
    assert.equal(synthesisRequests.length, 0); assert.equal(providerRequests.length, 0); assert.deepEqual(billing(), []);

    const reply = f.store.appendMessage({ conversationId: child.conversationId, requestId: submission.id, role: 'agent', text: 'Completed fixture reply', state: 'complete' });
    assert.equal(reply.origin, undefined, 'replies in a delegated task do not inherit initial instruction provenance');
    const replyKey = 'speech:' + reply.id;
    const audio = await f.native('/v1/speech/' + reply.id); assert.equal(audio.status, 200); assert.equal(audio.headers['content-type'], 'audio/wav');
    const replay = await f.native('/v1/speech/' + reply.id); assert.equal(replay.status, 200); assert.deepEqual(replay.bytes, audio.bytes);
    assert.deepEqual(synthesisRequests, [{ text: reply.text, idempotencyKey: replyKey }, { text: reply.text, idempotencyKey: replyKey }]);
    assert.equal(providerRequests.length, 1); assert.equal(providerRequests[0]!.input, reply.text); assert.equal(providerRequests[0]!.model, 'tts-1');
    const paid = billing(); assert.equal(paid.length, 1);
    assert.deepEqual(paid[0], { key: createHash('sha256').update(replyKey).digest('hex'), kind: 'synthesize', state: 'complete', reserved_micro_usd: Buffer.byteLength(reply.text) * 15 });
    f.store.updateMessage(reply.id, { text: 'Changed fixture reply' });
    const conflict = await f.native('/v1/speech/' + reply.id); assert.equal(conflict.status, 409); assert.equal(conflict.json().error, 'speech-key-conflict');
    assert.equal(providerRequests.length, 1); assert.deepEqual(billing(), paid, 'changed text cannot rebill the existing message key');
    f.store.updateMessage(reply.id, { text: reply.text });

    for (const message of negative.filter(message => message.conversationId === child.conversationId && message.state !== 'complete')) f.store.updateMessage(message.id, { state: 'failed' });
    f.store.updateTask(child.id, { state: 'completed' }); f.store.archiveTask(child.id);
    assert.equal((await f.native('/v1/turns', 'POST', { idempotencyKey: 'archived-speech-turn', receiver: { spaceId: child.spaceId, conversationId: child.conversationId, taskId: child.id }, text: 'Must not queue' })).status, 409);
    assert.equal((await f.native('/v1/tasks/' + child.id + '/interrupt', 'POST', { mode: 'task' })).status, 409);
    assert.equal((await f.native('/v1/speech/' + initial.id)).status, 400, 'archive retains instruction provenance, not reply eligibility');
    const archivedReply = await f.native('/v1/speech/' + reply.id); assert.equal(archivedReply.status, 200); assert.deepEqual(archivedReply.bytes, audio.bytes, 'read-only reply speech remains available from retained archived history');
    assert.equal(providerRequests.length, 1); assert.deepEqual(billing(), paid);
    assert.deepEqual(f.store.getMessage(initial.id), initial); assert.deepEqual(f.store.getTaskOrigin(child.id), origin);
    delete f.services.speech;
    assert.equal((await f.native('/v1/speech/' + reply.id)).status, 503, 'missing speech retains the text fallback');
    assert.equal((await f.native('/v1/speech/' + initial.id)).status, 400, 'instruction rejection precedes speech availability');
    assert.equal(f.store.getMessage(reply.id).text, reply.text);
  } finally {
    await speech.close();
    if (previousKey === undefined) delete process.env['OPENAI_API_KEY']; else process.env['OPENAI_API_KEY'] = previousKey;
    await f.close();
  }
});

test('longpoll reports real revisions, handles independent SQLite writers and rechecks revoked subscriptions', async () => {
  const f = await fixture();
  try {
    const revision = f.store.revision;
    const pending = f.native('/v1/events?after=' + revision);
    await new Promise(resolve => setTimeout(resolve, 60));
    const other = new WorkspaceStore(join(f.directory, 'workspace.sqlite')); other.createProject({ name: 'Independent writer', purpose: '' }); other.close();
    const result = await pending; assert.equal(result.status, 200); assert.equal(result.json().revision, revision + 1);
    const reconnect = await f.native('/v1/events?after=0'); assert.equal(reconnect.json().revision, revision + 1);
    const revoked = f.native('/v1/events?after=' + f.store.revision); await new Promise(resolve => setTimeout(resolve, 60)); f.auth.revoke(f.paired.clientId); f.store.createProject({ name: 'Wake poll', purpose: '' }); assert.equal((await revoked).status, 401);
    assert.equal((await f.native('/v1/events?after=-1', 'GET', undefined, null)).status, 401);
  } finally { await f.close(); }
});

/** This engine exercises the REAL broker and HTTP fencing, not actual apps/agents. */
class HttpFixtureEngine implements EnvironmentEngine {
  async readiness() { return { id: 'test-environment-fixture', state: 'ready' as const, detail: 'Not actual environment proof' }; }
  async create(_e: ManagedEnvironment) { return 'a'.repeat(64); }
  async start() { /* test acknowledgement */ }
  async stopAndVerify() { /* test acknowledgement */ }
  async remove() { /* test acknowledgement */ }
  async removeVolume() { /* test acknowledgement */ }
  async tool(_e: ManagedEnvironment, operation: string) {
    if (operation === 'frame') { const png = Buffer.alloc(64); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png); return { pngBase64: png.toString('base64'), width: 1280, height: 800 }; }
    if (operation === 'output') return { output: 'real broker fixture PTY output\n<script>unsafe text</script>' };
    return {};
  }
}

test('booted server + actual broker derive owner-only input, binary PNG identity, plain terminal and confirmed full-reset control (engine fixture)', async () => {
  const f = await fixture(); const broker = new EnvironmentBroker(join(f.directory, 'environments'), new HttpFixtureEngine());
  try {
    f.services.environment = broker;
    const task = f.store.createTask({ idempotencyKey: 'tools-task', spaceId: 'overview', title: 'Tools test', prompt: 'Fixture', runtime: 'fixture', model: '', effort: '' });
    const env = await broker.create(task.id); f.store.updateTask(task.id, { environmentId: env.environmentId });
    const view = broker.views()[0]!;
    const frame = await f.native('/v1/tasks/' + task.id + '/frame?view=' + encodeURIComponent(view.id)); assert.equal(frame.status, 200); assert.equal(frame.headers['content-type'], 'image/png'); assert.deepEqual(frame.bytes.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const identity = JSON.parse(String(frame.headers['x-frame-identity'])) as { environmentId: string; leaseEpoch: number }; assert.equal(identity.environmentId, env.environmentId);
    const terminal = await f.native('/v1/tasks/' + task.id + '/terminal'); assert.match(String(terminal.headers['content-type']), /text\/plain/); assert.match(terminal.bytes.toString(), /fixture PTY/);
    const path = '/v1/tasks/' + task.id;
    const initialControl = (await f.native(path + '/control')).json(); assert.equal(initialControl.owner, 'agent'); assert.equal(initialControl.epoch, identity.leaseEpoch);
    const handoff = (await f.native(path + '/control', 'POST', { action: 'take', expectedEpoch: identity.leaseEpoch, confirmReset: false })).json(); assert.equal(handoff.owner, 'handoff'); assert.equal(broker.snapshot(task.id).lease.owner, 'agent');
    const owned = (await f.native(path + '/control', 'POST', { action: 'take', expectedEpoch: identity.leaseEpoch, confirmReset: true })).json(); assert.equal(owned.owner, 'owner');
    const currentView = broker.views()[0]!;
    const input = { taskId: task.id, environmentId: env.environmentId, viewId: currentView.id, generation: currentView.generation, leaseEpoch: owned.epoch, kind: 'text', x: 0, y: 0, key: '', button: '', text: 'Fixture input' };
    assert.equal((await f.native(path + '/input', 'POST', input)).status, 200);
    assert.equal((await f.native(path + '/input', 'POST', { ...input, role: 'agent' })).status, 400);
    assert.equal((await f.native(path + '/input', 'POST', { ...input, generation: view.generation })).status, 409);
    assert.equal((await f.native(path + '/input', 'POST', { ...input, taskId: 'forged-task' })).status, 409);
    assert.equal((await f.native(path + '/control', 'POST', { action: 'resume', expectedEpoch: owned.epoch, confirmReset: true })).json().owner, 'agent');
    assert.equal((await f.native(path + '/input', 'POST', input)).status, 409);
    const leaseBeforeStop = broker.snapshot(task.id).lease;
    await broker.owner().stop(task.id, leaseBeforeStop.epoch, true);
    assert.equal((await f.native(path + '/frame?view=' + encodeURIComponent(view.id))).status, 503);
    const stoppedControl = (await f.native(path + '/control')).json(); assert.equal(stoppedControl.epoch, broker.snapshot(task.id).lease.epoch); assert.equal(stoppedControl.owner, 'handoff');
    assert.equal((await f.native(path + '/interrupt', 'POST', { mode: 'task' })).json().state, 'uncertain');
  } finally { broker.close(); await f.close(); }
});

test('native evidence is typed, bounded and contains no arbitrary credentials/audio fields', async () => {
  const f = await fixture();
  try {
    const recorded: unknown[] = [];
    f.services.telemetry = { record: async (evidence, owner) => { recorded.push({ evidence, owner }); } };
    const evidence = { sessionId: 'fixture-session', unity: 'fixture-version', mode: 'VR', frameCount: 10, unscaledFrameSeconds: 0.01, spaceId: 'overview', taskId: null, viewId: null, microphoneEnabled: false, captureAllowed: false, metrics: { timingAvailable: false, samples: 0, cpuP95Ms: 0, gpuP95Ms: 0, allocatedBytes: 1000 } };
    assert.equal((await f.native('/v1/telemetry', 'POST', evidence)).status, 202); assert.equal(recorded.length, 1);
    assert.equal((await f.native('/v1/telemetry', 'POST', { ...evidence, metrics: { ...evidence.metrics, providerToken: 'do-not-export' } })).status, 400);
    assert.equal((await f.native('/v1/telemetry', 'POST', { ...evidence, wavBase64: wav().toString('base64') })).status, 400); assert.equal(recorded.length, 1);
    delete f.services.telemetry;
    assert.equal((await f.native('/v1/telemetry', 'POST', evidence)).status, 503);
  } finally { await f.close(); }
});

test('GET inbox/snapshot refresh producer review versions, while stale POST decisions never refresh or execute', async () => {
  const f = await fixture();
  try {
    const request = f.store.createInboxRequest({ spaceId: 'overview', taskId: null, kind: 'review', title: 'Fixture review', detail: '', evidence: ['old'] });
    let refreshes = 0;
    f.services.execution!.refreshReviews = () => { refreshes++; if (f.store.getInboxRequest(request.id).version === 1) f.store.updateInboxRequest(request.id, 1, { evidence: ['new'] }); };
    assert.equal((await f.native('/v1/inbox')).status, 200); assert.equal(refreshes, 1); assert.equal(f.store.getInboxRequest(request.id).version, 2);
    assert.equal((await f.native('/v1/inbox/' + request.id + '/respond', 'POST', { version: 1, action: 'review', text: 'old decision' })).status, 409);
    assert.equal(refreshes, 1); assert.equal(f.decided.length, 0);
    assert.equal((await f.native('/v1/snapshot')).status, 200); assert.equal(refreshes, 2);
  } finally { await f.close(); }
});

test('missing verified archive reader blocks voice capture/provider and control when retained coordinator history exists', async () => {
  const f = await fixture();
  try {
    delete f.services.lifecycle;
    const project = f.store.createProject({ name: 'Retained cutoff scope fixture', purpose: '' }), space = f.store.getSpace(project.rootSpaceId);
    const receiver = { spaceId: space.id, conversationId: space.conversationId, taskId: null };
    const submission = f.store.submitTurn('cutoff-fixture', receiver, 'Terminal fixture');
    f.store.updateSubmission(submission.id, { state: 'settled', coordinatorTaskId: 'fixture-coordinator', runId: 'fixture-run' });
    f.store.updateMessage(submission.messageId, { state: 'complete' });
    let paid = 0; f.services.speech!.transcribe = async () => { paid++; return 'must not run'; };
    assert.equal((await f.native('/v1/voice', 'POST', { idempotencyKey: 'prepared-voice', receiver, wavBase64: wav().toString('base64') })).status, 409);
    assert.equal(paid, 0); assert.equal(f.store.getVoiceIntent('prepared-voice'), undefined);
    assert.equal((await f.native('/v1/history/export')).status, 200);
    assert.equal((await f.native('/v1/archive/space/overview', 'POST', {})).status, 400);
  } finally { await f.close(); }
});

test('owner source upload is durable/scoped and archive removes only safe destinations while retaining full history', async () => {
  const f = await fixture();
  try {
    const project = f.store.createProject({ name: 'Archive fixture', purpose: '' });
    const other = f.store.createProject({ name: 'Unrelated source fixture', purpose: '' });
    const source = await f.native('/v1/spaces/' + project.rootSpaceId + '/sources', 'POST', { name: '<script>Literal</script>', text: 'Explicit owner-uploaded content', provenance: 'Test owner fixture, not business data' });
    assert.equal(source.status, 201); assert.equal('text' in source.json(), false);
    const id = source.json().id as string;
    assert.equal((await f.native('/v1/sources/' + id + '?space=' + project.rootSpaceId)).json().text, 'Explicit owner-uploaded content');
    assert.equal((await f.native('/v1/sources/' + id + '?space=' + other.rootSpaceId)).status, 404);
    assert.equal((await f.native('/v1/spaces/' + project.rootSpaceId + '/sources', 'POST', { name: 'forged', text: 'x', provenance: 'fixture', owner: true })).status, 400);
    assert.equal((await f.native('/v1/archive/project/' + project.id, 'POST', {})).status, 200);
    const snap = (await f.native('/v1/snapshot')).json() as unknown as Snapshot;
    assert.equal(snap.projects.some(p => p.id === project.id), false); assert.equal(snap.projects.some(p => p.id === other.id), true);
    assert.equal((await f.native('/v1/spaces/' + project.rootSpaceId + '/sources')).status, 409);
    const history = (await f.native('/v1/history/export')).json();
    assert.equal((history.sources as { text: string }[])[0]?.text, 'Explicit owner-uploaded content');
    assert.equal((history.archives as unknown[]).length > 0, true);
    assert.equal((await f.native('/v1/archive/space/overview', 'POST', {})).status, 400);
    const work = f.store.submitTurn('archive-work', { spaceId: other.rootSpaceId, conversationId: f.store.getSpace(other.rootSpaceId).conversationId, taskId: null }, 'Completed fixture turn');
    f.store.updateMessage(work.messageId, { state: 'complete' }); f.store.updateSubmission(work.id, { state: 'settled' });
    delete f.services.lifecycle;
    assert.equal((await f.native('/v1/archive/project/' + other.id, 'POST', {})).status, 503, 'history-backed archive cannot bypass the missing shared admission fence');
    let fenced = false;
    f.services.lifecycle = { readiness: () => ({ id: 'archive-fixture', state: 'ready', detail: 'Fixture only' }), assertDestinationAvailable() {}, archive: async (receivers, _owner, commit, product) => { assert.equal(receivers[0]?.spaceId, other.rootSpaceId); assert.deepEqual(product, { kind: 'project', id: other.id }); fenced = true; return commit(); } };
    assert.equal((await f.native('/v1/archive/project/' + other.id, 'POST', {})).status, 200); assert.equal(fenced, true);
  } finally { await f.close(); }
});

test('voice intent rejects changed retry before transcription and preserves its original recipient after lost provider acknowledgement', async () => {
  const f = await fixture();
  try {
    let calls = 0; f.services.speech!.transcribe = async (_audio, context) => { calls++; assert.match(context!.idempotencyKey, /^voice:[a-f0-9]{64}$/); throw new Error('Fixture lost transcription ack'); };
    const request = { idempotencyKey: 'captured-before-paid-call', receiver: target, wavBase64: wav().toString('base64') };
    assert.equal((await f.native('/v1/voice', 'POST', request)).status, 500); assert.equal(calls, 1);
    const project = f.store.createProject({ name: 'Other voice context', purpose: '' });
    const space = f.store.getSpace(project.rootSpaceId);
    assert.equal((await f.native('/v1/voice', 'POST', { ...request, receiver: { spaceId: space.id, conversationId: space.conversationId, taskId: null } })).status, 409);
    const changed = wav(); changed[44] = 1;
    assert.equal((await f.native('/v1/voice', 'POST', { ...request, wavBase64: changed.toString('base64') })).status, 409);
    assert.equal(calls, 1);
    assert.equal((await f.native('/v1/turns', 'POST', { idempotencyKey: request.idempotencyKey, receiver: target, text: 'Reuse voice identity as text' })).status, 409);
    assert.deepEqual(f.store.getVoiceIntent(request.idempotencyKey)?.receiver, target);
  } finally { await f.close(); }
});
