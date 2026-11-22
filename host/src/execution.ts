import { createHash } from 'node:crypto';
import { HostApiError, type HostOwner, type HostServices, type OwnerDecision, type RuntimeSettings } from './server.js';
import { WorkspaceStore, type Submission } from './store.js';
import { produceAuthorityHandoff, confirmAuthorityHandoff } from './owner-decisions.js';
import type { InboxRequest, ReadinessItem, TaskWindow } from './protocol.js';
import { GuardedLocalAdapter, type RuntimeEvent, type RuntimeProfile } from './runtime-adapters.js';
import { createTaskToolHandler, type FixedTaskEnvironment, type TaskToolHandler } from './runtime-tools.js';
import type { ActionId, Actor, ApprovalInput, CoordinatorCommands, DispatchInput, DispatchTaskInput, GrantInput, RuntimeAdapter, RuntimeCapabilities, UsageEstimate, RunRecord } from './runtime-coordinator.js';

export interface ExecutionScope {
  /** Host-owned registration; project/model/content never supplies these values. */
  repo: string; workClass: string; profile: string; actions: ActionId[];
  approvalId?: string; triggerSource?: string;
  estimate: UsageEstimate; timeoutMs: number;
}
export interface ExecutionOptions {
  store: WorkspaceStore;
  /** An explicitly approved, compatible coordinator instance. Missing activation stays BLOCKED. */
  activated(): boolean;
  coordinatorFactory(factory: (runtime: RuntimeCapabilities['runtime']) => RuntimeAdapter): CoordinatorCommands;
  legacyAdapterFactory(runtime: RuntimeCapabilities['runtime']): RuntimeAdapter;
  profiles: readonly RuntimeProfile[];
  authenticateOwner(owner: HostOwner): Promise<Actor>;
  runtimeAuthentication?(profile: RuntimeProfile): Promise<boolean>;
  scope(submission: Submission, coordinator: Pick<CoordinatorCommands, 'currentAuthoritySettings' | 'interactiveLookup'>): ExecutionScope | null;
  /** Optional project integrations; defaults remain owner-uploaded ProductStore sources only. */
  contextSources?(submission: Submission): unknown;
  readSource?(submission: Submission, sourceId: string): unknown | Promise<unknown>;
  /** Runs inside trusted host, after admitted run creation; never returned to model/client. */
  environment(submission: Submission, runId: string): Promise<FixedTaskEnvironment | null>;
}
function blocked(detail: string): never { throw new HostApiError(503, 'execution-blocked', detail, 'Open owner setup and explicitly configure/approve the missing runtime, scope or compatible coordinator activation. Nothing was granted automatically.'); }
function stable(prefix: string, values: string[]): string { return `${prefix}-${createHash('sha256').update(JSON.stringify(values)).digest('hex')}`; }

