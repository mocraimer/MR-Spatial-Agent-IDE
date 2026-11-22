import type { AuthorityRef, RuntimeId } from '../core/authority.js';
import type { Outcome, OutcomeKind } from '../core/outcome.js';
import type { RunRecord, SettingsSnapshot } from '../core/run.js';
/**
 * The operator's own judgement of a task's result.
 *
 * Kept apart from every measured signal on purpose: a green test run, an agent
 * saying it succeeded, and a person saying the work was good are three different
 * claims, and only the last is this.
 */
export type FeedbackVerdict = 'accepted' | 'rework-needed' | 'rejected';
export interface OperatorFeedback {
    verdict: FeedbackVerdict;
    /** Who said so. An unattributed verdict is not recorded. */
    by: string;
    reason: string;
    at: string;
    /** Set when this supersedes an earlier verdict, which is kept. */
    supersedes?: FeedbackVerdict;
    /** True for suite fixtures, so they can never be counted as real acceptance. */
    isFixture?: boolean;
}
/** What a check reported, kept separate from what a person thought of it. */
export interface CheckResult {
    name: string;
    outcome: 'passed' | 'failed' | 'skipped';
    source: string;
    /** Absent on older records; never inferred from when a report is read. */
    at?: string;
    head?: string;
}
/** New writes require an explicit full commit ID; old stored checks may lack one. */
export type CheckInput = CheckResult & {
    head: string;
};
export type ReviewerRelationship = 'author' | 'independent' | 'not-independent';
/** Independence is derived from the relationship, never supplied as a boolean. */
export type Reviewer = {
    id: string;
} & ({
    relationship: 'author' | 'not-independent';
    independent: false;
} | {
    relationship: 'independent';
    independent: true;
});
export interface FindingInput {
    severity: 'critical' | 'high' | 'medium' | 'low';
    summary: string;
}
export interface ReviewInput {
    /** Stable person/session identities, not merely the model or runtime name. */
    author: string;
    reviewer: {
        id: string;
        relationship: ReviewerRelationship;
    };
    /** Review dimension, report path or URL. */
    source: string;
    head: string;
    /** An explicit empty array records a completed review with no findings. */
    findings: FindingInput[];
    /** A reviewer skill may own the detailed findings in GitHub while returning only their count. */
    findingCount?: number;
    at?: string;
}
export interface ReviewEvidence {
    author: string;
    reviewer: Reviewer;
    source: string;
    /** Absent on older records; new writes require an explicit full commit ID. */
    head?: string;
    at: string;
}
export interface ReviewerFinding extends ReviewEvidence, FindingInput {
}
/** Kept even when a completed review produced no findings. */
export interface CompletedReview extends ReviewEvidence {
    findingCount: number;
}
export interface RepairCycle {
    at: string;
    trigger: 'review-finding' | 'failed-check';
    detail: string;
    /** Head the repair produced, so the renewed checks are attributable. */
    head?: string;
}
export type RepairInput = Omit<RepairCycle, 'at' | 'head'> & {
    head: string;
    at?: string;
};
/**
 * Usage a run actually consumed.
 *
 * Every field is optional and absence means unknown. Nothing here defaults to
 * zero: a vendor that reports nothing must not look free, and an account delta
 * contaminated by other activity is not a per-run figure.
 */
export interface UsageRecord {
    admissionEstimatePercent?: {
        fiveHour: number;
        weekly: number;
    };
    observedAccountDeltaPercent?: {
        fiveHour: number;
        weekly: number;
    };
    /** True when other activity on the account could have contributed to the delta. */
    deltaContaminated?: boolean;
    reservationId?: string;
    resetContext?: string;
    paidCallUsd?: number;
    paidCallUnknown?: boolean;
}
/**
 * What the loop knew about a run it dispatched: which stage, which ticket or pull
 * request, and what came of it on GitHub. The trust report is computed from these.
 *
 * Optional: a scorecard for work dispatched by hand has none, and every card
 * written before the loop existed still loads.
 */
