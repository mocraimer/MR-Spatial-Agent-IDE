import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import { AuthenticationError, type HostCertificate, PairingAuthority, trustedConsoleRequest } from './auth.js';
import { EnvironmentError, type EnvironmentSnapshot, type OwnerTaskTools, type TaskFrame } from './environment-broker.js';
import { PROTOCOL_VERSION, type ApiError, type Conversation, type InboxRequest, type Point, type ReadinessItem, type Receiver, type Snapshot, type TaskInput, type TaskWindow, type ToolView, type WindowLayout } from './protocol.js';
import { type SubmissionAcknowledgement } from './responses.js';
import { StoreError, WorkspaceStore, type InboxAction, type Submission } from './store.js';
import { companionHtml, companionScript, companionStyle } from './companion.js';
import { SpeechError } from './speech.js';
import { archiveReceivers, assertArchiveDestinationAvailable, type ArchiveProduct } from './lifecycle.js';

/** Derived only by the HTTP boundary. Tokens are never passed to providers or model tools. */
export interface HostOwner { clientId: string; surface: 'native' | 'console' }
export type RuntimeSettings = Pick<Conversation, 'runtime' | 'model' | 'effort'>;
export interface OwnerDecision { action: InboxAction; text: string; idempotencyKey: string; authorityId?: string; authorityVersion?: number }
export interface NativeEvidence {
  sessionId: string; unity: string; mode: 'VR' | 'MR'; frameCount: number; unscaledFrameSeconds: number;
  spaceId: string; taskId: string | null; viewId: string | null; microphoneEnabled: boolean; captureAllowed: boolean;
  metrics: { timingAvailable: boolean; samples: number; cpuP95Ms: number; gpuP95Ms: number; allocatedBytes: number };
}
export interface HostServices {
  execution?: {
    readiness(): Promise<ReadinessItem[]>;
    /** Read/update-only producer refresh. Never call during an owner decision. */
    refreshReviews?(): void;
    validateSettings(settings: RuntimeSettings, owner: HostOwner): Promise<void>;
    queue(submission: Submission, owner: HostOwner): Promise<void>;
    interrupt(task: TaskWindow, mode: 'turn' | 'task', owner: HostOwner): Promise<{ state: string; detail: string }>;
    /** Must atomically check current coordinator authority/evidence and deduplicate effects. */
    decide(request: InboxRequest, decision: OwnerDecision, owner: HostOwner): Promise<ReturnType<WorkspaceStore['respondInbox']> | void>;
  };
  environment?: {
    readiness(): Promise<ReadinessItem>;
    views(): ToolView[];
    snapshots(): EnvironmentSnapshot[];
    frame(taskId: string, viewId: string): Promise<TaskFrame>;
    terminal(taskId: string): Promise<string>;
    owner(): OwnerTaskTools;
  };
  speech?: {
    readiness(): Promise<ReadinessItem[]>;
    transcribe(wav: Buffer, context?: { idempotencyKey: string }): Promise<string>;
    synthesize(text: string, context?: { idempotencyKey: string }): Promise<Buffer>;
  };
  lifecycle?: {
    readiness(): ReadinessItem;
    /** Must retain the shared admission fence through commit, not merely inspect then await. */
    archive(receivers: readonly Receiver[], owner: HostOwner, commit: () => import('./store.js').ArchiveRecord, product: ArchiveProduct): Promise<import('./store.js').ArchiveRecord>;
    assertDestinationAvailable(receiver: Receiver): void;
  };
  telemetry?: { record(evidence: NativeEvidence, owner: HostOwner): Promise<void> };
}
export interface HostServerOptions { store: WorkspaceStore; auth: PairingAuthority; certificate: HostCertificate; services: HostServices }
export class HostApiError extends Error {
  constructor(public readonly status: number, public readonly code: string, detail: string, public readonly recovery: string) { super(detail); }
}
function unavailable(capability: string): never { throw new HostApiError(503, 'capability-unavailable', `${capability} is not configured.`, 'Open host setup, configure the missing provider/capability, then retry. No effect is assumed complete.'); }
function invalid(detail: string): never { throw new HostApiError(400, 'invalid-request', detail, 'Correct the request using the version 1 client contract.'); }
type Json = Record<string, unknown>;
function object(value: unknown): Json { if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('A JSON object is required.'); return value as Json; }
function fields(body: Json, allowed: string[]): void { if (Object.keys(body).some(key => !allowed.includes(key))) invalid('Unknown or privileged request field.'); }
function text(body: Json, key: string, max = 65536, empty = false): string {
  const value = body[key];
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim())) invalid(`${key} must be a ${empty ? 'bounded' : 'nonempty bounded'} string.`);
  return value;
}
function nullableId(body: Json, key: string): string | null { return body[key] === null ? null : text(body, key, 256); }
function integer(value: unknown, field: string, max = Number.MAX_SAFE_INTEGER): number { if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > max) invalid(`${field} must be a nonnegative bounded integer.`); return value as number; }
function point(value: unknown): Point { const b = object(value); fields(b, ['x', 'y', 'z']); if (![b.x, b.y, b.z].every(v => typeof v === 'number' && Number.isFinite(v))) invalid('Coordinates must be finite numbers.'); return { x: b.x as number, y: b.y as number, z: b.z as number }; }
function receiver(value: unknown): Receiver { const b = object(value); fields(b, ['spaceId', 'conversationId', 'taskId']); return { spaceId: text(b, 'spaceId', 256), conversationId: text(b, 'conversationId', 256), taskId: nullableId(b, 'taskId') }; }
function settings(b: Json): RuntimeSettings { return { runtime: text(b, 'runtime', 256, true), model: text(b, 'model', 256, true), effort: text(b, 'effort', 256, true) }; }
function ack(s: Submission): SubmissionAcknowledgement { return { requestId: s.id, conversationId: s.receiver.conversationId, taskId: s.receiver.taskId, state: s.state, detail: s.detail }; }

