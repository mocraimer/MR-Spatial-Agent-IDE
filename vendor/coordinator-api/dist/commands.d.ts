import { interactiveArchive, interactiveArchiveLookup, interactiveArchiveReconcile } from './core/interactive-archive.js';
import { interactiveLookup, interactiveSubmit, interactiveEvidencePin, interactiveReviewRecord, interactiveRuntimeResultRecord, currentAuthoritySettings } from './core/interactive.js';
import { buildIdentityView } from './core/build.js';
import { listReservations } from './core/admission.js';
import type { AdmissionDecision, SubscriptionPolicy, UsageEstimate } from './core/admission.js';
import type { CallReservation, LedgerPolicy } from './core/ledger.js';
import type { ActionId, Actor, Approval, ApprovalInput, AuthorityRef, DispatchRequest, Grant, GrantInput, NarrowInput, PerTaskLimits, RuntimeId } from './core/authority.js';
import { authorityPreviewForOperator, authorityConfirmationRecord } from './core/interactive-authority.js';
import type { Outcome } from './core/outcome.js';
import { activeRuns } from './core/run.js';
import type { RunRecord } from './core/run.js';
import type { Job, ReconcileReport } from './core/intake.js';
import type { CiFailureEvent, IntakeConfig, IntakeResult } from './core/ci-intake.js';
import { stateRoot } from './core/store.js';
import type { CandidateIdentity } from './core/run.js';
import type { EvidenceItem, RequiredCheck, AggregateReport } from './core/evidence.js';
import type { RuntimeAdapter, RuntimeCapabilities, SettingsRequest } from './adapters/types.js';
import type { UsageResult } from './core/usage.js';
import type { CaseComparison, EvalSuite, TrialResult } from './eval/oracle.js';
import type { CheckInput, FeedbackVerdict, GroupReport, LoopRecord, RepairInput, ReviewInput, Scorecard } from './eval/scorecard.js';
import type { ActivateInput, ActiveVersionRecord, CandidateRecord } from './core/version.js';
/** The runtimes exposed by the coordinator's public command surfaces. */
export declare const RUNTIMES: RuntimeId[];
/** Configuration read by both the CLI and the MCP command layer. */
export interface Config {
    operator?: string;
    claudeCloudSessionId?: string;
    codexEnvId?: string;
    codexSkillEntryVerified?: boolean;
}
export declare const configPath: () => string;
export declare const readConfig: () => Config;
export declare const writeConfig: (config: Config) => void;
/** Construct the same runtime adapter the CLI uses, without accepting agent input as configuration. */
export declare function adapterFor(runtime: RuntimeId): RuntimeAdapter;
export type AdapterFactory = (runtime: RuntimeId) => RuntimeAdapter;
export declare const VALID_ACTIONS: readonly ActionId[];
export declare const ESTIMATE_BASES: readonly UsageEstimate['basis'][];
/** Bounds applied at the shared command boundary before an adapter can run. */
export declare const DISPATCH_LIMITS: {
    readonly identifierLength: 256;
    readonly promptLength: 100000;
    readonly detailLength: 4000;
    readonly maxActions: 6;
    readonly maxTimeoutMs: 3600000;
};
export declare class CommandInputError extends Error {
    readonly name = "CommandInputError";
}
export interface StatusInput {
    taskId?: string;
    now?: number;
}
export interface StatusRun {
    run: RunRecord;
    elapsedSeconds: number;
    active: boolean;
}
export interface StatusView {
    generatedAt: string;
    runs: StatusRun[];
    reservations: ReturnType<typeof listReservations>;
}
export interface JobsView {
    generatedAt: string;
    jobs: Job[];
}
export interface UsageInput {
    runtime?: RuntimeId;
}
export interface UsageRuntimeView {
    runtime: RuntimeId;
    subscriptionId: string;
    capabilities: RuntimeCapabilities;
    policy: SubscriptionPolicy;
    reservations: ReturnType<typeof listReservations>;
    result: UsageResult;
}
export interface UsageView {
    generatedAt: string;
    runtimes: UsageRuntimeView[];
}
export interface ReadinessInput {
    runtime?: RuntimeId;
}
export interface ReadinessRuntimeView {
    runtime: RuntimeId;
    capabilities: RuntimeCapabilities;
    ready: boolean;
    outcome: Outcome | null;
}
export interface ReadinessView {
    generatedAt: string;
    runtimes: ReadinessRuntimeView[];
}
export interface EvidenceInput {
    candidate?: CandidateIdentity;
    evidence?: EvidenceItem[];
    enforceDeferred?: readonly string[];
    maxEvidenceAgeMs?: number;
    now?: number;
}
export interface EvidenceView {
    generatedAt: string;
    requiredChecks: RequiredCheck[];
    deferred: string[];
    evidenceCount: number;
    configuration: {
        valid: true;
    } | {
        valid: false;
        error: string;
    };
    report?: AggregateReport;
}
export type EvaluationViewName = 'summary' | 'scorecards' | 'suites' | 'trials' | 'compare';
export interface EvaluationInput {
    view?: EvaluationViewName;
    repo?: string;
    workClass?: string;
    runtime?: RuntimeId;
    authorityId?: string;
    effectiveConfiguration?: string;
    workflowVersion?: string;
    configurationA?: string;
    configurationB?: string;
}
export type EvaluationView = {
    view: 'summary';
    scorecards: {
        report: Omit<GroupReport, 'evidence' | 'recordedAttempts'>;
        count: number;
    };
    suites: {
        count: number;
    };
    trials: {
        count: number;
    };
} | {
    view: 'scorecards';
    scorecards: Scorecard[];
    report: GroupReport;
} | {
    view: 'suites';
    suites: EvalSuite[];
} | {
    view: 'trials';
    trials: TrialResult[];
} | {
    view: 'compare';
    configurationA: string;
    configurationB: string;
    comparisons: CaseComparison[];
};
export interface DispatchTaskInput {
    taskId: string;
    repo: string;
    workClass: string;
    runtime: RuntimeId;
    profile: string;
    actions: ActionId[];
    approvalId?: string;
    triggerSource?: string;
    prBase?: string;
    targetProject?: string;
    prompt: string;
    repoPath?: string;
    jobId?: string;
    settings: SettingsRequest;
    estimate: UsageEstimate;
    timeoutMs?: number;
    /** How the prompt reaches the runtime; see `DispatchInput.entry`. Defaults to the skill entry. */
    entry?: 'skill' | 'review-pr' | 'prompt' | 'interactive';
    interactive?: {
        requestId: string;
        conversationId: string;
        parentRunId?: string;
    };
    /** The versioned template the prompt was rendered from, recorded on the run's settings snapshot. */
    promptVersion?: {
        template: string;
        digest: string;
    };
    outputPath?: string;
    loop?: LoopRecord;
    setupStartedAt?: string;
}
/** The file in a run's evidence directory that holds the dispatch request it was started from. */
export declare const DISPATCH_REQUEST_FILE = "dispatch-request.json";
export interface DispatchCommandResult {
    outcome: Outcome;
    recovered: ReconcileReport[];
    /** True only after the selected runtime adapter's dispatch method was called. */
    runtimeDispatched: boolean;
    authority?: AuthorityRef;
    limits?: PerTaskLimits;
    admission?: AdmissionDecision;
    run?: RunRecord;
}
export interface AuthorityView {
    generatedAt: string;
    operatorConfigured: boolean;
    approvals: Approval[];
    grants: Grant[];
}
export interface PolicyView {
    generatedAt: string;
    policy: SubscriptionPolicy;
}
export interface LedgerView {
    generatedAt: string;
    policy: LedgerPolicy;
    remainingUsd: number;
    calls: CallReservation[];
}
export interface VersionView {
    generatedAt: string;
    active: ActiveVersionRecord | null;
    candidates: CandidateRecord[];
    history: ActiveVersionRecord[];
    identity: ReturnType<typeof buildIdentityView>;
}
export interface FeedbackInput {
    verdict: FeedbackVerdict;
    reason: string;
}
export interface CheckMutationResult {
    checks: RequiredCheck[];
    changed: RequiredCheck;
}
export declare function authorityView(): AuthorityView;
export declare function policyView(subscriptionId: string): PolicyView;
export declare function ledgerView(): LedgerView;
export declare function versionView(): VersionView;
/** Operator-only authority creation; the MCP surface intentionally does not expose this. */
export declare function approve(actor: Actor, input: ApprovalInput): Approval;
export declare function approvalList(): Approval[];
export declare function approvalGet(id: string): Approval | undefined;
/** Operator-only grant lifecycle methods; narrowing still cannot widen. */
export declare function grantCreate(actor: Actor, input: GrantInput): Grant;
export declare function grantList(): Grant[];
export declare function grantGet(id: string): Grant | undefined;
export declare function grantNarrow(actor: Actor, id: string, input: NarrowInput): Grant;
export declare function grantRevoke(actor: Actor, id: string, reason: string): Grant;
/** Change a subscription threshold through the same operator gate as the CLI. */
export declare function policySet(actor: Actor, policy: SubscriptionPolicy): SubscriptionPolicy;
/** Change the paid-call allowance through an operator-only path. */
export declare function ledgerAllowanceSet(actor: Actor, allowanceUsd: number): LedgerPolicy;
/** Defer a check only as the configured operator, and return the full new list. */
export declare function checkDefer(actor: Actor, name: string, reason: string): CheckMutationResult;
export declare function checkRestore(actor: Actor, name: string): CheckMutationResult;
/** Record a human verdict; agent/evaluation text cannot supply the actor. */
export declare function feedbackRecord(actor: Actor, scorecardId: string, input: FeedbackInput): Scorecard;
/** Evidence is operator-attested data; it grants no authority or acceptance. */
export declare function checkResultRecord(actor: Actor, scorecardId: string, input: CheckInput): Scorecard;
export declare function reviewRecord(actor: Actor, scorecardId: string, input: ReviewInput): Scorecard;
export declare function repairRecord(actor: Actor, scorecardId: string, input: RepairInput): Scorecard;
export declare function versionActivate(actor: Actor, input: ActivateInput): ActiveVersionRecord;
export declare function versionRollback(actor: Actor): ActiveVersionRecord;
/** Record a CI event as data and apply the existing grant/intake rules. */
export declare function intakeFailure(event: CiFailureEvent, input: IntakeConfig): IntakeResult;
/**
 * Read the current run and reservation records without making a vendor call.
 * `elapsedSeconds` is a fact about wall-clock time, not a progress estimate.
 */
