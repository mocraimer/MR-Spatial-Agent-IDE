import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { StringDecoder } from 'node:string_decoder';
import { join, resolve } from 'node:path';
import { RuntimeProcess, type WireRecord } from './runtime-process.js';
import { TASK_TOOL_DEFINITIONS, type ToolResult, type TaskToolHandler } from './runtime-tools.js';
import type { DispatchInput, DispatchResult, Outcome, RuntimeAdapter, RuntimeCapabilities, UsageResult } from './runtime-coordinator.js';

export interface RuntimeEvent { type: 'delta' | 'message' | 'tool' | 'session'; text?: string; messageId?: string; state?: 'complete' | 'failed'; sessionId?: string; model?: string; effort?: string }
export interface RuntimeProfile {
  runtime: 'pi-local' | 'claude-local';
  bin: string;
  /** CLI-owned login here, provisioned explicitly by owner setup. No project resources. */
  configDirectory: string;
  dataDirectory: string;
  scriptDirectory: string;
  /** Pi requires exact provider/id, never a fuzzy alias. Claude uses full resolved model ids. */
  models: readonly { id: string; efforts: readonly string[] }[];
  subscriptionId: string;
}
export interface RuntimeHooks {
  /** Owner setup verifies CLI login and that usage/inference share the approved account. */
  authenticate?(): Promise<boolean>;
  tools(input: DispatchInput): Promise<TaskToolHandler>;
  beforePrompt(input: DispatchInput): void;
  event(input: DispatchInput, event: RuntimeEvent): void;
  resultRecord?(input: DispatchInput, result: DispatchResult): void;
  readUsage(): Promise<UsageResult>;
}
interface SessionIdentity { id: string; file?: string; hasHistory: boolean; runtime: string }
function privateDirectory(path: string): string {
  const directory = resolve(path); mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (realpathSync(directory) !== directory) throw new Error('Runtime app data cannot resolve through symlinks.');
  chmodSync(directory, 0o700); return directory;
}
function persist(path: string, value: unknown): void {
  const fd = openSync(`${path}.tmp`, 'w', 0o600);
  try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(`${path}.tmp`, path);
  const directory = openSync(resolve(path, '..'), 'r'); try { fsyncSync(directory); } finally { closeSync(directory); }
}
export function piArguments(profile: RuntimeProfile, model: string, effort: string, session: SessionIdentity, cwd: string): string[] {
  const slash = model.indexOf('/'); if (slash < 1) throw new Error('Pi model must be exact provider/id.');
  return ['--mode', 'rpc', '--provider', model.slice(0, slash), '--model', model.slice(slash + 1), '--thinking', effort,
    '--no-builtin-tools', '--no-extensions', '-e', join(profile.scriptDirectory, 'runtime-pi-extension.mjs'), '--no-context-files', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-approve', '--offline',
    '--tools', TASK_TOOL_DEFINITIONS.map(tool => tool.name).join(','), '--session-dir', join(cwd, 'sessions'), ...(session.file ? ['--session', session.file] : ['--session-id', session.id])];
}
export function claudeArguments(profile: RuntimeProfile, model: string, effort: string, session: SessionIdentity, mcpConfig: string): string[] {
  return ['--restricted', '--tools', '', '--strict-mcp-config', '--mcp-config', mcpConfig, '--setting-sources', '',
    '--settings', JSON.stringify({ disableAllHooks: true, enabledPlugins: {}, enableAllProjectMcpServers: false, autoMemoryEnabled: false }),
    '--disable-slash-commands', '--no-chrome', '--permission-mode', 'dontAsk', '--permission-prompts', 'none',
    '--allowedTools', TASK_TOOL_DEFINITIONS.map(tool => `mcp__spatial__${tool.name}`).join(','),
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--include-partial-messages', '--verbose',
    '--model', model, '--effort', effort, ...(session.hasHistory ? ['--resume', session.id] : ['--session-id', session.id])];
}
function sameNames(actual: unknown, expected: string[]): boolean { return Array.isArray(actual) && actual.every(item => typeof item === 'string') && JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort()); }

