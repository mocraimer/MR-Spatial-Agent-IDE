import type { DispatchTaskInput, DispatchCommandResult } from '../commands.js';
import type { DispatchResult } from '../adapters/types.js';
import { type Actor, type ActionId, type AuthorityDecision, type AuthorityRef, type DispatchRequest } from './authority.js';
import { type RunRecord } from './run.js';
export interface InteractiveSubmission {
    requestId: string;
    fingerprint: string;
    taskId: string;
    /** Absent only on pre-archive receipts; unknown unlinked work cannot prove archive safety. */
    conversationId?: string;
    /** Exact ancestry received under dispatch, before preflight can await or publish a run. */
    parentRunId?: string;
    rootTaskId?: string;
    state: 'submitting' | 'settled' | 'uncertain';
    result?: DispatchCommandResult;
}
export type InteractiveSubmissionWithRun = InteractiveSubmission & {
    run?: RunRecord;
};
/** Lookup never executes a runtime or releases an uncertain reservation. */
export declare function interactiveLookup(requestId: string): InteractiveSubmissionWithRun | undefined;
/** Durable receive-before-dispatch. A crashed submitter is reconciled, never blindly replayed. */
export declare function interactiveSubmit(input: DispatchTaskInput, dispatch: (input: DispatchTaskInput) => Promise<DispatchCommandResult>): Promise<ReturnType<typeof interactiveLookup>>;
export declare function isReceivedInteractiveSubmission(input: DispatchTaskInput): boolean;
/** Called within the existing atomic dispatch claim; no second admission system. */
export declare function interactiveClaim(input: DispatchTaskInput): {
    rootTaskId: string;
} | undefined;
/** Trusted adapter handshake publication; no model tool or client accepts these parameters. */
export declare function interactiveSessionRecord(runId: string, requestId: string, session: {
    id: string;
    file?: string;
}): RunRecord;
export interface InteractiveEvidencePin {
    runId: string;
    authority: AuthorityRef;
    runDigest: string;
    evidenceDigest: string;
    candidateHead: string | null;
}
export declare function interactiveEvidencePin(runId: string): InteractiveEvidencePin;
/** Trusted post-teardown evidence publication uses the same lock as review and final run recording. */
export declare function interactiveRuntimeResultRecord(runId: string, requestId: string, result: DispatchResult): void;
export interface InteractiveReviewInput {
    decisionId: string;
    requestId: string;
    submissionId: string;
    pin: InteractiveEvidencePin;
    text: string;
}
export interface InteractiveReviewRecord extends InteractiveReviewInput {
    by: string;
    at: string;
}
/** Linearizes owner review against revocation/current evidence before product acknowledgement. Never grants or marks delivery. */
export declare function interactiveReviewRecord(actor: Actor, input: InteractiveReviewInput): InteractiveReviewRecord;
export type CurrentAuthoritySettings = (Extract<AuthorityDecision, {
    allowed: true;
}> & {
    run: RunRecord;
    request: DispatchRequest;
}) | Extract<AuthorityDecision, {
    allowed: false;
}>;
/** Tool boundary reads current authority, including revocation/version changes, not cached grants. */
export declare function currentAuthoritySettings(runId: string, action?: ActionId, requireRunning?: boolean): CurrentAuthoritySettings;