export interface LoopRecord {
    stage: string;
    /** `#123` for a ticket, `PR #456` for a pull request. */
    item: string;
    /** The ticket's `type:` slug, or `untyped`; groups evidence by kind of work. */
    workType: string;
    /** The stop-line in force for the item when the run was dispatched. */
    stopLine?: number;
    head?: string;
    /** Review stage: digest of the pull request description the review was given, which with the head says what was reviewed. */
    bodyDigest?: string;
    /** Review stage: the reviewer family differed from the author's. */
    independent?: boolean;
    /** Review stage: findings the review reported. */
    findings?: number;
    /** Fix stage: which review → fix round this was. */
    round?: number;
    /** Fix stage: PR branch and base pinned before dispatch. */
    fixBranch?: string;
    fixBase?: string;
    /** Fix stage: PR description digest before dispatch, never inferred from a later PR. */
    descriptionBeforeDigest?: string;
    /** Fix stage: newest review-marker comment ID at dispatch, if one existed. */
    reviewCommentAtDispatch?: number;
    /** Sweep stage: true only when no PR existed for the ticket at dispatch. */
    sweepNoPullAtDispatch?: boolean;
    /** Sweep stage: base branch recorded at dispatch. */
    sweepBase?: string;
    /** An operator's explicit attestation for this particular run, not a loop write. */
    attestedDelivery?: {
        runId: string;
        kind: 'description' | 'sweep';
        pr: number;
        head: string;
        bodyDigest?: string;
        reviewCommentAtDispatch?: number;
        /** Newest review-marker comment when the operator attested, after the worker finished. */
        reviewCommentAtAttestation?: number;
        round?: number;
        by: string;
        reason: string;
        at: string;
    };
    /** Merge stage: the merge the loop made after this run's readiness check. */
    merged?: {
        into: string;
        head: string;
        at: string;
    };
    /** Sweep stage: the run ended with the ticket escalated. */
    escalated?: boolean;
    /** What the loop wrote to GitHub for this run: a comment, pull request or issue. */
    wrote?: string;
}
export interface Scorecard {
    id: string;
    taskId: string;
    repo: string;
    workClass: string;
    authority: AuthorityRef;
    runtime: RuntimeId;
    profile: string;
    settings: SettingsSnapshot;
    /** Version of the coordinator and prompts that produced this. */
    workflowVersion: string;
    attempts: number;
    runIds: string[];
    manifestPaths: string[];
    candidateHead?: string;
    prUrl?: string;
    checks: CheckResult[];
    reviewerFindings: ReviewerFinding[];
    /** Absent on old cards means no recorded completed review, not a clean review. */
    reviews?: CompletedReview[];
    repairs: RepairCycle[];
    elapsedMs?: number;
    usage: UsageRecord;
    blockers: string[];
    finalStatus: OutcomeKind | 'running';
    /** Absent means unrated. Unrated real work stays unrated. */
    feedback?: OperatorFeedback;
    /** Earlier verdicts, kept when a later one supersedes them. */
    feedbackHistory?: OperatorFeedback[];
    /** Operator attestations for specific attempts, kept when a later retry replaces `loop`. */
    attestedDeliveries?: Array<NonNullable<LoopRecord['attestedDelivery']>>;
    /** Set when the loop dispatched the run. */
    loop?: LoopRecord;
    /** Runs an operator stopped while they were in flight, and who stopped them. */
    stops?: Array<{
        runId: string;
        by: string;
        at: string;
    }>;
    createdAt: string;
}
export declare function listScorecards(): Scorecard[];
export declare function getScorecard(id: string): Scorecard | undefined;
export declare function saveScorecard(card: Scorecard): void;
/** Build a scorecard from a run and whatever else is known about the task. */
export declare function scorecardFromRun(run: RunRecord, extra: Partial<Scorecard> & {
    repo: string;
    workClass: string;
    workflowVersion: string;
}): Scorecard;
/**
 * Keep the reason a run remains unresolved on its scorecard.
 *
 * Quota-waiting and remote-uncertain outcomes are history, not successful runs.
 * Checks-failed is different: the local run has stopped without confirmed success.
 * Its summary says whether checks failed or the result could not be verified;
 * either way it remains visible as a failed attempt rather than a live blocker.
 */
export declare function blockersFor(outcome: Pick<Outcome, 'kind' | 'summary'>): string[];
export declare class FeedbackError extends Error {
    readonly name = "FeedbackError";
}
/**
 * Record an operator's verdict on a task.
 *
 * A verdict needs an identity and a reason; an unattributed one is refused rather
 * than stored anonymously, because the whole value of this field is that a person
 * stands behind it. Correcting a verdict keeps the earlier one.
 */
export declare function recordFeedback(scorecardId: string, feedback: Omit<OperatorFeedback, 'at'> & {
    at?: string;
}): Scorecard;
export declare class ScorecardEvidenceError extends Error {
    readonly name = "ScorecardEvidenceError";
}
export declare function recordCheckResult(id: string, input: CheckInput): Scorecard;
export declare function recordReview(id: string, input: ReviewInput): Scorecard;
/**
 * Attach or extend the loop's record of a run it dispatched. Merges onto what is
 * already there on purpose: a later write for the same run adds what it learned
 * (the merge a check led to, say) without restating the rest.
 */
export declare function recordLoop(id: string, record: Partial<LoopRecord> & Pick<LoopRecord, 'stage' | 'item' | 'workType'>): Scorecard;
export declare function recordRepairCycle(id: string, input: RepairInput): Scorecard;
export interface ScorecardEvidenceReport {
    scorecardId: string;
    taskId: string;
    checkStatus: 'not-recorded' | 'recorded';
    reviewStatus: 'not-reviewed' | 'reviewed';
    independentReviewStatus: 'not-reviewed' | 'reviewed';
    checks: CheckResult[];
    reviews: CompletedReview[];
    reviewerFindings: ReviewerFinding[];
    repairs: RepairCycle[];
}
export interface GroupKey {
    repo?: string;
    workClass?: string;
    authorityId?: string;
    runtime?: RuntimeId;
    effectiveConfiguration?: string;
    workflowVersion?: string;
}
export interface GroupReport {
    key: GroupKey;
    /** How many scorecards this summarises. Always shown; a count of 3 is not a rate. */
    sampleCount: number;
    byStatus: Record<string, number>;
    unresolved: number;
    failedAttempts: number;
    /** Real operator verdicts only — fixture feedback is excluded from these counts. */
    operatorVerdicts: Record<FeedbackVerdict, number>;
    unrated: number;
    /** Per-task history for the same filtered population as the counts above. */
    evidence: ScorecardEvidenceReport[];
    /** Stated in words so a small sample cannot be read as a reliability figure. */
    caveat: string;
    /** All recorded attempts, not only a task's final retry. Missing provenance stays missing. */
    recordedAttempts: RunRecord[];
    attemptCounts: {
        recorded: number;
        dispatched: number;
        dispatchUnknown: number;
        delivered: number;
        byStatus: Record<string, number>;
    };
}
/**
 * Summarise comparable work.
 *
 * Deliberately reports counts and never a success rate. The contract's own warning
 * is that a handful of heterogeneous tasks must not become a general reliability
 * claim, and a percentage is exactly the shape that invites that reading.
 */
export declare function groupReport(cards: Scorecard[], key: GroupKey): GroupReport;