export declare function statusView(input?: StatusInput): StatusView;
export declare function jobsView(): JobsView;
export declare function usageView(input?: UsageInput, adapterFactory?: AdapterFactory): Promise<UsageView>;
export declare function readinessView(input?: ReadinessInput, adapterFactory?: AdapterFactory): Promise<ReadinessView>;
export declare function evidenceView(input?: EvidenceInput): EvidenceView;
export declare function evaluationView(input?: EvaluationInput): EvaluationView;
export interface ResolvePiInput {
    runId: string;
    confirmStopped: boolean;
    evidence: string;
    reason: string;
}
/** Manual recovery only: the operator checked the group AND escaped descendants. */
export declare function resolvePiStopped(actor: Actor, input: ResolvePiInput): RunRecord;
export interface RunStopResult {
    runId: string;
    taskId: string;
    stoppedBy: string;
    at: string;
}
/**
 * Stop a run in flight, as an operator.
 *
 * Signals the runtime's process; the dispatch that started the run then records
 * how it ended, and its reservation is settled by the ordinary recovery path. The
 * stop itself is recorded on the task's scorecard with who made it.
 */
export declare function runStop(actor: Actor, runId: string, adapterFactory?: AdapterFactory): Promise<RunStopResult>;
/**
 * Send a finished or stopped run's task again: the same request, so the same
 * text and the same authority, as a new run with a new id.
 */