/** PCM mono, 16-bit, 16kHz, 0 < duration <= 30s. No raw audio is retained. */
export function validateVoiceWav(wav: Buffer): void {
  if (wav.length < 46 || wav.length > 960044 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.readUInt32LE(4) !== wav.length - 8 || wav.toString('ascii', 8, 12) !== 'WAVE') invalid('Supply a bounded PCM WAV recording (maximum 30 seconds).');
  let format = false, data = false;
  for (let offset = 12; offset + 8 <= wav.length;) {
    const name = wav.toString('ascii', offset, offset + 4), size = wav.readUInt32LE(offset + 4), start = offset + 8;
    if (start + size > wav.length) invalid('WAV chunk is truncated.');
    if (name === 'fmt ') {
      if (format || size !== 16 || wav.readUInt16LE(start) !== 1 || wav.readUInt16LE(start + 2) !== 1 || wav.readUInt32LE(start + 4) !== 16000 || wav.readUInt32LE(start + 8) !== 32000 || wav.readUInt16LE(start + 12) !== 2 || wav.readUInt16LE(start + 14) !== 16) invalid('Voice requires mono 16kHz 16-bit PCM WAV.');
      format = true;
    } else if (name === 'data') { if (data || size < 2 || size > 960000 || size % 2) invalid('Invalid audio sample duration.'); data = true; }
    else invalid('Only PCM format and audio data chunks are accepted.');
    offset = start + size + (size % 2);
    if (offset === wav.length) { if (format && data) return; break; }
  }
  invalid('WAV needs complete PCM format and sample chunks.');
}
function validReplyWav(wav: Buffer): boolean {
  if (wav.length < 46 || wav.length > 8000000 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.readUInt32LE(4) !== wav.length - 8 || wav.toString('ascii', 8, 12) !== 'WAVE') return false;
  let rate = 0, channels = 0, dataSize = 0;
  for (let offset = 12; offset + 8 <= wav.length;) {
    const name = wav.toString('ascii', offset, offset + 4), size = wav.readUInt32LE(offset + 4), start = offset + 8;
    if (start + size > wav.length) return false;
    if (name === 'fmt ') {
      if (rate !== 0 || size < 16 || wav.readUInt16LE(start) !== 1 || wav.readUInt16LE(start + 14) !== 16) return false;
      channels = wav.readUInt16LE(start + 2); rate = wav.readUInt32LE(start + 4);
      if (channels < 1 || channels > 2 || rate < 8000 || rate > 96000 || wav.readUInt16LE(start + 12) !== channels * 2 || wav.readUInt32LE(start + 8) !== rate * channels * 2) return false;
    } else if (name === 'data') { if (dataSize !== 0 || size === 0) return false; dataSize = size; }
    offset = start + size + (size % 2);
    if (offset === wav.length) return rate > 0 && dataSize > 0 && dataSize % (channels * 2) === 0 && dataSize / (rate * channels * 2) <= 120;
  }
  return false;
}
export function isGlobalInboxCommand(transcript: string): boolean { return transcript.trim().toLowerCase().replace(/\s+/g, ' ') === 'open my global inbox'; }
async function bounded<T>(operation: Promise<T>, duration = 30000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try { return await Promise.race([operation, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new HostApiError(504, 'acknowledgement-timeout', 'Provider acknowledgement timed out; effects may be uncertain.', 'Refresh retained state. Do not automatically replay a consequential operation.')), duration); })]); }
  finally { clearTimeout(timer); }
}
const parsedBodies = new WeakMap<IncomingMessage, Json>();
async function body(req: IncomingMessage, max = 131072): Promise<Json> {
  const parsed = parsedBodies.get(req);
  if (parsed) return parsed;
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) throw new HostApiError(415, 'content-type', 'JSON Content-Type is required.', 'Send application/json.');
  if (Number(req.headers['content-length'] ?? 0) > max) { req.resume(); throw new HostApiError(413, 'body-too-large', 'Request exceeds the bounded body limit.', 'Shorten the text or recording and retry.'); }
  const chunks: Buffer[] = []; let size = 0;
  const timeout = setTimeout(() => req.destroy(), 10000);
  try {
    for await (const chunk of req) { const b = Buffer.from(chunk as Buffer); size += b.length; if (size > max) { req.resume(); throw new HostApiError(413, 'body-too-large', 'Request exceeds the bounded body limit.', 'Shorten the text or recording and retry.'); } chunks.push(b); }
    try { return object(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (error) { if (error instanceof HostApiError) throw error; invalid('Malformed JSON.'); }
  } finally { clearTimeout(timeout); }
}
function send(res: ServerResponse, status: number, value: unknown, mime = 'application/json; charset=utf-8'): void {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'Content-Type': mime }); res.end(mime.startsWith('application/json') ? JSON.stringify(value) : value);
}
function report(res: ServerResponse, error: unknown): void {
  let status = 500; let value: ApiError = { error: 'host-error', detail: 'The host could not acknowledge this operation.', recovery: 'Check host storage/provider readiness and refresh retained state. Do not assume effects stopped or replay uncertain work.' };
  if (error instanceof HostApiError || error instanceof SpeechError) { status = error.status; value = { error: error.code, detail: error.message, recovery: error.recovery }; }
  else if (error instanceof StoreError) { status = { invalid: 400, not_found: 404, stale: 409, conflict: 409 }[error.code]; value = { error: error.code, detail: error.message, recovery: 'Refresh the current destination, version and evidence before retrying.' }; }
  else if (error instanceof AuthenticationError) { status = error.code === 'pairing-rate-limited' ? 429 : 401; value = { error: error.code, detail: error.message, recovery: 'Use trusted host setup to pair again.' }; }
  else if (error instanceof EnvironmentError) { status = /stale|active|control/.test(error.code) ? 409 : /invalid/.test(error.code) ? 400 : 503; value = { error: error.code, detail: error.message, recovery: error.recovery }; }
  // Unknown provider errors may contain credentials; never echo them or log request bodies.
  send(res, status, value);
}

