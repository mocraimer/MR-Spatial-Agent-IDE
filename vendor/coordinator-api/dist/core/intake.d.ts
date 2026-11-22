import type { RuntimeId } from './authority.js';
import type { Outcome } from './outcome.js';
import type { RunRecord } from './run.js';
/**
 * A unit of work as the operator or an event source sees it.
 *
 * Separate from a run: one job may take several runs (an initial attempt plus
 * repairs), and the job is what must survive a duplicate delivery or a restart
 * without turning into two.
 */
export interface Job {
    id: string;
    taskId: string;
    /**
     * Whatever makes two submissions "the same work" — a CI event id, an issue
     * number, an operator-supplied key. Two submissions sharing one never produce
     * two jobs.
     */
    idempotencyKey: string;
    repo: string;
    workClass: string;
    runtime: RuntimeId;
    /** Checks this job still owes, carried across attempts. */
    outstandingObligations: string[];
    /** Evidence directories produced so far. Never dropped on a retry. */
    artifacts: string[];
    runIds: string[];
    state: 'open' | 'settled' | 'abandoned';
    createdAt: string;
    updatedAt: string;
    /** Set when a submission was recognised as a duplicate of this job. */
    duplicateSubmissions?: number;
    /**
     * The exact head the signal was raised against, and the base a repair must
     * target.
     *
     * Carried on the job because the event itself is not kept: without them a
     * restart knows a job exists but not what it was about, and a later dispatch
     * could bind to whatever the branch has become rather than the commit that
     * actually failed.
     */
    headSha?: string;
    prBase?: string;
    /** Why the job is not settled, when it is not. */
    note?: string;
}
export declare function listJobs(): Job[];
export declare function getJob(id: string): Job | undefined;
/** Check both persisted and proposed links; changing taskId cannot erase a cutoff. */
export declare function saveJob(job: Job): void;
export interface SubmitInput {
    idempotencyKey: string;
    taskId: string;
    repo: string;
    workClass: string;
    runtime: RuntimeId;
    obligations: string[];
    /** The exact head the signal was raised against, when the caller knows it. */
    headSha?: string;
    /** The base a repair's pull request must target, when the repo constrains one. */
    prBase?: string;
}
export interface SubmitResult {
    job: Job;
    /** True when this submission created the job rather than matching an existing one. */
    created: boolean;
}
/**
 * Accept a submission, or recognise it as one already accepted.
 *
 * Read-check-write under one lock, with the key index written inside it: a
 * duplicate delivery arriving while the first is still being recorded is exactly
 * the case that produces two jobs — and, downstream, two PRs for one CI failure.
 */
export declare function submitJob(input: SubmitInput): SubmitResult;
/**
 * Fill in a candidate the job does not yet record.
 *
 * Separate from `submitJob` on purpose. Backfilling during submission wrote the
 * values before anything had checked them, so a delivery that was about to be
 * rejected could still leave its base on the job — and a later, correct delivery
 * would then be refused against the rejected one's value. Only a delivery that
 * has passed the identity checks gets to bind what was missing.
 *
 * Gaps only. A recorded identity is never overwritten, because a delivery
 * disagreeing about the candidate is what those checks exist to catch.
 */
export declare function bindJobCandidate(jobId: string, candidate: {
    headSha?: string;
    prBase?: string;
}): Job;
/** Attach a run to its job, keeping artifacts and obligations across attempts. */
export declare function attachRun(jobId: string, run: RunRecord): Job;
/**
 * Discharge obligations a run satisfied.
 *
 * A job settles only when nothing is outstanding. A resumed attempt may bring its
 * own manifest, but it cannot shorten this list — the obligations belong to the
 * approved task, not to whichever attempt happens to finish.
 */
export declare function dischargeObligations(jobId: string, satisfied: string[]): Job;
export interface Reconciler {
    runtime: RuntimeId;
    reconcile(sessionId: string, evidenceDir?: string): Promise<Outcome>;
}
export interface ReconcileReport {
    runId: string;
    jobId?: string;
    before: RunRecord['status'];
    outcome: Outcome;
    /** True when a fresh dispatch for this job would be unsafe right now. */
    blocksNewAttempt: boolean;
}
/**
 * Reconcile every run whose fate this coordinator does not know.
 *
 * Called on startup. A run left `running` when the process died is not evidence
 * that the remote work stopped, so each is asked about rather than assumed dead —
 * and while its state is unresolved, a second worker for the same job is refused.
 */
export declare function reconcileUnsettled(reconcilers: Reconciler[], 
/** Reconcile only this runtime's runs. Absent means every unsettled run. */
onlyRuntime?: RuntimeId): Promise<ReconcileReport[]>;
/** Whether a job may take another attempt, given what reconciliation found. */
export declare function mayDispatchAgain(jobId: string, reports: ReconcileReport[]): Outcome | undefined;
