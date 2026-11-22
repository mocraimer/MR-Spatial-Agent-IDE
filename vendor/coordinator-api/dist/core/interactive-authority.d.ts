import { type DispatchTaskInput } from '../commands.js';
import { type Actor, type AuthorityDecision, type AuthorityRef } from './authority.js';
export interface AuthorityConfirmationInput {
    original: DispatchTaskInput;
    decisionId: string;
    requestId: string;
    requestVersion: number;
    handoffDigest: string;
    expectedAuthority: AuthorityRef;
    /** Explicit owner selection, separate from the immutable received dispatch envelope. */
    binding?: {
        approvalId: string;
    };
    parentAuthority?: AuthorityRef;
}
export interface AuthorityConfirmationReceipt extends AuthorityConfirmationInput {
    by: string;
    at: string;
    submissionFingerprint: string;
    coverage: 'scope-only';
    limits: Extract<AuthorityDecision, {
        allowed: true;
    }>['limits'];
}
/** Current scope coverage only: no provider reads, claims, capacity proof or runtime calls. */
export declare function authorityPreviewForOperator(actor: Actor, input: DispatchTaskInput): AuthorityDecision;
/** Host-only transaction callback keeps lock order dispatch fence -> product transaction -> receipt. */
export declare function authorityConfirmationRecord<T>(actor: Actor, input: AuthorityConfirmationInput, recordWith: (persist: () => AuthorityConfirmationReceipt) => T): T;