/** Private local socket accepts only a fixed-task handler, never public coordinator commands. */
async function toolBridge(directory: string, handler: (name: string, args: unknown) => Promise<ToolResult>) {
  const socketPath = join(directory, 'tools.sock');
  if (Buffer.byteLength(socketPath) > 100) throw new Error('Private runtime socket path is too long. Choose a short app-data root.');
  const token = randomBytes(32).toString('hex'); const sockets = new Set<import('node:net').Socket>();
  const operations = new Set<Promise<void>>();
  let inventoryResolve!: () => void; let inventoryReject!: (error: Error) => void;
  const inventory = new Promise<void>((accept, reject) => { inventoryResolve = accept; inventoryReject = reject; });
  void inventory.catch(() => undefined);
  const server = createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => undefined);
    socket.setTimeout(45000, () => socket.destroy()); const decoder = new StringDecoder('utf8'); let buffer = ''; let bytes = 0; let consumed = false;
    socket.on('data', chunk => {
      if (consumed) return;
      bytes += chunk.length; if (bytes > 2_000_000) { consumed = true; socket.destroy(); return; }
      buffer += decoder.write(chunk);
      const end = buffer.indexOf('\n'); if (end < 0) return; consumed = true;
      const operation = (async () => {
        const request = JSON.parse(buffer.slice(0, end)) as WireRecord;
        if (request.token !== token) throw new Error('Invalid private runtime connection.');
        if (request.type === 'inventory') {
          const expected = TASK_TOOL_DEFINITIONS.map(tool => tool.name);
          // Disabled built-ins may still be registered. Only bridged tools may be active;
          // no unexpected extension tools may be registered alongside the known built-ins.
          const builtin = ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls', 'powershell'];
          if (!sameNames(request.active, expected) || !Array.isArray(request.registered) || request.registered.some(name => ![...builtin, ...expected].includes(String(name)))) {
            inventoryReject(new Error('Unexpected Pi tool inventory.')); throw new Error('Unexpected tool inventory.');
          }
          inventoryResolve(); return { acknowledged: true };
        }
        if (request.type !== 'tool' || typeof request.name !== 'string' || !TASK_TOOL_DEFINITIONS.some(tool => tool.name === request.name)) throw new Error('Only fixed task tools are available.');
        return handler(request.name, request.args);
      })().then(result => { socket.end(JSON.stringify({ result }) + '\n'); }, () => { socket.end(JSON.stringify({ error: 'Task operation not acknowledged. Current scope/lease may have changed; do not replay uncertain effects.' }) + '\n'); });
      operations.add(operation);
      void operation.finally(() => operations.delete(operation)).catch(() => undefined);
    });
  });
  await new Promise<void>((accept, reject) => { server.once('error', reject); server.listen(socketPath, () => { server.off('error', reject); chmodSync(socketPath, 0o600); accept(); }); });
  return { inventory, env: { SPATIAL_TOOL_SOCKET: socketPath, SPATIAL_TOOL_TOKEN: token, SPATIAL_TOOL_DEFINITIONS: join(directory, 'tools.json') },
    async close() { for (const socket of sockets) socket.destroy(); await new Promise<void>((accept, reject) => server.close(error => error ? reject(error) : accept())); await Promise.allSettled([...operations]); rmSync(socketPath, { force: true }); } };
}

