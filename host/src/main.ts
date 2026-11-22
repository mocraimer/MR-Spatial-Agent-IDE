import { appendFileSync, chmodSync, existsSync, lstatSync, readFileSync, renameSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { PairingAuthority, ensureHostCertificate } from './auth.js';
import { assertPrivatePath, loadHostConfig, prepareHostRoot, readPrivateJson, loadSpeechOptions, type HostConfig, type RuntimeAccountRegistration } from './config.js';
import { EnvironmentBroker } from './environment-broker.js';
import { ExecutionBridge, type ExecutionScope } from './execution.js';
import { registeredExecutionScope, type ScopeCoordinator } from './execution-scope.js';
import { acquireFileLease } from './file-lease.js';
import { createHostServer, HostApiError, type HostOwner, type HostServices, type NativeEvidence } from './server.js';
import { WorkspaceStore, type Submission } from './store.js';
import type { RuntimeProfile } from './runtime-adapters.js';
import type { FixedTaskEnvironment } from './runtime-tools.js';
import type { Actor, CoordinatorCommands, RuntimeAdapter, RuntimeCapabilities } from './runtime-coordinator.js';
import { assertArchiveDestinationAvailable, createArchiveLifecycle, hasArchiveCommands } from './lifecycle.js';

const RECOVERY = 'Open owner setup and configure the missing prerequisite. Do not retry uncertain effects or grant authority automatically.';
function blocked(detail: string): never { throw new HostApiError(503, 'host-setup-blocked', detail, RECOVERY); }
function unavailableExecution(detail: string): NonNullable<HostServices['execution']> {
  return { async readiness() { return [{ id: 'execution', state: 'blocked', detail }]; }, async validateSettings() { blocked(detail); }, async queue() { blocked(detail); }, async interrupt() { blocked(detail); }, async decide() { blocked(detail); } };
}
/** Trusted closure only: callers cannot supply an operator actor through model tools. */
export function authenticateHostOwner(auth: PairingAuthority, operator: () => string | undefined, expected: string, owner: HostOwner): Actor {
  if (!['native', 'console'].includes(owner.surface) || !auth.clients().some(client => client.id === owner.clientId && !client.revokedAt)) throw new HostApiError(401, 'owner-revoked', 'The owner client is not currently paired.', 'Re-pair through the private owner companion.');
  const id = operator(); if (!id || id !== expected) blocked('The existing coordinator operator does not match the explicitly configured owner.');
  return { kind: 'operator', id };
}
/** Every run captures its task/environment/epoch once, after coordinator admission. */
export async function bindTaskEnvironment(store: WorkspaceStore, broker: EnvironmentBroker, bridge: Pick<ExecutionBridge, 'assertTaskToolAllowed'>, submission: Submission, runId: string): Promise<FixedTaskEnvironment | null> {
  const taskId = submission.receiver.taskId;
  if (taskId === null) return null;
  const admission = (): void => {
    store.assertDestinationAvailable(submission.receiver.spaceId, taskId);
    const task = store.getTask(taskId);
    if (task.spaceId !== submission.receiver.spaceId || task.conversationId !== submission.receiver.conversationId) throw new Error('Receiver identity changed.');
    bridge.assertTaskToolAllowed(submission.id, runId);
  };
  admission();
  const snapshot = await broker.create(taskId);
  const retained = store.getTask(taskId).environmentId;
  if (retained !== null && retained !== snapshot.environmentId) blocked('Task environment differs from its retained binding. Reconcile both records; no replacement was authorized.');
  store.updateTask(taskId, { environmentId: snapshot.environmentId });
  admission(); // Keep the created environment linked even if authority changed while awaiting creation.
  if (snapshot.state !== 'running' || snapshot.lease.owner !== 'agent') blocked('Task environment requires confirmed owner reconciliation before agent tools are available.');
  const epoch = snapshot.lease.epoch, environmentId = snapshot.environmentId;
  const guard = (candidate: string): void => {
    if (candidate !== taskId) throw new Error('Task tool cannot select another task.');
    admission();
    if (store.getTask(taskId).environmentId !== environmentId) throw new Error('Task environment binding changed.');
    const current = broker.snapshot(taskId);
    if (current.environmentId !== environmentId || current.lease.epoch !== epoch || current.lease.owner !== 'agent' || current.state !== 'running') throw new Error('Fixed run environment lease changed.');
  };
  guard(taskId);
  const view = (kind: 'browser' | 'terminal' | 'desktop') => {
    guard(taskId);
    const current = broker.snapshot(taskId).views.find(view => view.kind === kind);
    if (!current) throw new Error('Task view is unavailable.'); return current;
  };
  return Object.freeze({ taskId, epoch, tools: broker.agent(guard),
    frame: (kind: 'browser' | 'terminal' | 'desktop') => broker.frame(taskId, view(kind).id, guard),
    identity: (kind: 'browser' | 'terminal' | 'desktop') => { const current = view(kind); return { taskId, environmentId, viewId: current.id, generation: current.generation, leaseEpoch: epoch }; },
  });
}
export function resolveExecutionScope(config: HostConfig, store: WorkspaceStore, submission: Submission, coordinator?: ScopeCoordinator): ExecutionScope | null {
  return registeredExecutionScope(config, store, submission, coordinator);
}
const runLocal = promisify(execFile);
/** Local identity checks only: never /usage, a model prompt, token refresh or a login command. */
export async function verifyRuntimeAuthentication(profile: RuntimeProfile, account: RuntimeAccountRegistration | undefined, usageIdentity: () => Promise<{ id: string; plan?: string } | undefined>, legacyBin = 'claude'): Promise<boolean> {
  // Pi's current Codex usage reader has no account identity output; do not decode an
  // unsigned token or equate subscription labels to manufacture authentication proof.
  if (profile.runtime !== 'claude-local' || !account) return false;
  try {
    assertPrivatePath(profile.configDirectory, true);
    if (['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_CUSTOM_HEADERS', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX'].some(key => process.env[key])) return false;
    const profileEnv: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: profile.configDirectory, LANG: 'C.UTF-8', CLAUDE_CONFIG_DIR: profile.configDirectory, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
    const read = async (bin: string, env: NodeJS.ProcessEnv) => {
      const result = await runLocal(bin, ['auth', 'status'], { env, timeout: 15000, maxBuffer: 65536 });
      return JSON.parse(result.stdout) as { loggedIn?: boolean; authMethod?: string; apiProvider?: string; orgId?: string; email?: string; subscriptionType?: string };
    };
    const [app, readerCli, reader] = await Promise.all([read(profile.bin, profileEnv), read(legacyBin, process.env), usageIdentity()]);
    const matches = (status: typeof app): boolean => status.loggedIn === true && status.authMethod === 'oauth' && status.apiProvider === 'firstParty' && status.orgId === account.orgId && status.email === account.email && typeof status.subscriptionType === 'string' && status.subscriptionType.length > 0;
    return matches(app) && matches(readerCli) && app.subscriptionType === readerCli.subscriptionType && reader?.id === account.orgId && reader.plan === app.subscriptionType;
  } catch { return false; } // Failed discovery is a capability blocker, not login success.
}
interface CoordinatorModule {
  adapterFor(runtime: RuntimeCapabilities['runtime']): RuntimeAdapter;
  createCoordinatorCommands(factory?: (runtime: RuntimeCapabilities['runtime']) => RuntimeAdapter): CoordinatorCommands;
}
interface ActivationEvidence {
  stateRoot: string; buildDigest: string; operator: string; approvedAt: string; mergedPr: string;
  writerInventory: string; quiescenceEvidence: string; backupEvidence: string;
}
function activationRecord(config: NonNullable<HostConfig['coordinator']>): { record: ActivationEvidence; fingerprint: string } {
  const value = readPrivateJson(config.activationEvidence);
  if (!value || typeof value !== 'object' || Array.isArray(value)) blocked('Owner activation evidence is malformed.');
  const record = value as ActivationEvidence;
  const fields = ['stateRoot', 'buildDigest', 'operator', 'approvedAt', 'mergedPr', 'writerInventory', 'quiescenceEvidence', 'backupEvidence'];
  if (Object.keys(record).some(key => !fields.includes(key)) || fields.some(key => typeof (record as unknown as Record<string, unknown>)[key] !== 'string') || record.stateRoot !== config.stateRoot || record.operator !== config.operator || !/^[a-f0-9]{64}$/.test(record.buildDigest) || !Number.isFinite(Date.parse(record.approvedAt)) || Date.parse(record.approvedAt) > Date.now() || !/^https:\/\/[^\s]+\/pull\/\d+$/.test(record.mergedPr)) blocked('Owner activation evidence must name this state/build/operator and the existing reviewed merge.');
  for (const evidence of [record.writerInventory, record.quiescenceEvidence, record.backupEvidence]) {
    if (!evidence.startsWith(`${resolve(config.activationEvidence, '..')}/`)) blocked('Cutover evidence must be private files alongside the owner approval.');
    assertPrivatePath(evidence);
    if (lstatSync(evidence).size === 0 || lstatSync(evidence).size > 1048576) blocked('Cutover evidence is empty or unbounded.');
  }
  const fingerprint = createHash('sha256').update(readFileSync(config.activationEvidence));
  for (const path of [record.writerInventory, record.quiescenceEvidence, record.backupEvidence]) fingerprint.update(readFileSync(path));
  return { record, fingerprint: fingerprint.digest('hex') };
}
async function executionService(config: HostConfig, store: WorkspaceStore, auth: PairingAuthority, broker: EnvironmentBroker): Promise<{ service: NonNullable<HostServices['execution']>; bridge?: ExecutionBridge; lifecycle?: NonNullable<HostServices['lifecycle']> }> {
  const selected = config.coordinator;
  if (!selected) return { service: unavailableExecution('No explicit compatible coordinator state/build/owner scope is configured. Setup does not create grants or contact providers.') };
  let lifecycle: NonNullable<HostServices['lifecycle']> | undefined;
  try {
    assertPrivatePath(selected.stateRoot, true);
    const evidence = activationRecord(selected);
    const identity = JSON.parse(readFileSync(join(selected.buildDirectory, 'build-identity.json'), 'utf8')) as { digest: string };
    if (identity.digest !== evidence.record.buildDigest) blocked('Selected coordinator build differs from approved cutover evidence.');
    if (process.env.AGENTSYS_STATE !== undefined && resolve(process.env.AGENTSYS_STATE) !== selected.stateRoot) blocked('Process AGENTSYS_STATE differs from explicit owner configuration. Start a clean dedicated host process.');
    // Set before loading any command/store code. There is never a .state/main fallback.
    process.env.AGENTSYS_STATE = selected.stateRoot;
    const module = await import(pathToFileURL(join(selected.buildDirectory, 'commands.js')).href) as CoordinatorModule;
    if (typeof module.adapterFor !== 'function' || typeof module.createCoordinatorCommands !== 'function') blocked('Selected coordinator does not export adapterFor/createCoordinatorCommands.');
    const commands = module.createCoordinatorCommands();
    const activated = (): boolean => {
      const current = activationRecord(selected);
      const build = JSON.parse(readFileSync(join(selected.buildDirectory, 'build-identity.json'), 'utf8')) as { digest: string };
      const active = commands.version().active;
      return process.env.AGENTSYS_STATE === selected.stateRoot && current.fingerprint === evidence.fingerprint && build.digest === evidence.record.buildDigest && commands.configuredOperator() === selected.operator && active?.coordinator === evidence.record.buildDigest && active.activatedBy === selected.operator && active.mergedPr === evidence.record.mergedPr;
    };
    if (!activated()) blocked('Existing coordinator reviewed activation/operator does not match this build and owner cutover evidence. No activation was attempted.');
    // Archive cutoff reads depend on verified state/build/operator, not inference profiles or OAuth.
    lifecycle = hasArchiveCommands(commands) ? createArchiveLifecycle({ store, broker, commands, activated,
      authenticateOwner: owner => authenticateHostOwner(auth, commands.configuredOperator, selected.operator, owner),
      actor: () => { if (commands.configuredOperator() !== selected.operator) blocked('Archive owner/operator registration changed.'); return { kind: 'operator', id: selected.operator }; },
    }) : undefined;
    if (!config.profiles.length) return { ...(lifecycle ? { lifecycle } : {}), service: unavailableExecution('No owner-supplied app CLI runtime profile is configured. Harness logins are never copied.') };
    if (typeof commands.authorityPreviewForOperator !== 'function' || typeof commands.authorityConfirmationRecord !== 'function') blocked('Selected coordinator lacks the fenced existing-authority confirmation contract. Select a reviewed compatible build through owner activation controls; no legacy permission fallback exists.');
    const readerModule = await import(pathToFileURL(join(selected.buildDirectory, 'adapters/claude-web.js')).href) as { ClaudeWebAdapter: new () => { accountIdentity(): Promise<{ id: string; plan?: string } | undefined> } };
    const reader = new readerModule.ClaudeWebAdapter(); // Same legitimate default reader used by adapterFor('claude-local').
    const runtimeAuthentication = (profile: RuntimeProfile): Promise<boolean> => verifyRuntimeAuthentication(profile, config.runtimeAccounts.find(account => account.runtime === profile.runtime), () => reader.accountIdentity());
    const requireAuthentication = async (runtime: string): Promise<void> => {
      const profile = config.profiles.find(profile => profile.runtime === runtime);
      if (!profile || !await runtimeAuthentication(profile)) blocked('App CLI OAuth identity and the legitimate usage-reader account could not be proved equal to the private owner registration. Pi currently lacks comparable reader metadata. No usage/provider call or admission occurred.');
    };
    const bridge: ExecutionBridge = new ExecutionBridge({ store, profiles: config.profiles, activated,
      coordinatorFactory: module.createCoordinatorCommands, legacyAdapterFactory: module.adapterFor,
      authenticateOwner: async owner => authenticateHostOwner(auth, commands.configuredOperator, selected.operator, owner),
      runtimeAuthentication,
      scope: (submission, coordinator) => resolveExecutionScope(config, store, submission, coordinator),
      environment: (submission, runId) => bindTaskEnvironment(store, broker, bridge, submission, runId),
    });
    await bridge.reconcile(); // Lookup only; never redispatch unsettled work.
    return { bridge, ...(lifecycle ? { lifecycle } : {}), service: { refreshReviews: () => bridge.refreshReviews(), readiness: async () => [...await bridge.readiness(), ...config.profiles.filter(profile => profile.runtime === 'pi-local' || !config.runtimeAccounts.some(account => account.runtime === profile.runtime)).map(profile => ({ id: `runtime-account:${profile.runtime}`, state: 'blocked' as const, detail: profile.runtime === 'pi-local' ? 'The current legitimate Codex usage reader does not expose comparable account identity. Supply a verified reader/inference identity contract; subscription labels and unsigned token contents cannot enable Pi.' : 'Register the exact owner-approved Claude org/email privately and verify local OAuth auth status against the legitimate usage reader. Do not copy harness credentials.' }))], validateSettings: async (settings, owner) => { authenticateHostOwner(auth, commands.configuredOperator, selected.operator, owner); await requireAuthentication(settings.runtime); await bridge.validateSettings(settings, owner); }, queue: async (submission, owner) => { authenticateHostOwner(auth, commands.configuredOperator, selected.operator, owner); await requireAuthentication(submission.runtime); await bridge.queue(submission, owner); }, interrupt: (task, mode, owner) => bridge.interrupt(task, mode, owner), decide: (request, decision, owner) => bridge.decide(request, decision, owner) } };
  } catch {
    // Failure is an owner-visible capability blocker, not a successful runtime fallback.
    return { ...(lifecycle ? { lifecycle } : {}), service: unavailableExecution('Coordinator setup could not verify the explicit build, private state, existing reviewed activation, owner cutover evidence or shared account identity. Inspect docs/HOST-SETUP.md; no execution/activation was performed.') };
  }
}
/** Bounded, field-selected evidence only. No free-form events, audio, tokens or prompts. */
export function nativeEvidenceRecorder(root: string, maxBytes: number, authenticate: (owner: HostOwner) => void): NonNullable<HostServices['telemetry']> {
  const path = join(root, 'evidence/native.jsonl');
  return { async record(evidence: NativeEvidence, owner: HostOwner) {
    authenticate(owner);
    if (!['native', 'console'].includes(owner.surface)) throw new Error('Invalid evidence owner surface.');
    const id = (value: string): string => { if (typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{1,256}$/.test(value)) throw new Error('Invalid evidence identity.'); return value; };
    const count = (value: number): number => { if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid evidence count.'); return value; };
    const measurement = (value: number): number => { if (!Number.isFinite(value) || value < 0) throw new Error('Invalid evidence timing.'); return value; };
    if (!/^[0-9][0-9A-Za-z_.-]{0,63}$/.test(evidence.unity) || !['VR', 'MR'].includes(evidence.mode) || [evidence.microphoneEnabled, evidence.captureAllowed, evidence.metrics.timingAvailable].some(value => typeof value !== 'boolean')) throw new Error('Invalid native evidence.');
    const m = evidence.metrics;
    const record = { recordedAt: new Date().toISOString(), clientId: id(owner.clientId), surface: owner.surface, sessionId: id(evidence.sessionId), unity: evidence.unity, mode: evidence.mode, frameCount: count(evidence.frameCount), unscaledFrameSeconds: measurement(evidence.unscaledFrameSeconds), spaceId: id(evidence.spaceId), taskId: evidence.taskId === null ? null : id(evidence.taskId), viewId: evidence.viewId === null ? null : id(evidence.viewId), microphoneEnabled: evidence.microphoneEnabled, captureAllowed: evidence.captureAllowed, metrics: { timingAvailable: m.timingAvailable, samples: count(m.samples), cpuP95Ms: measurement(m.cpuP95Ms), gpuP95Ms: measurement(m.gpuP95Ms), allocatedBytes: count(m.allocatedBytes) } };
    const line = JSON.stringify(record) + '\n';
    if (Buffer.byteLength(line) > 4096) throw new Error('Native evidence exceeds its bounded record size.');
    for (const file of [path, `${path}.1`, `${path}.2`]) if (existsSync(file)) assertPrivatePath(file);
    if (existsSync(path) && statSync(path).size + Buffer.byteLength(line) > maxBytes) {
      if (existsSync(`${path}.1`)) renameSync(`${path}.1`, `${path}.2`);
      renameSync(path, `${path}.1`);
    }
    appendFileSync(path, line, { mode: 0o600 });
  } };
}

export interface RunningHost {
  config: HostConfig; ports: { nativePort: number; consolePort: number }; store: WorkspaceStore; broker: EnvironmentBroker;
  close(): Promise<void>;
}
/** Production assembly. Construction does not seed projects, grant authority or start agents. */
export async function startHost(config: HostConfig = loadHostConfig()): Promise<RunningHost> {
  prepareHostRoot(config.root);
  const leasePath = join(config.root, 'host.lock');
  if (existsSync(leasePath)) assertPrivatePath(leasePath);
  const release = acquireFileLease(leasePath);
  let store: WorkspaceStore | undefined, broker: EnvironmentBroker | undefined, server: ReturnType<typeof createHostServer> | undefined;
  const pending = new Set<Promise<unknown>>();
  const track = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = Promise.resolve().then(operation); pending.add(result);
    void result.finally(() => pending.delete(result)).catch(() => undefined); return result;
  };
  let bridge: ExecutionBridge | undefined;
  let speechInstance: import('./speech.js').OpenAiSpeechService | undefined;
  try {
    for (const file of ['workspace.sqlite', 'auth/clients.json', 'tls/host-key.pem', 'tls/host-cert.pem']) if (existsSync(join(config.root, file))) assertPrivatePath(join(config.root, file));
    store = new WorkspaceStore(join(config.root, 'workspace.sqlite')); chmodSync(join(config.root, 'workspace.sqlite'), 0o600);
    const auth = new PairingAuthority(join(config.root, 'auth'));
    const certificate = ensureHostCertificate(join(config.root, 'tls')); chmodSync(join(config.root, 'tls/host-cert.pem'), 0o600);
    broker = new EnvironmentBroker(join(config.root, 'environments'));
    const execution = await executionService(config, store, auth, broker); bridge = execution.bridge;
    const assertOwnerDestination = (taskId: string): void => {
      const task = store!.getTask(taskId);
      assertArchiveDestinationAvailable(store!, { spaceId: task.spaceId, conversationId: task.conversationId, taskId: task.id }, execution.lifecycle);
    };
    const ownerPort = broker.owner(assertOwnerDestination);
    const service: HostServices = { execution: {
      refreshReviews: () => execution.service.refreshReviews?.(),
      readiness: () => track(() => execution.service.readiness()), validateSettings: (settings, owner) => track(() => execution.service.validateSettings(settings, owner)), queue: (submission, owner) => track(() => execution.service.queue(submission, owner)), interrupt: (task, mode, owner) => track(() => execution.service.interrupt(task, mode, owner)), decide: (request, decision, owner) => track(() => execution.service.decide(request, decision, owner)),
    }, environment: {
      readiness: () => track(() => broker!.readiness()), views: () => broker!.views(), snapshots: () => broker!.snapshots(), frame: (taskId, viewId) => track(() => broker!.frame(taskId, viewId, assertOwnerDestination)), terminal: taskId => track(() => broker!.terminal(taskId)),
      owner: () => ({ exec: (...args) => track(() => ownerPort.exec(...args)), read: (...args) => track(() => ownerPort.read(...args)), write: (...args) => track(() => ownerPort.write(...args)), input: input => track(() => ownerPort.input(input)), takeControl: (...args) => track(() => ownerPort.takeControl(...args)), resume: (...args) => track(() => ownerPort.resume(...args)), stop: (...args) => track(() => ownerPort.stop(...args)), archive: (...args) => track(() => ownerPort.archive(...args)), destroy: (...args) => track(() => ownerPort.destroy(...args)), exportArchive: (...args) => track(() => ownerPort.exportArchive(...args)) }),
    } };
    if (execution.lifecycle) service.lifecycle = {
      readiness: () => execution.lifecycle!.readiness(),
      assertDestinationAvailable: receiver => execution.lifecycle!.assertDestinationAvailable(receiver),
      archive: (receivers, owner, commit, product) => track(() => execution.lifecycle!.archive(receivers, owner, commit, product)),
    };
    if (config.speechConfig) {
      // Fixed product module only. Its contract is installed by the speech component.
      const path = new URL('./speech.js', import.meta.url);
      if (existsSync(path)) {
        const module = await import(path.href) as typeof import('./speech.js');
        if (typeof module.OpenAiSpeechService !== 'function') blocked('Speech module has no compatible OpenAiSpeechService constructor.');
        const options = loadSpeechOptions(config.speechConfig, config.root);
        try {
          for (const file of [options.journalPath, `${options.journalPath}.identity`]) {
            if (!existsSync(file)) throw new module.SpeechError(503, 'speech-journal-unavailable', 'An explicitly provisioned speech journal and its identity are required.', 'Use the one-time trusted provisioning command for NEW journals only; preserve any existing billing evidence.');
            try { assertPrivatePath(file); }
            catch (error) {
              if (error instanceof Error && error.message.startsWith('Invalid private host configuration:')) throw new module.SpeechError(503, 'speech-journal-unavailable', 'Speech journal ownership, permissions or path are unsafe.', 'Preserve billing evidence and correct private storage through owner maintenance.');
              throw error;
            }
          }
          const speech = new module.OpenAiSpeechService(options); speechInstance = speech;
          const call = <T>(operation: () => Promise<T>): Promise<T> => track(async () => {
            try { return await operation(); } catch (error) { if (error instanceof module.SpeechError) throw new HostApiError(error.status, error.code, error.message, error.recovery); throw error; }
          });
          service.speech = { readiness: () => call(() => speech.readiness()), transcribe: (wav, context) => call(() => speech.transcribe(wav, context)), synthesize: (text, context) => call(() => speech.synthesize(text, context)) };
        } catch (error) {
          if (!(error instanceof module.SpeechError)) throw error;
          service.speech = { async readiness() { return [{ id: 'speech', state: 'blocked', detail: `${error.message} ${error.recovery}` }]; }, async transcribe() { throw new HostApiError(error.status, error.code, error.message, error.recovery); }, async synthesize() { throw new HostApiError(error.status, error.code, error.message, error.recovery); } };
        }
      } else {
        service.speech = { async readiness() { return [{ id: 'speech', state: 'blocked', detail: 'Explicit speech setup exists but the speech service module is not installed. Install a compatible product build.' }]; }, async transcribe() { blocked('Speech service is not installed.'); }, async synthesize() { blocked('Speech service is not installed.'); } };
      }
    } else {
      service.speech = { async readiness() { return [{ id: 'speech', state: 'blocked', detail: 'No explicit speech setup. Configure a private speech options file and owner-approved paid-call limits; model CLI login is not a speech credential.' }]; }, async transcribe() { blocked('Speech is not explicitly configured.'); }, async synthesize() { blocked('Speech is not explicitly configured.'); } };
    }
    if (config.telemetry.enabled) {
      const recorder = nativeEvidenceRecorder(config.root, config.telemetry.maxBytes, owner => { if (!auth.clients().some(client => client.id === owner.clientId && !client.revokedAt)) throw new HostApiError(401, 'owner-revoked', 'Client pairing was revoked.', 'Re-pair through owner setup.'); });
      service.telemetry = { record: (evidence, owner) => track(() => recorder.record(evidence, owner)) };
    }
    server = createHostServer({ store, auth, certificate, services: service });
    const ports = await server.listen({ nativeHost: config.nativeHost, nativePort: config.nativePort, consolePort: config.consolePort });
    let closing: Promise<void> | undefined, closed = false;
    return { config, ports, store, broker, close() {
      if (closed) return Promise.resolve();
      if (closing) return closing;
      closing = (async () => {
        await server!.close(); // Stop admission/HTTP first; drain active requests.
        while (pending.size) await Promise.allSettled([...pending]);
        await bridge?.waitForIdle(); // Do not abandon an admitted runtime/tool callback.
        await speechInstance?.close();
        broker!.close(); // Does NOT stop background workloads; recovery retains uncertainty.
        store!.close(); release(); closed = true;
      })().finally(() => { closing = undefined; });
      return closing;
    } };
  } catch (error) {
    await server?.close();
    while (pending.size) await Promise.allSettled([...pending]);
    await bridge?.waitForIdle();
    await speechInstance?.close();
    broker?.close(); store?.close(); release(); throw error;
  }
}
async function main(): Promise<void> {
  const host = await startHost();
  process.stdout.write(JSON.stringify({ event: 'host-listening', nativeHost: host.config.nativeHost, nativePort: host.ports.nativePort, consoleHost: '127.0.0.1', consolePort: host.ports.consolePort }) + '\n');
  const shutdown = (): void => { void host.close().then(() => { process.stdout.write('{"event":"host-closed","workloads":"not-implicitly-stopped"}\n'); process.removeListener('SIGINT', shutdown); process.removeListener('SIGTERM', shutdown); }, () => { process.stderr.write('{"event":"shutdown-blocked","detail":"Resources remain owned. Inspect in-flight work before retrying shutdown."}\n'); process.exitCode = 1; }); };
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch(() => { process.stderr.write('{"event":"host-start-failed","detail":"Check private owner config, root lease, storage, OpenSSL and ports. No production service was changed."}\n'); process.exitCode = 1; });
}
