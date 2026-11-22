import type { Outcome } from './outcome.js';
/**
 * Who is acting. Only an `operator` actor matching the configured operator id can
 * mint or widen authority; every other kind is data, however it is phrased.
 */
export type ActorKind = 'operator' | 'agent' | 'automation';
export interface Actor {
    kind: ActorKind;
    /** Operator identity, agent run id, or automation source name. */
    id: string;
}
export type RuntimeId = 'pi-local' | 'codex-cloud' | 'claude-web' | 'claude-local';
/** What a run is permitted to do. Absent from any list means not permitted. */
export type ActionId = 'conversation' | 'task-tools' | 'delegate-task' | 'author-changes' | 'open-pr' | 'push-branch' | 'review' | 'run-verification' | 'deploy-dev'
/**
 * Merge a pull request into `dev` — never `main`, which stays `merge` and is
 * forbidden. Grantable like any other action; the loop's merge stage adds its
 * own conditions on top of the authority check.
 */
 | 'merge-dev';
/** Limits that bind one task, whichever authority allowed it. */
export interface PerTaskLimits {
    maxAttempts: number;
    maxConcurrentRuns: number;
    /** Ceiling on paid API spend (calls the ledger meters) this task may reserve, in USD. */
    maxPaidCallUsd: number;
}
export interface Approval {
    kind: 'approval';
    id: string;
    version: number;
    issuedBy: Actor;
    issuedAt: string;
    repo: string;
    /** Free text describing exactly what was approved. Shown back at dispatch. */
    taskScope: string;
    workClass: string;
    runtime: RuntimeId;
    profile: string;
    actions: ActionId[];
    limits: PerTaskLimits;
    /**
     * The tier the operator approved this work to run at.
     *
     * Both optional, and absent means the operator named no tier — which is what
     * every approval written before these fields existed says, and why they still
     * load. Where a tier is named it becomes the run's setting when the caller
     * names none; whether a *contradicting* caller value is refused depends on
     * the runtime, since a refusal is only meaningful where the runtime reports
     * back what it actually ran.
     */
    model?: string;
    effort?: string;
    revokedAt?: string;
}
export type GrantStatus = 'active' | 'revoked';
export interface AggregateLimits {
    /** Total dispatches this grant may authorize inside the rolling window. */
    maxDispatchesPerWindow: number;
    windowHours: number;
    /** Runs this grant may have in flight at once. */
    maxConcurrentRuns: number;
}
export interface Grant {
    kind: 'grant';
    id: string;
    version: number;
    issuedBy: Actor;
    issuedAt: string;
    status: GrantStatus;
    repos: string[];
    workClasses: string[];
    /** Event sources whose events may trigger work, e.g. `github-actions:example-org/larkspur`. */
    triggerSources: string[];
    actions: ActionId[];
    runtimes: RuntimeId[];
    profiles: string[];
    perTask: PerTaskLimits;
    aggregate: AggregateLimits;
    /** Every change, appended. Narrowing bumps `version`. */
    history: GrantChange[];
}
export interface GrantChange {
    at: string;
    by: Actor;
    change: 'created' | 'narrowed' | 'revoked';
    reason: string;
    /** Version this change produced. */
    version: number;
}
export interface AuthorityRef {
    type: 'approval' | 'grant';
    id: string;
    version: number;
}
export interface DispatchRequest {
    repo: string;
    workClass: string;
    runtime: RuntimeId;
    profile: string;
    actions: ActionId[];
    /** Present when the work was triggered by an event rather than an operator. */
    triggerSource?: string;
    /** Base branch a pull request would target, when the work opens one. */
    prBase?: string;
    /** Cloud project the work would act on, when it touches one. */
    targetProject?: string;
    /** The approval the caller believes covers this, when dispatching under one. */
    approvalId?: string;
    /** Model and effort the caller named, so an approved tier can be checked against them. */
    settings?: {
        model?: string;
        effort?: string;
    };
    taskId: string;
}
export type AuthorityDecision = {
    allowed: true;
    authority: AuthorityRef;
    limits: PerTaskLimits;
    /** The approved tier, when the authority named one. Grants never do. */
    tier?: {
        model?: string;
        effort?: string;
    };
} | {
    allowed: false;
    outcome: Outcome;
};
export declare function listApprovals(): Approval[];
export declare function listGrants(): Grant[];
export declare function getApproval(id: string): Approval | undefined;
export declare function getGrant(id: string): Grant | undefined;
/** The operator this installation answers to. */
export declare function configuredOperator(): string | undefined;
/**
 * Reject any actor that is not the configured operator.
 *
 * This is the single choke point for minting authority. It exists because the
 * material an agent produces — its own output, a PR comment, a review verdict, an
 * evaluation score — reaches the coordinator as text and can claim anything;
 * treating that text as a decision is the failure this guards.
 */
export declare function assertOperator(actor: Actor): void;
export declare class AuthorityError extends Error {
    readonly name = "AuthorityError";
}
export interface ApprovalInput {
    repo: string;
    taskScope: string;
    workClass: string;
    runtime: RuntimeId;
    profile: string;
    actions: ActionId[];
    limits: PerTaskLimits;
    /** The tier this work is approved to run at. Both optional; see `Approval`. */
    model?: string;
    effort?: string;
}
export declare function createApproval(actor: Actor, input: ApprovalInput): Approval;
export interface GrantInput {
    repos: string[];
    workClasses: string[];
    triggerSources: string[];
    actions: ActionId[];
    runtimes: RuntimeId[];
    profiles: string[];
    perTask: PerTaskLimits;
    aggregate: AggregateLimits;
    reason: string;
}
export declare function createGrant(actor: Actor, input: GrantInput): Grant;
/** Fields a narrowing may touch. Anything absent is left as it was. */
export interface NarrowInput {
    repos?: string[];
    workClasses?: string[];
    triggerSources?: string[];
    actions?: ActionId[];
    runtimes?: RuntimeId[];
    profiles?: string[];
    perTask?: Partial<PerTaskLimits>;
    aggregate?: Partial<AggregateLimits>;
    reason: string;
}
/**
 * Narrow a grant. Every supplied field must be a subset of, or numerically not
 * greater than, what the grant already allows — so this entry point cannot be used
 * to widen authority under a friendlier name.
 */
export declare function narrowGrant(actor: Actor, id: string, input: NarrowInput): Grant;
export declare function revokeGrant(actor: Actor, id: string, reason: string): Grant;
export declare function revokeApproval(actor: Actor, id: string): Approval;