/** Trusted host inference runtime. Actual code/UI effects exist only in the broker tool handler. */
export class GuardedLocalAdapter implements RuntimeAdapter {
  readonly guardedInteractive = true;
  readonly capabilities: RuntimeCapabilities;
  private readonly active = new Map<string, { process: RuntimeProcess; aborted: boolean; input: DispatchInput }>();
  constructor(readonly profile: RuntimeProfile, private readonly hooks: RuntimeHooks) {
    this.capabilities = { runtime: profile.runtime, subscriptionId: profile.subscriptionId, supportsModelSelection: true, supportsEffortSelection: true, effortLevels: [...new Set(profile.models.flatMap(model => [...model.efforts]))], reportsEffectiveSettings: true, acceptsCallerSessionId: true, skillInvocationForm: 'Guarded interactive entry only; no project plugins or skill invocation.' };
  }
  readUsage(): Promise<UsageResult> { return this.hooks.readUsage(); }
  newSessionId(): string { return randomUUID(); }
  async checkReadiness(): Promise<Outcome | undefined> {
    let authenticated = false;
    try { authenticated = await this.hooks.authenticate?.() ?? false; } catch { /* Missing/failed owner auth discovery is BLOCKED, never inferred. */ }
    let protectedProfile = false;
    try {
      const path = resolve(this.profile.configDirectory);
      protectedProfile = realpathSync(path) === path && lstatSync(path).isDirectory() && (lstatSync(path).mode & 0o077) === 0 && !existsSync(join(path, 'plugins'));
    } catch { /* No profile is created by readiness. */ }
    if (!protectedProfile || this.profile.models.length === 0 || !authenticated) return { kind: 'setup-blocked', summary: 'Owner-authenticated, protected CLI profile (mode 700, no plugins/symlinks) and explicit model catalogue are required.', nextAction: 'Configure the app-owned CLI profile and choose a model and effort. No login or authority is created automatically.' };
    return undefined;
  }
  /** Actual CLI preprompt handshake. It deliberately stops before sending any user/model input. */
  async probe(model: string, effort: string): Promise<{ runtime: string; inventory: string[]; inference: false }> {
    const complete = new Error('preprompt-probe-complete');
    const adapter = new GuardedLocalAdapter(this.profile, {
      ...this.hooks,
      authenticate: async () => true, // discovery stops before prompt; not a provider/auth PASS
      tools: async () => async () => { throw new Error('Discovery cannot execute tools.'); },
      event: () => undefined,
      beforePrompt: () => { throw complete; },
    });
    try {
      await adapter.dispatch({ taskId: 'preprompt-probe', runId: randomUUID(), task: '', repoPath: this.profile.dataDirectory,
        evidenceDir: this.profile.dataDirectory, settings: { model, effort }, entry: 'interactive', interactive: { requestId: randomUUID(), conversationId: randomUUID() } });
    } catch (error) {
      if (error === complete) return { runtime: this.profile.runtime, inventory: TASK_TOOL_DEFINITIONS.map(tool => tool.name), inference: false };
      throw error;
    }
    throw new Error('CLI preprompt discovery did not reach a verified inventory.');
  }
  validate(model: string, effort: string): void {
    const selected = this.profile.models.find(item => item.id === model);
    if (!selected || !selected.efforts.includes(effort)) throw new Error('Unsupported explicit model/effort choice; no substitution is allowed.');
  }
  async dispatch(input: DispatchInput): Promise<DispatchResult> {
    if (input.entry !== 'interactive' || !input.interactive) throw new Error('Guarded adapter accepts only explicit interactive entry.');
    const model = input.settings.model ?? '', effort = input.settings.effort ?? '';
    this.validate(model, effort);
    const settings = { requested: { model, effort }, resolved: { model, effort }, observed: { model: 'unknown', effort: 'unknown' } };
    const notReady = await this.checkReadiness(); if (notReady) return { outcome: { ...notReady, promptNotSent: true }, settings };
    const key = createHash('sha256').update(`${this.profile.runtime}:${input.interactive.conversationId}`).digest('hex').slice(0, 24);
    const cwd = privateDirectory(join(this.profile.dataDirectory, key));
    const configDirectory = resolve(this.profile.configDirectory);
    if (realpathSync(configDirectory) !== configDirectory || !lstatSync(configDirectory).isDirectory() || (lstatSync(configDirectory).mode & 0o077) !== 0) throw new Error('CLI login profile must already be protected app data (mode 700); runtime never changes personal/harness configuration permissions.');
    if (existsSync(join(configDirectory, 'plugins'))) throw new Error('Runtime profile must not contain installed plugins.');
    const lockPath = join(cwd, 'turn.lock'); const lock = openSync(lockPath, 'wx', 0o600); closeSync(lock);
    const identityPath = join(cwd, 'identity.json');
    let session: SessionIdentity = existsSync(identityPath) ? JSON.parse(readFileSync(identityPath, 'utf8')) as SessionIdentity : { id: randomUUID(), hasHistory: false, runtime: this.profile.runtime };
    if (session.runtime !== this.profile.runtime || !/^[a-f0-9-]{36}$/.test(session.id)) { rmSync(lockPath); throw new Error('Invalid retained runtime identity.'); }
    writeFileSync(join(cwd, 'tools.json'), JSON.stringify(TASK_TOOL_DEFINITIONS), { mode: 0o600 });
    let bridge: Awaited<ReturnType<typeof toolBridge>> | undefined; let process: RuntimeProcess | undefined;
    let promptIssued = false;
    let observedModel: string | undefined; let observedEffort: string | undefined;
    let messageIndex = 0; let currentText = ''; let failed = false;
    let setupStage = 'task-tools';
    let completedResult: DispatchResult | undefined;
    let failure: unknown;
    let cleanupFailure: unknown;
    try {
      const tools = await this.hooks.tools(input);
      let unclassifiedToolFailure = false;
      bridge = await toolBridge(cwd, async (name, args) => {
        try { return await tools(name, args); }
        catch (error) {
          // Without trusted classification, a failed tool may already have caused effects.
          if (!tools.effectsUncertain) unclassifiedToolFailure = true;
          throw error;
        }
      });
      const env: NodeJS.ProcessEnv = { PATH: globalThis.process.env.PATH ?? '/usr/bin:/bin', HOME: configDirectory, LANG: 'C.UTF-8', PI_CODING_AGENT_DIR: configDirectory, CLAUDE_CONFIG_DIR: configDirectory, PI_OFFLINE: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', ...bridge.env };
      const mcp = JSON.stringify({ mcpServers: { spatial: { command: globalThis.process.execPath, args: [join(this.profile.scriptDirectory, 'runtime-mcp.mjs')], env: bridge.env } } });
      setupStage = 'runtime-handshake';
      process = new RuntimeProcess(this.profile.bin, this.profile.runtime === 'pi-local' ? piArguments(this.profile, model, effort, session, cwd) : claudeArguments(this.profile, model, effort, session, mcp), cwd, env);
      const active = { process, aborted: false, input }; this.active.set(input.sessionId ?? input.runId, active);
      process.subscribe(record => {
        if ((record.type === 'message_start' && (record.message as WireRecord)?.role === 'assistant') || (record.type === 'stream_event' && (record.event as WireRecord)?.type === 'message_start')) { messageIndex++; currentText = ''; }
        const update = this.profile.runtime === 'pi-local' ? record.assistantMessageEvent as WireRecord : (record.event as WireRecord)?.delta as WireRecord;
        if ((update?.type === 'text_delta') && typeof (update.delta ?? update.text) === 'string') { const delta = (update.delta ?? update.text) as string; currentText += delta; this.hooks.event(input, { type: 'delta', text: delta, messageId: String(messageIndex) }); }
        if (record.type === 'message_end' && (record.message as WireRecord)?.role === 'assistant') {
          const message = record.message as WireRecord;
          const blocks = message.content as WireRecord[];
          currentText = Array.isArray(blocks) ? blocks.filter(block => block.type === 'text').map(block => String(block.text)).join('\n') : currentText;
          const responseModel = typeof message.responseModel === 'string' ? message.responseModel : message.model;
          observedModel = typeof responseModel === 'string' ? `${String(message.provider)}/${responseModel}` : observedModel;
          observedEffort = typeof message.thinkingLevel === 'string' ? message.thinkingLevel : observedEffort;
          failed ||= message.stopReason === 'error' || message.stopReason === 'aborted';
          this.hooks.event(input, { type: 'message', text: currentText, messageId: String(messageIndex), state: failed ? 'failed' : 'complete' });
        }
        if (record.type === 'assistant') {
          if (!messageIndex) messageIndex = 1;
          const message = record.message as WireRecord; const blocks = message?.content as WireRecord[];
          currentText = Array.isArray(blocks) ? blocks.filter(block => block.type === 'text').map(block => String(block.text)).join('\n') : currentText;
          if (typeof message?.model === 'string') observedModel = message.model;
          this.hooks.event(input, { type: 'message', text: currentText, messageId: String(messageIndex), state: 'complete' });
        }
        if (record.type === 'result') {
          failed ||= record.is_error === true;
          if (typeof record.result === 'string' && record.result) {
            currentText = record.result;
            this.hooks.event(input, { type: 'message', text: currentText, messageId: String(messageIndex || 1), state: failed ? 'failed' : 'complete' });
          }
        }
        // Deny all unexpected permission requests; model/content cannot answer as owner.
        if (record.type === 'control_request') void process!.write({ type: 'control_response', response: { subtype: 'success', request_id: record.request_id, response: { behavior: 'deny', message: 'Only admitted fixed task tools are available.' } } }).catch(() => undefined);
      });
      if (this.profile.runtime === 'pi-local') {
        await Promise.race([bridge.inventory, new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error('Pi tool inventory unavailable.')), 15000); timer.unref(); })]);
        const state = (await process.pi('get_state')).data as WireRecord;
        const actualModel = state.model as WireRecord;
        if (`${String(actualModel?.provider)}/${String(actualModel?.id)}` !== model || state.thinkingLevel !== effort || state.sessionId !== session.id || typeof state.sessionFile !== 'string' || !resolve(state.sessionFile).startsWith(`${cwd}/sessions/`)) throw new Error('Pi model, effort or session was substituted.');
        observedModel = model; observedEffort = effort;
        session = { ...session, file: state.sessionFile };
        const commands = (await process.pi('get_commands')).data as WireRecord;
        if (!Array.isArray(commands.commands) || commands.commands.length) throw new Error('Unexpected Pi commands/resources.');
        await process.pi('set_auto_retry', { enabled: false }); await process.pi('set_auto_compaction', { enabled: false });
      } else {
        const initialized = (await process.claude('initialize')).response as WireRecord;
        const data = initialized.response as WireRecord;
        if (!Array.isArray(data.commands) || data.commands.length) throw new Error('Unexpected Claude project/custom commands.');
        const models = data.models as WireRecord[];
        if (!Array.isArray(models) || !models.some(item => item.resolvedModel === model && Array.isArray(item.supportedEffortLevels) && item.supportedEffortLevels.includes(effort))) throw new Error('Claude cannot confirm the selected exact model and effort.');
        let servers: WireRecord[] = [];
        const deadline = Date.now() + 10000;
        do {
          const status = (await process.claude('mcp_status')).response as WireRecord;
          servers = (status.response as WireRecord).mcpServers as WireRecord[];
          if (Array.isArray(servers) && servers.length === 1 && servers[0]?.status === 'connected') break;
          await new Promise(resolve => setTimeout(resolve, 100));
        } while (Date.now() < deadline);
        if (!Array.isArray(servers) || servers.length !== 1 || servers[0]?.name !== 'spatial' || servers[0]?.status !== 'connected' || !sameNames((servers[0]?.tools as WireRecord[])?.map(tool => tool.name), TASK_TOOL_DEFINITIONS.map(tool => tool.name))) throw new Error('Explicit Claude MCP inventory is unavailable or contains unexpected tools.');
      }
      persist(identityPath, session);
      this.active.set(session.id, active);
      this.hooks.event(input, { type: 'session', sessionId: session.id, ...(observedModel ? { model: observedModel } : {}), ...(observedEffort ? { effort: observedEffort } : {}) });
      if (!await this.hooks.authenticate?.()) throw new Error('CLI profile authentication changed before prompt.');
      setupStage = 'current-authority';
      this.hooks.beforePrompt(input);
      const settled = process.waitFor(record => this.profile.runtime === 'pi-local' ? record.type === 'agent_settled' : record.type === 'result', input.timeoutMs ?? 300000);
      void settled.catch(() => undefined);
      // Mark before transport write: a failed acceptance acknowledgement is uncertain.
      promptIssued = true;
      // Ordinary strings always enter as messages. Never forward slash/RPC/control objects.
      if (this.profile.runtime === 'pi-local') {
        const accepted = await process.pi('prompt', { message: input.task });
        if ((accepted.data as WireRecord)?.disposition !== 'started') throw new Error('Prompt did not start one admitted turn.');
      } else await process.write({ type: 'user', session_id: session.id, message: { role: 'user', content: input.task }, parent_tool_use_id: null });
      const final = await settled;
      if (this.profile.runtime === 'claude-local' && final.session_id !== session.id) throw new Error('Claude returned a different conversation identity.');
      if (observedModel && observedModel !== model) throw new Error('Runtime reported a substituted model; effects require reconciliation.');
      session.hasHistory = true; persist(identityPath, session);
      settings.observed = { model: observedModel ?? 'unknown', effort: observedEffort ?? 'unknown' };
      await process.close(); process = undefined;
      await bridge.close(); bridge = undefined;
      // Drain every trusted tool before publishing a durable outcome. Model settlement,
      // isError and healthy CLI exit cannot acknowledge outstanding task effects.
      const uncertain = unclassifiedToolFailure || tools.effectsUncertain?.() === true;
      const outcome: Outcome = { kind: uncertain ? 'remote-uncertain' : failed || active.aborted ? 'checks-failed' : 'completed', taskId: input.taskId, runId: input.runId,
        summary: uncertain ? 'Task effects were not acknowledged. Runtime settlement does not prove their outcome; the coordinator reservation remains held.' : active.aborted ? 'Turn aborted. Task scope and history remain; task cancellation is a separate owner action.' : failed ? 'Runtime turn failed; retained messages and tools may include effects.' : 'Guarded interactive turn completed.',
        nextAction: uncertain ? 'Reconcile actual task effects and retained evidence before releasing capacity or requesting new work. Never automatically replay.' : 'Review retained task evidence before continuing.' };
      const result = { outcome, settings, sessionId: session.id };
      if (this.hooks.resultRecord) this.hooks.resultRecord(input, result);
      else persist(join(input.evidenceDir, 'interactive-runtime-result.json'), result);
      completedResult = result;
    } catch (error) {
      // Probe deliberately stops at the verified preprompt boundary, without claiming inference.
      if (promptIssued || (error instanceof Error && error.message === 'preprompt-probe-complete')) failure = error;
      else completedResult = { outcome: { kind: 'setup-blocked', taskId: input.taskId, runId: input.runId, promptNotSent: true, summary: `Guarded runtime ${setupStage} could not be verified; no prompt was sent.`, nextAction: 'Check explicit CLI profile, model, tools, current grant and protected runtime state before an owner-approved new request.', details: { setupStage: [setupStage] } }, settings };
    } finally {
      this.active.delete(input.sessionId ?? input.runId);
      this.active.delete(session.id);
      const cleanup = await Promise.allSettled([process?.close(), bridge?.close()]);
      cleanupFailure = cleanup.find((result): result is PromiseRejectedResult => result.status === 'rejected')?.reason;
      if (!cleanupFailure) { try { rmSync(lockPath, { force: true }); } catch (error) { cleanupFailure = error; } }
    }
    if (cleanupFailure) throw new AggregateError([...(failure ? [failure] : []), cleanupFailure], 'Runtime group/tool teardown could not be proven. Private turn lock retained; effects remain uncertain.');
    if (failure) throw failure;
    if (!completedResult) throw new Error('Runtime returned no acknowledged outcome.');
    return completedResult;
  }
  hasLiveRun(runId: string): boolean { return [...this.active.values()].some(item => item.input.runId === runId && item.process.liveLeader); }
  /** Turn abort is not a task cancellation and does not revoke/expand scope. */
  async abortTurn(sessionId: string): Promise<boolean> {
    const active = this.active.get(sessionId); if (!active) return false;
    active.aborted = true;
    if (this.profile.runtime === 'pi-local') { await active.process.pi('clear_queue'); await active.process.pi('abort'); }
    else await active.process.claude('interrupt');
    return true;
  }
  stop(sessionId: string): Promise<boolean> { return this.abortTurn(sessionId); }
  async reconcile(_sessionId: string, evidenceDir?: string): Promise<Outcome> {
    // Published only after bounded process teardown; recovery itself never resumes inference.
    const resultPath = evidenceDir && join(evidenceDir, 'interactive-runtime-result.json');
    if (resultPath && existsSync(resultPath)) {
      const result = JSON.parse(readFileSync(resultPath, 'utf8')) as DispatchResult;
      return result.outcome;
    }
    return { kind: 'remote-uncertain', summary: 'Interactive worker acknowledgement was lost; inspect retained product messages, runtime history and coordinator evidence.', nextAction: 'Owner must reconcile effects/process absence before any retry.', ...(evidenceDir ? { details: { evidenceDir } } : {}) };
  }
}