/** Both listeners share durable product state; only HTTPS accepts native credentials. */
export function createHostServer(options: HostServerOptions) {
  const { store, auth, certificate, services } = options;
  const decisions = new Set<string>();
  const queueing = new Set<string>();
  let consolePort = 0;
  const polls = new Set<() => void>();
  const execution = () => services.execution ?? unavailable('Coordinator execution');
  const environment = () => services.environment ?? unavailable('Task environment');
  const speech = () => services.speech ?? unavailable('Speech');
  async function snapshot(): Promise<Snapshot> {
    services.execution?.refreshReviews?.();
    const readiness: ReadinessItem[] = (await Promise.all(([
      ['execution', services.execution && (() => services.execution!.readiness())],
      ['environment', services.environment && (async () => [await services.environment!.readiness()])],
      ['speech', services.speech && (() => services.speech!.readiness())],
    ] as const).map(async ([id, provider]): Promise<ReadinessItem[]> => {
      if (!provider) return [{ id, state: 'missing', detail: `Configure ${id} in host setup; this capability is unavailable.` }];
      try { return await bounded(provider(), 5000); }
      catch { return [{ id, state: 'blocked', detail: `${id} readiness could not be checked. Inspect the provider and retry.` }]; }
    }))).flat();
    const result = store.snapshot();
    result.readiness = readiness;
    try { result.readiness.push(services.lifecycle?.readiness() ?? { id: 'history-archive', state: 'blocked', detail: 'Nonempty history archive and its cutoff reader need the explicitly verified coordinator/owner activation. Empty product archives remain direct.' }); }
    catch { result.readiness.push({ id: 'history-archive', state: 'blocked', detail: 'Fresh coordinator archive activation could not be verified. History remains retained.' }); }
    if (services.environment) {
      try { result.views = services.environment.views().filter(view => result.tasks.some(task => task.id === view.taskId && task.environmentId === view.environmentId)); }
      catch { result.readiness.push({ id: 'environment-views', state: 'blocked', detail: 'Task views are unavailable. Inspect the environment provider and refresh; retained product history remains available.' }); }
    }
    return result;
  }
  function stillAuthenticated(req: IncomingMessage, owner: HostOwner): void {
    const client = owner.surface === 'console' ? auth.authenticate(`Bearer ${auth.companionSession().token}`) : auth.authenticate(req.headers.authorization);
    if (!client || client.id !== owner.clientId) throw new HostApiError(401, 'not-paired', 'This device is unpaired or revoked.', 'Pair again from trusted host setup.');
  }
  function assertDestination(target: Receiver): void {
    assertArchiveDestinationAvailable(store, target, services.lifecycle);
  }
  function assertSpace(spaceId: string): void {
    const space = store.getSpace(spaceId);
    assertDestination({ spaceId, conversationId: space.conversationId, taskId: null });
  }
  async function queue(submission: Submission, owner: HostOwner): Promise<void> {
    if (submission.state !== 'queued' || queueing.has(submission.id)) return;
    assertDestination(submission.receiver);
    queueing.add(submission.id);
    try { await bounded(execution().queue(submission, owner)); } finally { queueing.delete(submission.id); }
  }
  async function wait(_req: IncomingMessage, res: ServerResponse, after: number): Promise<void> {
    if (store.revision !== after) return;
    await new Promise<void>(resolve => {
      let done = false;
      const finish = () => { if (done) return; done = true; clearTimeout(timer); clearInterval(interval); unsubscribe(); polls.delete(finish); res.off('close', finish); resolve(); };
      const unsubscribe = store.subscribe(finish);
      const timer = setTimeout(finish, 20000);
      polls.add(finish); res.once('close', finish);
      // Poll revisions too: another SQLite writer does not trigger in-process listeners.
      const interval = setInterval(() => { if (store.revision !== after) finish(); }, 250);
    });
  }
  async function routes(req: IncomingMessage, res: ServerResponse, owner: HostOwner, url: URL): Promise<void> {
    const path = url.pathname, method = req.method ?? 'GET';
    if (req.headers['x-protocol-version'] !== undefined && req.headers['x-protocol-version'] !== String(PROTOCOL_VERSION)) throw new HostApiError(426, 'protocol-version', 'Host requires protocol version 1.', 'Update the host and client together.');
    if (method === 'GET' && (path === '/v1/snapshot' || path === '/v1/events')) {
      if (path.endsWith('/events')) { const after = integer(Number(url.searchParams.get('after') ?? NaN), 'after'); await wait(req, res, after); }
      stillAuthenticated(req, owner); return send(res, 200, await snapshot());
    }
    if (method === 'GET' && path === '/v1/environments') return send(res, 200, environment().snapshots());
    if (method === 'GET' && path === '/v1/inbox') { services.execution?.refreshReviews?.(); return send(res, 200, store.listInboxRequests()); }
    if (method === 'GET' && path === '/v1/history/archives') return send(res, 200, store.listArchives());
    if (method === 'GET' && path === '/v1/history/export') return send(res, 200, store.exportHistory());
    const sources = /^\/v1\/spaces\/([^/]+)\/sources$/.exec(path);
    if (sources) {
      const spaceId = decodeURIComponent(sources[1]!);
      assertSpace(spaceId);
      if (method === 'GET') return send(res, 200, store.listSources(spaceId));
      if (method === 'POST') {
        const b = await body(req, 8000000); fields(b, ['name', 'text', 'provenance']);
        return send(res, 201, store.registerSource({ spaceId, name: text(b, 'name', 256), text: text(b, 'text', 1048576, true), provenance: text(b, 'provenance', 4096) }));
      }
    }
    const source = /^\/v1\/sources\/([^/]+)$/.exec(path);
    if (source && method === 'GET') {
      const spaceId = url.searchParams.get('space'); if (!spaceId) invalid('space is required for source scope.');
      assertSpace(spaceId);
      return send(res, 200, store.readSourceForSpace(spaceId, decodeURIComponent(source[1]!)));
    }
    const archive = /^\/v1\/archive\/(project|space|task|link)\/([^/]+)$/.exec(path);
    if (archive && method === 'POST') {
      const b = await body(req); fields(b, []);
      const kind = archive[1]!, id = decodeURIComponent(archive[2]!);
      if (kind === 'link') return send(res, 200, store.unlinkSpaceLink(id));
      const product: ArchiveProduct = { kind: kind as ArchiveProduct['kind'], id };
      const receivers = archiveReceivers(store, product);
      const conversationIds = new Set(receivers.map(receiver => receiver.conversationId));
      const hasWork = receivers.some(receiver => receiver.taskId !== null) || store.exportHistory().submissions.some(submission => conversationIds.has(submission.receiver.conversationId));
      const commit = () => { stillAuthenticated(req, owner); return kind === 'project' ? store.archiveProject(id) : kind === 'space' ? store.archiveSpace(id) : store.archiveTask(id); };
      if (hasWork && !services.lifecycle) unavailable('Coordinator-fenced history archive');
      return send(res, 200, hasWork ? await bounded(services.lifecycle!.archive(receivers, owner, commit, product)) : commit());
    }
    const conversation = /^\/v1\/conversations\/([^/]+)\/(messages|settings)$/.exec(path);
    if (conversation) {
      const id = decodeURIComponent(conversation[1]!);
      if (method === 'GET' && conversation[2] === 'messages') return send(res, 200, store.listMessages(id, { ...(url.searchParams.has('before') ? { before: url.searchParams.get('before')! } : {}), ...(url.searchParams.has('limit') ? { limit: integer(Number(url.searchParams.get('limit')), 'limit', 500) } : {}) }));
      if (method === 'PATCH' && conversation[2] === 'settings') { const b = await body(req); fields(b, ['runtime', 'model', 'effort']); const s = settings(b), current = store.getConversation(id), target = { spaceId: current.spaceId, conversationId: id, taskId: current.taskId }; assertDestination(target); await bounded(execution().validateSettings(s, owner)); stillAuthenticated(req, owner); assertDestination(target); return send(res, 200, store.updateConversationSettings(id, s)); }
    }
    if (method === 'POST' && path === '/v1/projects') { const b = await body(req); fields(b, ['name', 'purpose']); return send(res, 201, store.createProject({ name: text(b, 'name', 256), purpose: text(b, 'purpose', 16384, true) })); }
    const project = /^\/v1\/projects\/([^/]+)$/.exec(path);
    if (project && method === 'PATCH') { const b = await body(req); fields(b, ['name', 'purpose']); const id = decodeURIComponent(project[1]!); assertSpace(store.getProject(id).rootSpaceId); return send(res, 200, store.updateProject(id, { ...(b.name !== undefined ? { name: text(b, 'name', 256) } : {}), ...(b.purpose !== undefined ? { purpose: text(b, 'purpose', 16384, true) } : {}) })); }
    if (method === 'POST' && path === '/v1/spaces') { const b = await body(req); fields(b, ['projectId', 'parentId', 'name', 'purpose', 'position']); if (b.projectId !== null) assertSpace(store.getProject(text(b, 'projectId', 256)).rootSpaceId); if (b.parentId !== null) assertSpace(text(b, 'parentId', 256)); return send(res, 201, store.createSpace({ projectId: nullableId(b, 'projectId'), parentId: nullableId(b, 'parentId'), name: text(b, 'name', 256), purpose: text(b, 'purpose', 16384, true), ...(b.position !== undefined ? { position: point(b.position) } : {}) })); }
    const space = /^\/v1\/spaces\/([^/]+)$/.exec(path);
    if (space && method === 'PATCH') { const b = await body(req); fields(b, ['name', 'purpose', 'position', 'parentId']); const id = decodeURIComponent(space[1]!); assertSpace(id); if (b.parentId !== undefined && b.parentId !== null) assertSpace(text(b, 'parentId', 256)); return send(res, 200, store.updateSpace(id, { ...(b.name !== undefined ? { name: text(b, 'name', 256) } : {}), ...(b.purpose !== undefined ? { purpose: text(b, 'purpose', 16384, true) } : {}), ...(b.parentId !== undefined ? { parentId: nullableId(b, 'parentId') } : {}), ...(b.position !== undefined ? { position: point(b.position) } : {}) })); }
    if (method === 'POST' && path === '/v1/links') { const b = await body(req); fields(b, ['fromId', 'toId', 'label']); assertSpace(text(b, 'fromId', 256)); assertSpace(text(b, 'toId', 256)); return send(res, 201, store.createLink({ fromId: text(b, 'fromId', 256), toId: text(b, 'toId', 256), label: text(b, 'label', 256, true) })); }
    if (method === 'POST' && path === '/v1/tasks') {
      const b = await body(req); fields(b, ['idempotencyKey', 'spaceId', 'title', 'prompt', 'runtime', 'model', 'effort', 'parentTaskId']);
      const s = settings(b), key = text(b, 'idempotencyKey', 256), spaceId = text(b, 'spaceId', 256);
      assertSpace(spaceId);
      if (b.parentTaskId !== undefined && b.parentTaskId !== null) { const parent = store.getTask(text(b, 'parentTaskId', 256)); assertDestination({ spaceId: parent.spaceId, conversationId: parent.conversationId, taskId: parent.id }); }
      if (store.getVoiceIntent(key)) throw new StoreError('conflict', 'This request key already identifies a captured voice turn, not task creation.');
      await bounded(execution().validateSettings(s, owner)); stillAuthenticated(req, owner); assertSpace(spaceId);
      const task = store.createTask({ idempotencyKey: key, spaceId: text(b, 'spaceId', 256), title: text(b, 'title', 256), prompt: text(b, 'prompt'), ...s, ...(b.parentTaskId !== undefined ? { parentTaskId: nullableId(b, 'parentTaskId') } : {}) });
      await queue(store.getSubmissionByKey(key)!, owner); return send(res, 202, store.getTask(task.id));
    }
    if (method === 'POST' && (path === '/v1/turns' || path === '/v1/voice')) {
      const voice = path.endsWith('/voice'); const b = await body(req, voice ? 1300000 : 131072); fields(b, voice ? ['idempotencyKey', 'receiver', 'wavBase64'] : ['idempotencyKey', 'receiver', 'text']);
      const key = text(b, 'idempotencyKey', 256), target = store.validateReceiver(receiver(b.receiver));
      assertDestination(target); // Prepared cutoff is checked before capture and paid transcription.
      let transcript: string;
      if (voice) {
        const encoded = text(b, 'wavBase64', 1280060); if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) invalid('wavBase64 must be canonical base64.');
        const wav = Buffer.from(encoded, 'base64');
        try {
          validateVoiceWav(wav);
          store.captureVoiceIntent(key, target, createHash('sha256').update(wav).digest('hex'));
          transcript = await bounded(speech().transcribe(wav, { idempotencyKey: 'voice:' + createHash('sha256').update(key).digest('hex') }));
        } finally { wav.fill(0); }
        if (typeof transcript !== 'string' || !transcript.trim() || transcript.length > 65536) throw new HostApiError(422, 'no-transcript', 'No usable speech transcript was produced.', 'Try push-to-talk or type your turn.');
      } else { if (store.getVoiceIntent(key)) throw new StoreError('conflict', 'This request key already identifies a captured voice recording; retry voice with the same recipient/recording or use a new explicit text request.'); transcript = text(b, 'text'); }
      stillAuthenticated(req, owner); store.validateReceiver(target); assertDestination(target);
      // Only an authenticated owner's transcription invokes global navigation, never agent text.
      if (voice && isGlobalInboxCommand(transcript)) {
        const previous = store.getSubmissionByKey(key);
        if (previous && !(previous.state === 'settled' && previous.detail === 'open-global-inbox')) throw new StoreError('conflict', 'This idempotency key already identifies an execution request, not navigation.');
        const s = store.submitTurn(key, target, 'open my global inbox');
        if (s.state === 'queued') { store.updateMessage(s.messageId, { state: 'complete' }); store.updateSubmission(s.id, { state: 'settled', detail: 'open-global-inbox' }); }
        return send(res, 200, { ...ack(store.getSubmission(s.id)), state: 'local-command', detail: 'open-global-inbox', transcript });
      }
      if (store.getSubmissionByKey(key)?.detail === 'open-global-inbox') throw new StoreError('conflict', 'This idempotency key already identifies global navigation, not an execution request.');
      const runtime = store.getConversation(target.conversationId);
      await bounded(execution().validateSettings({ runtime: runtime.runtime, model: runtime.model, effort: runtime.effort }, owner)); stillAuthenticated(req, owner);
      assertDestination(target);
      const s = store.submitTurn(key, target, transcript); await queue(s, owner);
      return send(res, 202, { ...ack(store.getSubmission(s.id)), ...(voice ? { transcript } : {}) });
    }
    const taskRoute = /^\/v1\/tasks\/([^/]+)\/(layout|frame|terminal|control|input|interrupt)$/.exec(path);
    if (taskRoute) {
      const task = store.getTask(decodeURIComponent(taskRoute[1]!)), action = taskRoute[2];
      if (method === 'POST' || method === 'PATCH' || action === 'frame' || action === 'terminal') assertDestination({ spaceId: task.spaceId, conversationId: task.conversationId, taskId: task.id });
      if (action === 'layout' && method === 'PATCH') { const b = await body(req); fields(b, ['position', 'rotation', 'scale']); const layout: WindowLayout = { position: point(b.position), rotation: point(b.rotation), scale: point(b.scale) }; return send(res, 200, store.updateTaskLayout(task.id, layout)); }
      if (action === 'frame' && method === 'GET') {
        const viewId = url.searchParams.get('view'); if (!viewId) invalid('view is required.');
        const view = environment().views().find(view => view.id === viewId && view.taskId === task.id && view.environmentId === task.environmentId);
        if (!view) throw new HostApiError(409, 'stale-view', 'View does not belong to the current task environment.', 'Refresh the task and select its current view.');
        const frame = await bounded(environment().frame(task.id, viewId)); stillAuthenticated(req, owner);
        if (frame.identity.environmentId !== task.environmentId || frame.identity.viewId !== viewId || frame.identity.generation !== view.generation || frame.png.length > 16000000 || !frame.png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new HostApiError(502, 'invalid-frame', 'Environment returned a mismatched frame.', 'Refresh the current environment; input remains fenced.');
        res.setHeader('X-Frame-Identity', JSON.stringify(frame.identity)); return send(res, 200, frame.png, 'image/png');
      }
      if (action === 'terminal' && method === 'GET') { const output = await bounded(environment().terminal(task.id)); stillAuthenticated(req, owner); if (Buffer.byteLength(output) > 1048576) throw new HostApiError(502, 'terminal-too-large', 'Terminal output exceeds 1 MiB.', 'Use a bounded terminal provider.'); return send(res, 200, output, 'text/plain; charset=utf-8'); }
      if (action === 'control' && method === 'GET') {
        const current = environment().snapshots().find(item => item.taskId === task.id && item.environmentId === task.environmentId);
        if (!current) throw new HostApiError(409, 'environment-unavailable', 'No current environment lease belongs to this task.', 'Refresh task state; a missing frame is not an owner-control acknowledgement.');
        return send(res, 200, current.lease);
      }
      if (action === 'control' && method === 'POST') { const b = await body(req); fields(b, ['action', 'expectedEpoch', 'confirmReset']); const a = text(b, 'action', 16); if (!['take', 'resume', 'stop'].includes(a)) invalid('Control action is take, resume or stop.'); if (b.confirmReset !== undefined && typeof b.confirmReset !== 'boolean') invalid('confirmReset must be boolean.'); const port = environment().owner(); const epoch = integer(b.expectedEpoch, 'expectedEpoch'); const lease = await bounded(a === 'take' ? port.takeControl(task.id, epoch, b.confirmReset === true) : a === 'resume' ? port.resume(task.id, epoch, b.confirmReset === true) : port.stop(task.id, epoch, b.confirmReset === true)); return send(res, 200, lease); }
      if (action === 'input' && method === 'POST') {
        const b = await body(req); fields(b, ['taskId', 'environmentId', 'viewId', 'generation', 'leaseEpoch', 'kind', 'x', 'y', 'button', 'key', 'text']);
        const kind = text(b, 'kind', 16); if (!['pointer', 'key', 'text'].includes(kind)) invalid('Unsupported input kind.'); if (typeof b.x !== 'number' || typeof b.y !== 'number' || !Number.isFinite(b.x) || !Number.isFinite(b.y)) invalid('Input coordinates must be finite.');
        const input: TaskInput = { taskId: text(b, 'taskId', 256), environmentId: text(b, 'environmentId', 256), viewId: text(b, 'viewId', 512), generation: integer(b.generation, 'generation'), leaseEpoch: integer(b.leaseEpoch, 'leaseEpoch'), kind: kind as TaskInput['kind'], x: b.x, y: b.y, button: text(b, 'button', 16, true), key: text(b, 'key', 80, true), text: text(b, 'text', 65536, true) };
        if (input.taskId !== task.id || input.environmentId !== task.environmentId || !environment().views().some(v => v.taskId === task.id && v.id === input.viewId && v.environmentId === input.environmentId && v.generation === input.generation)) throw new HostApiError(409, 'stale-view', 'Input identity is not current for this task.', 'Refresh the frame and lease; never replay old input.');
        await bounded(environment().owner().input(input)); return send(res, 200, { state: 'acknowledged', detail: 'Owner input acknowledged by the environment.' });
      }
      if (action === 'interrupt' && method === 'POST') { const b = await body(req); fields(b, ['mode']); const mode = text(b, 'mode', 16); if (mode !== 'turn' && mode !== 'task') invalid('Interrupt mode is turn or task.'); return send(res, 200, await bounded(execution().interrupt(task, mode, owner))); }
    }
    const inbox = /^\/v1\/inbox\/([^/]+)\/respond$/.exec(path);
    if (inbox && method === 'POST') {
      const b = await body(req); fields(b, ['version', 'action', 'text', 'idempotencyKey', 'authorityId', 'authorityVersion']); const id = decodeURIComponent(inbox[1]!), version = integer(b.version, 'version'); const request = store.getInboxRequest(id);
      if (request.taskId) { const task = store.getTask(request.taskId); assertDestination({ spaceId: task.spaceId, conversationId: task.conversationId, taskId: task.id }); } else assertSpace(request.spaceId);
      if (request.version !== version) throw new StoreError('stale', 'Inbox evidence changed; reload before deciding.');
      if (!['open', 'deferred'].includes(request.state)) throw new StoreError('conflict', 'This request is already answered.');
      const action = text(b, 'action', 16) as InboxAction, allowed: Record<InboxRequest['kind'], InboxAction[]> = { question: ['answer', 'defer', 'dismiss'], blocker: ['answer', 'defer', 'dismiss'], approval: ['approve', 'defer', 'dismiss'], review: ['review', 'defer', 'dismiss'] };
      if (!allowed[request.kind].includes(action)) invalid('Decision does not match the request kind.');
      const authority = action === 'approve' ? { authorityId: text(b, 'authorityId', 256), authorityVersion: integer(b.authorityVersion, 'authorityVersion') } : {};
      if (action !== 'approve' && (b.authorityId != null || (b.authorityVersion !== undefined && b.authorityVersion !== 0))) invalid('Only confirmation of existing authority accepts receipt identity.');
      const answer = text(b, 'text', 65536, action !== 'answer' && action !== 'dismiss'); const key = b.idempotencyKey === undefined ? `inbox:${id}:${version}:${action}` : text(b, 'idempotencyKey', 256);
      if (decisions.has(id)) throw new HostApiError(409, 'decision-pending', 'A decision is awaiting acknowledgement.', 'Refresh current request state before acting again.');
      decisions.add(id);
      try {
        // Defer/dismiss have no coordinator effect. Confirmation commits both exact owner receipts under the shared fence.
        const committed = action !== 'defer' && action !== 'dismiss' ? await bounded(execution().decide(request, { action, text: answer, idempotencyKey: key, ...authority }, owner)) : undefined;
        stillAuthenticated(req, owner);
        if (action === 'approve') {
          if (!committed) unavailable('Atomic existing-authority confirmation');
          return send(res, 200, committed);
        }
        return send(res, 200, store.respondInbox(id, version, action, answer));
      } finally { decisions.delete(id); }
    }
    const audio = /^\/v1\/speech\/([^/]+)$/.exec(path);
    if (audio && method === 'GET') { const message = store.getMessage(decodeURIComponent(audio[1]!)); if (message.role !== 'agent' || message.origin || message.state !== 'complete' || !message.text.trim()) invalid('Only completed agent replies can be spoken.'); const wav = await bounded(speech().synthesize(message.text, { idempotencyKey: 'speech:' + message.id })); stillAuthenticated(req, owner); if (!validReplyWav(wav)) throw new HostApiError(502, 'invalid-speech', 'Speech provider must return PCM 16-bit WAV, mono/stereo, 8–96kHz, at most 120 seconds and 8 MB.', 'Check speech provider configuration; use the retained text reply.'); return send(res, 200, wav, 'audio/wav'); }
    if (path === '/v1/telemetry' && method === 'POST') {
      const b = await body(req, 16384);
      fields(b, ['sessionId', 'unity', 'mode', 'frameCount', 'unscaledFrameSeconds', 'spaceId', 'taskId', 'viewId', 'microphoneEnabled', 'captureAllowed', 'metrics']);
      const metrics = object(b.metrics); fields(metrics, ['timingAvailable', 'samples', 'cpuP95Ms', 'gpuP95Ms', 'allocatedBytes']);
      function flag(value: unknown): boolean { if (typeof value !== 'boolean') invalid('Telemetry flags must be boolean.'); return value; }
      function measurement(value: unknown): number { if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1000000) invalid('Telemetry measurement is invalid.'); return value; }
      const mode = text(b, 'mode', 2); if (mode !== 'VR' && mode !== 'MR') invalid('Telemetry mode is VR or MR.');
      const evidence: NativeEvidence = {
        sessionId: text(b, 'sessionId', 128), unity: text(b, 'unity', 128), mode, frameCount: integer(b.frameCount, 'frameCount'), unscaledFrameSeconds: measurement(b.unscaledFrameSeconds),
        spaceId: text(b, 'spaceId', 256), taskId: nullableId(b, 'taskId'), viewId: b.viewId === '' ? null : nullableId(b, 'viewId'), microphoneEnabled: flag(b.microphoneEnabled), captureAllowed: flag(b.captureAllowed),
        metrics: { timingAvailable: flag(metrics.timingAvailable), samples: integer(metrics.samples, 'samples', 2200), cpuP95Ms: measurement(metrics.cpuP95Ms), gpuP95Ms: measurement(metrics.gpuP95Ms), allocatedBytes: integer(metrics.allocatedBytes, 'allocatedBytes') },
      };
      store.getSpace(evidence.spaceId);
      if (evidence.taskId !== null && store.getTask(evidence.taskId).spaceId !== evidence.spaceId) invalid('Telemetry task belongs to another space.');
      if (!services.telemetry) unavailable('Native evidence recorder');
      await bounded(services.telemetry.record(evidence, owner));
      return send(res, 202, { state: 'recorded', detail: 'Native evidence retained; not a performance acceptance claim.' });
    }
    if (method === 'DELETE' && /^\/v1\/(projects|spaces|links|conversations)\//.test(path)) throw new HostApiError(501, 'deletion-unavailable', 'Hard deletion is unavailable; history-preserving archive and unlink are supported.', 'Use POST /v1/archive/project|space|task|link/:id after reconciling and stopping affected work; retained history is never silently deleted.');
    throw new HostApiError(404, 'route-not-found', 'No such version 1 route.', 'Check the client API and host version.');
  }
  async function handle(req: IncomingMessage, res: ServerResponse, surface: HostOwner['surface']): Promise<void> {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    if (surface === 'console') res.setHeader('Permissions-Policy', 'microphone=(), camera=()');
    try {
      const url = new URL(req.url ?? '/', 'https://host.invalid');
      if (surface === 'console') {
        if (!trustedConsoleRequest(req.socket.remoteAddress, req.headers.host, req.headers.origin, consolePort)) throw new HostApiError(403, 'untrusted-console', 'Owner setup requires a trusted loopback request.', 'Open the localhost console directly, not through a remote page or proxy.');
        res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
        if (req.method === 'GET' && url.pathname === '/') return send(res, 200, companionHtml, 'text/html; charset=utf-8');
        if (req.method === 'GET' && url.pathname === '/companion.js') return send(res, 200, companionScript, 'text/javascript; charset=utf-8');
        if (req.method === 'GET' && url.pathname === '/companion.css') return send(res, 200, companionStyle, 'text/css; charset=utf-8');
        if (req.method === 'GET' && url.pathname === '/setup') return send(res, 200, { protocolVersion: PROTOCOL_VERSION, pairing: auth.setupCode(), fingerprint: certificate.fingerprint, nativePort: (nativeServer.address() as AddressInfo | null)?.port, clients: auth.clients() });
        if (req.method === 'POST' && url.pathname === '/setup/revoke') { const b = await body(req); fields(b, ['clientId']); auth.revoke(text(b, 'clientId', 256)); return send(res, 200, { state: 'revoked' }); }
      }
      if (req.method === 'GET' && url.pathname === '/v1/health') return send(res, 200, { protocolVersion: PROTOCOL_VERSION, state: 'listening' });
      if (surface === 'native') {
        if (req.headers.origin !== undefined) throw new HostApiError(403, 'browser-origin-denied', 'Native HTTPS API does not accept browser-origin requests.', 'Use the trusted loopback companion for browser control.');
        if (req.method === 'POST' && url.pathname === '/v1/pair') { const b = await body(req); fields(b, ['code', 'label']); return send(res, 200, auth.pair(text(b, 'code', 100), text(b, 'label', 100))); }
      }
      const client = surface === 'console' ? auth.authenticate(`Bearer ${auth.companionSession().token}`) : auth.authenticate(req.headers.authorization);
      if (!client) throw new HostApiError(401, 'not-paired', 'This device is unpaired or revoked.', 'Pair using the one-time code and certificate fingerprint from trusted host setup.');
      const owner: HostOwner = { clientId: client.id, surface };
      // Recheck revocation after receiving bounded bodies, before any durable mutation.
      if (req.method === 'POST' || req.method === 'PATCH') {
        parsedBodies.set(req, await body(req, url.pathname === '/v1/voice' ? 1300000 : /^\/v1\/spaces\/[^/]+\/sources$/.test(url.pathname) ? 8000000 : url.pathname === '/v1/telemetry' ? 16384 : 131072));
        stillAuthenticated(req, owner);
      }
      await routes(req, res, owner, url);
    } catch (error) { report(res, error); }
  }
  const nativeServer = createHttpsServer({ key: certificate.key, cert: certificate.cert, minVersion: 'TLSv1.2' }, (req, res) => { void handle(req, res, 'native'); });
  const consoleServer = createHttpServer((req, res) => { void handle(req, res, 'console'); });
  for (const server of [nativeServer, consoleServer]) { server.requestTimeout = 15000; server.headersTimeout = 10000; server.maxHeadersCount = 32; server.keepAliveTimeout = 2000; }
  async function listen(config: { nativePort?: number; nativeHost?: string; consolePort?: number } = {}): Promise<{ nativePort: number; consolePort: number }> {
    async function bind(server: typeof consoleServer, port: number, host: string): Promise<number> { return new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => { server.off('error', reject); resolve((server.address() as AddressInfo).port); }); }); }
    try { consolePort = await bind(consoleServer, config.consolePort ?? 0, '127.0.0.1'); const nativePort = await bind(nativeServer, config.nativePort ?? 0, config.nativeHost ?? '127.0.0.1'); return { nativePort, consolePort }; }
    catch (error) { await close(); throw error; }
  }
  async function close(): Promise<void> {
    for (const finish of polls) finish();
    await Promise.all([nativeServer, consoleServer].map(server => new Promise<void>((resolve, reject) => { if (!server.listening) return resolve(); server.close(error => error ? reject(error) : resolve()); server.closeIdleConnections(); })));
  }
  return { nativeServer, consoleServer, listen, close };
}