/** Product outbox/history bridge. CoordinatorCommands remains the sole authority/admission/run owner. */
export class ExecutionBridge implements NonNullable<HostServices['execution']> {
  readonly coordinator: CoordinatorCommands;
  private readonly adapters = new Map<string, GuardedLocalAdapter>();
  private readonly pending = new Map<string, Promise<void>>();
  private readonly cancellations = new Set<string>();
  constructor(private readonly options: ExecutionOptions) {
    const factory = (runtime: RuntimeCapabilities['runtime']): RuntimeAdapter => {
      const legacy = options.legacyAdapterFactory(runtime);
      const profile = options.profiles.find(profile => profile.runtime === runtime);
      if (!profile) return legacy;
      let guarded = this.adapters.get(runtime);
      if (!guarded) {
        if (profile.subscriptionId !== legacy.capabilities.subscriptionId) throw new Error('Interactive and legacy adapters must share the real coordinator account identity.');
        guarded = new GuardedLocalAdapter(profile, {
          authenticate: () => options.runtimeAuthentication?.(profile) ?? Promise.resolve(false),
          readUsage: () => legacy.readUsage(),
          beforePrompt: input => this.guard(input, 'conversation'),
          tools: input => this.tools(input),
          event: (input, event) => this.event(input, event),
          resultRecord: (input, result) => this.coordinator.interactiveRuntimeResultRecord(input.runId, input.interactive!.requestId, result),
        });
        this.adapters.set(runtime, guarded);
      }
      const interactive = guarded;
      return {
        capabilities: legacy.capabilities, guardedInteractive: true,
        readUsage: () => legacy.readUsage(), newSessionId: () => legacy.newSessionId?.() ?? interactive.newSessionId(),
        checkReadiness: entry => legacy.checkReadiness(entry),
        dispatch: input => input.entry === 'interactive' ? interactive.dispatch(input) : legacy.dispatch(input),
        reconcile: (sessionId, evidenceDir) => this.coordinator.status().runs.some(item => item.run.sessionId === sessionId && item.run.interactive)
          ? interactive.reconcile(sessionId, evidenceDir) : legacy.reconcile(sessionId, evidenceDir),
        stop: sessionId => this.coordinator.status().runs.some(item => item.run.sessionId === sessionId && item.run.interactive)
          ? interactive.stop(sessionId) : legacy.stop?.(sessionId) ?? Promise.resolve(false),
      };
    };
    this.coordinator = options.coordinatorFactory(factory);
    // Instantiate supported guarded adapters without starting a worker or reserving capacity.
    for (const profile of options.profiles) factory(profile.runtime);
  }
  private active(): void { if (!this.options.activated()) blocked('Compatible coordinator activation is not explicitly approved. Legacy jobs remain read-only/imported.'); }
  async readiness(): Promise<ReadinessItem[]> {
    if (!this.options.activated()) return [{ id: 'execution', state: 'blocked', detail: 'Compatible coordinator activation requires explicit owner approval; no live code/state was replaced.' }];
    const items: ReadinessItem[] = [{ id: 'execution', state: this.coordinator.configuredOperator() ? 'ready' : 'blocked', detail: this.coordinator.configuredOperator() ? 'Coordinator connected. Each request still requires current authority/admission.' : 'Existing coordinator has no configured operator. Configure it explicitly; the product does not create one.' }];
    for (const profile of this.options.profiles) {
      const unavailable = await this.adapters.get(profile.runtime)!.checkReadiness();
      items.push({ id: profile.runtime, state: unavailable ? 'blocked' : 'unknown', detail: unavailable?.summary ?? 'CLI profile and explicit choices configured. Verify preprompt tool discovery; real provider acceptance is not yet demonstrated.' });
    }
    if (!this.options.profiles.length) items.push({ id: 'runtimes', state: 'blocked', detail: 'No explicitly configured guarded runtime. Choose Pi-local/Claude-local and an app-owned CLI login profile.' });
    return items;
  }
  async validateSettings(settings: RuntimeSettings, owner: HostOwner): Promise<void> {
    await this.options.authenticateOwner(owner); this.active();
    const adapter = this.adapters.get(settings.runtime);
    if (!adapter) blocked('This runtime has no configured guarded interactive adapter.');
    try { adapter.validate(settings.model, settings.effort); } catch { blocked('Choose a supported explicit model and runtime-native effort. Defaults and silent substitutions are unavailable.'); }
  }
  private input(submission: Submission): DispatchTaskInput {
    const scope = this.options.scope(submission, this.coordinator);
    if (!scope) blocked('This receiver has no owner-approved coordinator scope.');
    if (!scope.actions.includes('conversation') || scope.actions.some(action => !['conversation', 'task-tools', 'delegate-task'].includes(action))) blocked('Interactive scope must use explicit conversation/task-tools/delegate-task capabilities, not legacy host shell authority.');
    if (submission.receiver.taskId === null && scope.actions.includes('task-tools') && !scope.actions.includes('delegate-task')) blocked('A space tool envelope requires explicit delegation registration; spaces never receive an environment.');
    if (submission.receiver.taskId && ['cancellation-requested', 'cancelled', 'cancellation-uncertain'].includes(this.options.store.getTask(submission.receiver.taskId).state)) blocked('Task cancellation is retained. Start a new owner-approved task rather than silently continuing cancelled work.');
    const taskOrigin = submission.receiver.taskId ? this.options.store.getTaskOrigin(submission.receiver.taskId) : undefined;
    // A public owner parentTaskId is a product relationship, never execution authority.
    const parentRunId = taskOrigin?.coordinatorParentRunId;
    const message = this.options.store.getMessage(submission.messageId);
    // SDK user input is a transport role. Keep delegated authorship explicit in its payload.
    const prompt = message.origin ? JSON.stringify({ kind: 'delegated-task-request', role: message.role, origin: message.origin, text: submission.text }) : submission.text;
    return { ...scope, actions: [...scope.actions], settings: { model: submission.model, effort: submission.effort },
      runtime: submission.runtime as 'pi-local' | 'claude-local', taskId: stable('spatial', [submission.receiver.conversationId]), prompt,
      entry: 'interactive', interactive: { requestId: submission.id, conversationId: submission.receiver.conversationId, ...(parentRunId ? { parentRunId } : {}) } };
  }
  /** Submission is already durable. Returns after scheduling, not after a paid/model turn. */
  async queue(submission: Submission, owner: HostOwner): Promise<void> {
    await this.validateSettings(submission, owner);
    const current = this.options.store.getSubmission(submission.id);
    this.options.store.assertDestinationAvailable(current.receiver.spaceId, current.receiver.taskId);
    if (current.state !== 'queued' || this.pending.has(current.id)) return;
    let input: DispatchTaskInput;
    try { input = this.input(current); }
    catch (error) { this.block(current, error instanceof HostApiError ? error.message : 'Approved execution scope is unavailable.'); return; }
    this.options.store.updateSubmission(current.id, { state: 'submitting', coordinatorTaskId: input.taskId, detail: 'Persisted outbox request; awaiting coordinator admission.' });
    const operation = this.submit(current, input);
    this.pending.set(current.id, operation);
    void operation.finally(() => { this.pending.delete(current.id); }).catch(() => undefined);
  }
  private async submit(submission: Submission, input: DispatchTaskInput): Promise<void> {
    try {
      const result = await this.coordinator.interactiveSubmit(input);
      if (!result) throw new Error('Coordinator omitted durable submission identity.');
      this.observe(submission.id, result.run ?? result.result?.run, result.result?.outcome.kind, result.result?.outcome.summary, false, input);
    } catch {
      this.options.store.updateSubmission(submission.id, { state: 'uncertain', detail: 'Coordinator acknowledgement was lost. Reconcile the same request identity; do not retry inference automatically.' });
      this.options.store.updateMessage(submission.messageId, { state: 'uncertain' });
      if (submission.receiver.taskId) this.options.store.updateTask(submission.receiver.taskId, { state: 'remote-uncertain', detail: 'Execution acknowledgement lost; retained effects require reconciliation.' });
    }
  }
  private observe(submissionId: string, run?: RunRecord, outcome?: string, detail?: string, unconfirmedWorker = false, originalInput?: DispatchTaskInput): void {
    const store = this.options.store, submission = store.getSubmission(submissionId);
    const state = unconfirmedWorker ? 'remote-uncertain' : run?.status ?? outcome;
    const terminal = state === 'completed' || state === 'checks-failed';
    const uncertain = !state || state === 'remote-uncertain' || state === 'running';
    const text = detail ?? run?.summary ?? (state === 'running' ? 'Admitted bounded execution is running.' : 'Submission was received but execution status is uncertain. Reconcile its stable request identity.');
    store.updateSubmission(submission.id, { state: terminal ? 'settled' : state === 'running' ? 'submitted' : uncertain ? 'uncertain' : 'blocked', ...(run ? { coordinatorTaskId: run.taskId, runId: run.id } : {}), detail: text });
    store.updateMessage(submission.messageId, { state: terminal || state === 'running' ? 'complete' : uncertain ? 'uncertain' : 'failed' });
    if (submission.receiver.taskId) {
      const task = store.getTask(submission.receiver.taskId);
      const cancelling = ['cancellation-requested', 'cancelled', 'cancellation-uncertain'].includes(task.state);
      store.updateTask(task.id, { state: cancelling ? terminal ? 'cancelled' : 'cancellation-uncertain' : state ?? 'remote-uncertain', ...(run ? { coordinatorTaskId: run.taskId, runId: run.id } : {}), detail: text });
    }
    if (state !== 'running') {
      let before: string | undefined;
      do {
        const page = store.listMessages(submission.receiver.conversationId, { ...(before ? { before } : {}), limit: 500 });
        for (const message of page.messages) if (message.requestId === submission.id && (message.state === 'streaming' || message.state === 'pending') && message.id !== submission.messageId) store.updateMessage(message.id, { state: uncertain ? 'uncertain' : message.role === 'agent' ? 'failed' : 'uncertain' });
        before = page.nextBefore ?? undefined;
      } while (before);
    }
    if (!uncertain && !terminal) {
      let approval: InboxRequest | undefined;
      if (state === 'awaiting-approval' && !run) {
        try { approval = produceAuthorityHandoff(store, this.coordinator, submission, originalInput ?? this.input(submission)); } catch { /* Unavailable immutable scope remains a blocker, not a hypothetical permission request. */ }
      }
      if (!approval) this.inbox(submission, 'blocker', 'Execution needs owner action', text, run);
    }
    this.refreshReviews(submission.id);
    if (terminal) {
      const id = stable('execution-outcome', [submission.id]);
      store.appendMessage({ id, conversationId: submission.receiver.conversationId, requestId: submission.id, role: 'system', text: JSON.stringify({ source: 'coordinator', submissionId: submission.id, taskId: run?.taskId, runId: run?.id, outcome: state, detail: text, evidenceDir: run?.evidenceDir }), state: 'complete' });
    }
  }
  private block(submission: Submission, detail: string): void {
    this.options.store.updateSubmission(submission.id, { state: 'blocked', detail });
    this.options.store.updateMessage(submission.messageId, { state: 'failed' });
    if (submission.receiver.taskId) this.options.store.updateTask(submission.receiver.taskId, { state: 'setup-blocked', detail });
    this.inbox(submission, 'blocker', 'Execution needs owner setup/approval', detail);
  }
  private inbox(submission: Submission, kind: InboxRequest['kind'], title: string, detail: string, run?: RunRecord, suffix = ''): InboxRequest {
    const id = stable('execution-request', [submission.id, kind, title, suffix]);
    const existing = this.options.store.listInboxRequests().find(item => item.id === id);
    if (existing) { this.refreshReviews(submission.id); return this.options.store.getInboxRequest(id); }
    return this.options.store.createInboxRequest({ id, spaceId: submission.receiver.spaceId, taskId: submission.receiver.taskId, kind, title, detail,
      evidence: [JSON.stringify({ source: 'coordinator-interactive', submissionId: submission.id, taskId: run?.taskId, runId: run?.id, authority: run?.authority, evidenceDir: run?.evidenceDir, ...(kind === 'review' && run ? { reviewPin: this.coordinator.interactiveEvidencePin(run.id) } : {}) })] });
  }
  /** Producer refresh, separate from owner decisions. Every new pin retains a new Inbox version. */
  refreshReviews(submissionId?: string): void {
    const store = this.options.store;
    for (const request of store.listInboxRequests()) {
      if (request.kind !== 'review' || !['open', 'deferred'].includes(request.state)) continue;
      let changed = false;
      const evidence = request.evidence.map(value => {
        let source: Record<string, unknown>;
        try { source = JSON.parse(value) as Record<string, unknown>; } catch { return value; }
        if (source?.source !== 'coordinator-interactive' || typeof source.runId !== 'string' || typeof source.submissionId !== 'string' || (submissionId && source.submissionId !== submissionId)) return value;
        // A newer attempt must never silently replace this request's reviewed attempt.
        if (request.taskId && store.getTask(request.taskId).runId !== source.runId) {
          const disposition = { state: 'obsolete', reason: 'A newer attempt superseded this review. Inspect the old pin read-only or explicitly dismiss it; reviewing never moves its pin to the newer attempt.' };
          if (JSON.stringify(source.disposition) === JSON.stringify(disposition)) return value;
          changed = true; return JSON.stringify({ ...source, disposition });
        }
        try {
          const reviewPin = this.coordinator.interactiveEvidencePin(source.runId);
          const authority = this.coordinator.currentAuthoritySettings(source.runId, 'conversation', false);
          const reviewAuthority = authority.allowed ? { allowed: true } : { allowed: false, detail: authority.outcome.summary };
          const run = this.coordinator.interactiveLookup(source.submissionId)?.run;
          if (JSON.stringify(source.reviewPin) === JSON.stringify(reviewPin) && JSON.stringify(source.reviewAuthority) === JSON.stringify(reviewAuthority) && source.runStatus === run?.status) return value;
          changed = true;
          return JSON.stringify({ ...source, reviewPin, reviewAuthority, runStatus: run?.status });
        } catch { return value; } // Unreadable evidence stays stale; never invent a fresh pin.
      });
      if (changed) store.updateInboxRequest(request.id, request.version, { evidence });
    }
  }
  /** Bind to EnvironmentBroker.agent(preflight) inside its queue/read boundary. */
  assertTaskToolAllowed(submissionId: string, runId: string): void {
    const submission = this.options.store.getSubmission(submissionId);
    const current = this.coordinator.currentAuthoritySettings(runId, 'task-tools');
    if (!current.allowed || current.run.interactive?.requestId !== submission.id || current.run.interactive.conversationId !== submission.receiver.conversationId) throw new Error('Fixed-task run identity or authority is no longer current.');
    this.guard({ taskId: current.run.taskId, runId, task: '', repoPath: '', settings: {}, evidenceDir: current.run.evidenceDir ?? '', interactive: { requestId: submission.id, conversationId: submission.receiver.conversationId } }, 'task-tools');
  }
  private guard(input: DispatchInput, action: ActionId): void {
    this.active();
    const submission = input.interactive && this.options.store.getSubmission(input.interactive.requestId);
    if (submission) this.options.store.assertDestinationAvailable(submission.receiver.spaceId, submission.receiver.taskId);
    let taskId = submission?.receiver.taskId;
    while (taskId) {
      const task = this.options.store.getTask(taskId);
      this.options.store.assertDestinationAvailable(task.spaceId, task.id);
      if (['cancellation-requested', 'cancelled', 'cancellation-uncertain'].includes(task.state)) throw new Error('Task or delegation parent was cancelled.');
      taskId = task.parentTaskId;
    }
    if (submission && !this.options.scope(submission, this.coordinator)) throw new Error('Current owner receiver registration is unavailable.');
    if (this.cancellations.has(input.taskId) || !this.coordinator.currentAuthoritySettings(input.runId, action).allowed) throw new Error('Current admitted scope is unavailable or revoked.');
  }
  private link(input: DispatchInput): Submission {
    if (!input.interactive) throw new Error('Missing interactive identity.');
    const submission = this.options.store.getSubmission(input.interactive.requestId);
    if (submission.receiver.conversationId !== input.interactive.conversationId) throw new Error('Conversation identity mismatch.');
    this.observe(submission.id, this.coordinator.status({ taskId: input.taskId }).runs.find(item => item.run.id === input.runId)?.run);
    return submission;
  }
  private async tools(input: DispatchInput) {
    const submission = this.link(input);
    this.guard(input, 'conversation');
    const environment = this.coordinator.currentAuthoritySettings(input.runId, 'task-tools').allowed
      ? await this.options.environment(submission, input.runId) : null;
    this.guard(input, 'conversation');
    const handler = createTaskToolHandler({ coordinator: this.coordinator, runId: input.runId, environment,
      context: () => ({ source: { projectId: this.options.store.getSpace(submission.receiver.spaceId).projectId, ...submission.receiver,
        ...(submission.receiver.taskId ? { origin: this.options.store.getTaskOrigin(submission.receiver.taskId) } : {}) },
        sources: this.options.contextSources ? this.options.contextSources(submission) : this.options.store.listSources(submission.receiver.spaceId),
        conversation: this.options.store.getConversation(submission.receiver.conversationId),
        ownerDecisions: this.options.store.listInboxRequests().filter(request => request.spaceId === submission.receiver.spaceId && request.taskId === submission.receiver.taskId).map(request => ({ request, decisions: this.options.store.listInboxDecisions(request.id) })),
        children: this.options.store.snapshot().tasks.filter(task => task.parentTaskId !== null
          ? task.parentTaskId === submission.receiver.taskId
          : this.options.store.getTaskOrigin(task.id)?.parentConversationId === submission.receiver.conversationId).map(task => ({ task, source: { coordinatorTaskId: task.coordinatorTaskId, runId: task.runId } })) }),
      source: async sourceId => {
        this.guard(input, 'conversation');
        const source = this.options.readSource ? await this.options.readSource(submission, sourceId) : this.options.store.readSourceForSpace(submission.receiver.spaceId, sourceId);
        this.guard(input, 'conversation');
        return source;
      },
      request: (kind, title, detail) => this.inbox(submission, kind, title, detail, this.coordinator.status({ taskId: input.taskId }).runs.find(item => item.run.id === input.runId)?.run),
      delegate: async (key, title, prompt) => {
        this.guard(input, 'delegate-task');
        if (this.options.store.getSpace(submission.receiver.spaceId).projectId === null) throw new Error('Delegation requires an admitted project conversation parent.');
        const current = this.coordinator.currentAuthoritySettings(input.runId, 'delegate-task');
        if (!current.allowed) throw new Error('Parent delegation authority unavailable.');
        const child = this.options.store.createTask({ idempotencyKey: stable('child', [submission.id, key]), spaceId: submission.receiver.spaceId, title, prompt,
          runtime: submission.runtime, model: submission.model, effort: submission.effort, parentTaskId: submission.receiver.taskId,
          origin: { kind: 'agent-delegation', parentConversationId: submission.receiver.conversationId, parentTaskId: submission.receiver.taskId, coordinatorParentRunId: input.runId } });
        // Only creates child work. Admission shares the parent authority and resource envelope;
        // no model-selected identity, scope, runtime or operator actor enters the outbox.
        const childSubmission = this.options.store.getSubmissionByKey(stable('child', [submission.id, key]))!;
        if (childSubmission.state === 'queued') {
          const childInput = this.input(childSubmission);
          this.options.store.updateSubmission(childSubmission.id, { state: 'submitting', coordinatorTaskId: childInput.taskId, detail: 'Delegated bounded child awaiting shared coordinator admission.' });
          const operation = this.submit(childSubmission, childInput); this.pending.set(childSubmission.id, operation);
          void operation.finally(() => this.pending.delete(childSubmission.id)).catch(() => undefined);
        }
        return { source: { parentRunId: input.runId, submissionId: childSubmission.id }, task: this.options.store.getTask(child.id) };
      },
    });
    let toolSequence = 0;
    let acknowledgementUncertain = false;
    const tools: TaskToolHandler = async (name: string, args: unknown) => {
      this.guard(input, 'conversation');
      const toolId = stable('tool-operation', [input.runId, String(++toolSequence)]);
      const provenance = { source: 'guarded-task-tool', submissionId: submission.id, runId: input.runId, taskId: input.taskId, toolId, tool: name };
      this.options.store.appendMessage({ id: `${toolId}-request`, conversationId: submission.receiver.conversationId, requestId: submission.id, role: 'system', text: JSON.stringify({ ...provenance, phase: 'requested', arguments: args }), state: 'pending' });
      let acknowledged = false;
      try {
        const result = await handler(name, args);
        acknowledged = true;
        this.options.store.appendMessage({ id: `${toolId}-result`, conversationId: submission.receiver.conversationId, requestId: submission.id, role: 'system', text: JSON.stringify({ ...provenance, phase: 'acknowledged', result: { ...result, content: result.content.map(block => block.type === 'image' ? { type: 'image-evidence', mimeType: block.mimeType, sha256: createHash('sha256').update(block.data).digest('hex') } : block) } }), state: 'complete' });
        this.options.store.updateMessage(`${toolId}-request`, { state: 'complete' });
        return result;
      } catch {
        // A read/preflight denial has no future effects. A failed mutating acknowledgement
        // remains sticky even if the model catches the error and reports a normal final.
        acknowledgementUncertain ||= acknowledged && ['task_exec', 'task_write', 'task_input', 'task_delegate', 'task_request'].includes(name);
        const uncertain = acknowledgementUncertain || handler.effectsUncertain?.() === true;
        this.options.store.updateMessage(`${toolId}-request`, { state: uncertain ? 'uncertain' : 'failed' });
        this.options.store.appendMessage({ id: `${toolId}-result`, conversationId: submission.receiver.conversationId, requestId: submission.id, role: 'system', text: JSON.stringify({ ...provenance, phase: uncertain ? 'not-acknowledged' : 'denied', detail: uncertain ? 'Task effects were not acknowledged. Inspect retained effects; never automatically replay.' : 'Tool was denied before effects or a read failed. No task mutation was issued.' }), state: uncertain ? 'uncertain' : 'failed' });
        throw new Error(uncertain ? 'Task effects were not acknowledged. Inspect retained evidence; do not replay uncertain effects.' : 'Task tool denied or read failed; no mutation was issued.');
      }
    };
    Object.defineProperty(tools, 'effectsUncertain', { value: () => acknowledgementUncertain || handler.effectsUncertain?.() === true });
    return tools;
  }
  private event(input: DispatchInput, event: RuntimeEvent): void {
    const submission = this.options.store.getSubmission(input.interactive!.requestId);
    if (event.type === 'session') {
      if (!event.sessionId) throw new Error('Runtime omitted its handshake identity.');
      this.coordinator.interactiveSessionRecord(input.runId, submission.id, { id: event.sessionId });
      this.options.store.appendMessage({ id: stable('runtime-session', [submission.id]), conversationId: submission.receiver.conversationId, requestId: submission.id, role: 'system', text: JSON.stringify({ source: 'runtime-handshake', runtime: submission.runtime, sessionId: event.sessionId, runId: input.runId, submissionId: submission.id, model: event.model ?? 'unknown', effort: event.effort ?? 'unknown' }) }); return;
    }
    if (event.type !== 'delta' && event.type !== 'message') return;
    const id = stable('runtime-message', [submission.id, event.messageId ?? '0']);
    let existing;
    try { existing = this.options.store.getMessage(id); } catch { /* First event for this stable runtime message id. */ }
    if (!existing) this.options.store.appendMessage({ id, conversationId: submission.receiver.conversationId, requestId: submission.id, role: 'agent', text: event.text ?? '', state: event.type === 'delta' ? 'streaming' : event.state ?? 'complete' });
    else this.options.store.updateMessage(id, { text: event.type === 'delta' ? existing.text + (event.text ?? '') : event.text ?? existing.text, state: event.type === 'delta' ? 'streaming' : event.state ?? 'complete' });
  }
  /** Public recovery/lookup only. Never redispatch submitted/uncertain requests or tool effects. */
  async reconcile(): Promise<void> {
    this.active();
    const submissions = this.options.store.pendingSubmissions().filter(submission => !this.pending.has(submission.id) && submission.state !== 'queued');
    for (const runtime of new Set(submissions.map(submission => submission.runtime))) {
      if (runtime === 'pi-local' || runtime === 'claude-local') {
        try { await this.coordinator.recover(runtime); }
        catch { /* Lookup retains uncertain state; failed recovery is not live execution proof. */ }
      }
    }
    for (const submission of submissions) {
      const found = this.coordinator.interactiveLookup(submission.id);
      const run = found?.run ?? found?.result?.run;
      const unconfirmed = run?.status === 'running' && !this.adapters.get(run.runtime)?.hasLiveRun(run.id);
      this.observe(submission.id, run, found?.result?.outcome.kind,
        unconfirmed ? 'Coordinator retains an admitted run, but this host cannot confirm a live interactive worker. Recovering/uncertain; no execution or tool effect is replayed.' : found?.result?.outcome.summary, unconfirmed);
    }
    this.refreshReviews();
  }
  async waitForIdle(): Promise<void> { while (this.pending.size) await Promise.all([...this.pending.values()]); }
  async interrupt(task: TaskWindow, mode: 'turn' | 'task', owner: HostOwner): Promise<{ state: string; detail: string }> {
    const actor = await this.options.authenticateOwner(owner); this.active();
    const current = this.options.store.getTask(task.id);
    if (!current.coordinatorTaskId || !current.runId) return { state: 'blocked', detail: 'No admitted run to interrupt.' };
    const run = this.coordinator.status({ taskId: current.coordinatorTaskId }).runs.find(item => item.run.id === current.runId)?.run;
    if (!run?.interactive) return { state: 'blocked', detail: 'Legacy jobs are imported/read-only, not guarded interactive work.' };
    if (mode === 'turn') {
      const stopped = run.sessionId && await this.adapters.get(run.runtime)?.abortTurn(run.sessionId);
      return { state: stopped ? 'turn-aborted' : 'uncertain', detail: stopped ? 'Turn abort acknowledged. The task/environment remains; no task cancellation or revocation was implied.' : 'No active worker acknowledged turn abort. Reconcile retained effects before continuing.' };
    }
    this.cancellations.add(run.taskId);
    this.options.store.updateTask(current.id, { state: 'cancellation-requested', detail: 'Owner requested task cancellation. New tools and follow-up execution are fenced; in-flight effects remain possible.' });
    try {
      await this.coordinator.runStop(actor, run.id);
      return { state: 'cancellation-requested', detail: 'Current turn stop acknowledged and further task tools fenced. Already issued effects may be uncertain. Environment stop/reset is a separate confirmed owner control.' };
    } catch {
      return { state: 'uncertain', detail: 'Task cancellation could not be acknowledged. Further tools remain fenced; reconcile the worker and environment before retrying.' };
    }
  }
  /** Owner-mediated explicit service functions. Never invoked automatically/by tools. */
  async approveScope(owner: HostOwner, input: ApprovalInput) { this.active(); return this.coordinator.approve(await this.options.authenticateOwner(owner), input); }
  async createGrant(owner: HostOwner, input: GrantInput) { this.active(); return this.coordinator.grantCreate(await this.options.authenticateOwner(owner), input); }
  async decide(request: InboxRequest, decision: OwnerDecision, owner: HostOwner): Promise<ReturnType<WorkspaceStore['respondInbox']> | void> {
    const actor = await this.options.authenticateOwner(owner); this.active();
    const current = this.options.store.getInboxRequest(request.id);
    if (current.version !== request.version || !['open', 'deferred'].includes(current.state)) throw new HostApiError(409, 'stale-request', 'Request changed before owner decision.', 'Refresh current evidence.');
    if (decision.action === 'approve') return confirmAuthorityHandoff(this.options.store, this.coordinator, actor, request, decision, submission => { this.active(); return this.input(submission); });
    if (decision.action === 'review') {
      const pins = current.evidence.flatMap(evidence => {
        try { const source = JSON.parse(evidence) as Record<string, unknown>; return source.source === 'coordinator-interactive' && typeof source.runId === 'string' ? [source] : []; }
        catch { return []; }
      });
      const taskRunId = current.taskId ? this.options.store.getTask(current.taskId).runId : null;
      if (taskRunId || pins.length) {
        const source = pins[0];
        if (pins.length !== 1 || !source?.reviewPin || typeof source.submissionId !== 'string' || (taskRunId && taskRunId !== source.runId)) throw new HostApiError(409, 'stale-review-evidence', 'Run-backed review lacks one current pinned coordinator attempt.', 'Refresh the request from current run/authority/evidence before reviewing.');
        try {
          this.coordinator.interactiveReviewRecord(actor, { decisionId: decision.idempotencyKey, requestId: current.id, submissionId: source.submissionId,
            pin: source.reviewPin as Parameters<CoordinatorCommands['interactiveReviewRecord']>[1]['pin'], text: decision.text });
        } catch { throw new HostApiError(409, 'stale-review-evidence', 'Coordinator authority, run/evidence or candidate head changed before this review.', 'Refresh the request and its current coordinator evidence. No approval/delivery/merge authority was issued.'); }
      }
    }
    if (decision.action === 'answer' || decision.action === 'review') {
      // Product answers/reviews preserve their exact conversation and evidence. They do not
      // authorize new inference, approve delivery/merge, or manufacture coordinator outcomes.
      const space = this.options.store.getSpace(current.spaceId);
      const conversationId = current.taskId ? this.options.store.getTask(current.taskId).conversationId : space.conversationId;
      this.options.store.appendMessage({ id: stable('owner-decision', [current.id, String(current.version), decision.idempotencyKey]), conversationId, role: 'owner', text: JSON.stringify({ source: 'authenticated-owner-inbox', requestId: current.id, version: current.version, action: decision.action, text: decision.text, evidence: current.evidence }) });
    }
  }
}