export declare function runRedispatch(actor: Actor, runId: string, adapterFactory?: AdapterFactory): Promise<DispatchCommandResult>;
/** Reconcile only the selected runtime, or every runtime for the public recovery command. */
export declare function recoverUnsettled(runtimeFilter?: RuntimeId, adapterFactory?: AdapterFactory): Promise<ReconcileReport[]>;
/**
 * Run the shared dispatch sequence for CLI, MCP, UI, loop and retry callers.
 * Authority scope precedes any vendor call. After recovery and the usage read,
 * one synchronous cross-process claim checks current authority, reserves account
 * headroom and publishes the run. Revocation uses that same lock. Neither vendor
 * reads nor real jobs hold it.
 */
export declare function dispatchTask(input: DispatchTaskInput, adapterFactory?: AdapterFactory, expectedAuthority?: AuthorityRef): Promise<DispatchCommandResult>;
export declare function toAuthorityRequest(input: DispatchTaskInput): DispatchRequest;
export declare function assertDispatchInput(input: DispatchTaskInput): void;
export interface CoordinatorCommands {
    /** Read-only views used by the CLI, local UI, and MCP adapter. */
    status(input?: StatusInput): StatusView;
    jobs(): JobsView;
    authority(): AuthorityView;
    policy(subscriptionId: string): PolicyView;
    ledger(): LedgerView;
    version(): VersionView;
    usage(input?: UsageInput): Promise<UsageView>;
    readiness(input?: ReadinessInput): Promise<ReadinessView>;
    evidence(input?: EvidenceInput): EvidenceView;
    evaluation(input?: EvaluationInput): EvaluationView;
    /** The configured id is read-only; callers cannot set it through this layer. */
    configuredOperator(): string | undefined;
    /** Operator-gated mutation methods; the MCP server does not expose these. */
    approve(actor: Actor, input: ApprovalInput): Approval;
    approvalList(): Approval[];
    approvalGet(id: string): Approval | undefined;
    grantCreate(actor: Actor, input: GrantInput): Grant;
    grantList(): Grant[];
    grantGet(id: string): Grant | undefined;
    grantNarrow(actor: Actor, id: string, input: NarrowInput): Grant;
    grantRevoke(actor: Actor, id: string, reason: string): Grant;
    policySet(actor: Actor, policy: SubscriptionPolicy): SubscriptionPolicy;
    ledgerAllowanceSet(actor: Actor, allowanceUsd: number): LedgerPolicy;
    checkDefer(actor: Actor, name: string, reason: string): CheckMutationResult;
    checkRestore(actor: Actor, name: string): CheckMutationResult;
    feedbackRecord(actor: Actor, scorecardId: string, input: FeedbackInput): Scorecard;
    checkResultRecord(actor: Actor, scorecardId: string, input: CheckInput): Scorecard;
    reviewRecord(actor: Actor, scorecardId: string, input: ReviewInput): Scorecard;
    repairRecord(actor: Actor, scorecardId: string, input: RepairInput): Scorecard;
    versionActivate(actor: Actor, input: ActivateInput): ActiveVersionRecord;
    versionRollback(actor: Actor): ActiveVersionRecord;
    intakeFailure(event: CiFailureEvent, input: IntakeConfig): IntakeResult;
    recover(runtime?: RuntimeId): Promise<ReconcileReport[]>;
    dispatch(input: DispatchTaskInput): Promise<DispatchCommandResult>;
    interactiveSubmit(input: DispatchTaskInput): ReturnType<typeof interactiveSubmit>;
    interactiveLookup(requestId: string): ReturnType<typeof interactiveLookup>;
    interactiveSessionRecord(runId: string, requestId: string, session: {
        id: string;
        file?: string;
    }): RunRecord;
    interactiveEvidencePin: typeof interactiveEvidencePin;
    interactiveReviewRecord: typeof interactiveReviewRecord;
    authorityPreviewForOperator: typeof authorityPreviewForOperator;
    authorityConfirmationRecord: typeof authorityConfirmationRecord;
    interactiveRuntimeResultRecord: typeof interactiveRuntimeResultRecord;
    interactiveArchive: typeof interactiveArchive;
    interactiveArchiveLookup: typeof interactiveArchiveLookup;
    interactiveArchiveReconcile: typeof interactiveArchiveReconcile;
    currentAuthoritySettings(runId: string, action?: ActionId, requireRunning?: boolean): ReturnType<typeof currentAuthoritySettings>;
    runStop(actor: Actor, runId: string): Promise<RunStopResult>;
    resolvePiStopped(actor: Actor, input: ResolvePiInput): RunRecord;
    runRedispatch(actor: Actor, runId: string): Promise<DispatchCommandResult>;
}
/** Factory used by production clients and by tests with fake adapters. */
export declare function createCoordinatorCommands(adapterFactory?: AdapterFactory): CoordinatorCommands;
export declare const commands: CoordinatorCommands;
/** Public type surface for UI/client implementations; the implementations stay in the coordinator. */
export type { AuthorityConfirmationInput, AuthorityConfirmationReceipt } from './core/interactive-authority.js';
export type { InteractiveArchiveInput, InteractiveArchiveReceipt, InteractiveArchiveObservation, InteractiveArchiveCommit, InteractiveArchiveObserve } from './core/interactive-archive.js';
export type { ActionId, Actor, Approval, ApprovalInput, AuthorityRef, DispatchRequest, Grant, GrantInput, NarrowInput, PerTaskLimits, RuntimeId, } from './core/authority.js';
export type { AdmissionDecision, SubscriptionPolicy, UsageEstimate, } from './core/admission.js';
export type { Outcome } from './core/outcome.js';
export type { RunRecord, CandidateIdentity } from './core/run.js';
export type { Job, ReconcileReport } from './core/intake.js';
export type { EvidenceItem, RequiredCheck, AggregateReport } from './core/evidence.js';
export type { RuntimeAdapter, RuntimeCapabilities, SettingsRequest } from './adapters/types.js';
export type { UsageResult } from './core/usage.js';
export type { CallReservation, LedgerPolicy } from './core/ledger.js';
export type { ActivateInput, ActiveVersionRecord, CandidateRecord } from './core/version.js';
export type { CiFailureEvent, IntakeConfig, IntakeResult } from './core/ci-intake.js';
export type { CheckInput, CheckResult, CompletedReview, FeedbackVerdict, FindingInput, GroupKey, GroupReport, RepairCycle, RepairInput, Reviewer, ReviewerFinding, ReviewerRelationship, ReviewInput, Scorecard, } from './eval/scorecard.js';
export type { CaseComparison, EvalSuite, TrialResult } from './eval/oracle.js';
export { stateRoot, activeRuns };
