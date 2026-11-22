import type { Outcome } from './outcome.js';
/**
 * Text that arrived from outside the coordinator.
 *
 * Task evidence, PR and review bodies, and vendor results are all written by
 * parties the coordinator does not control. They are data to quote, never
 * instructions to follow, and this type exists so the difference is visible in
 * the type signature rather than remembered.
 */
export interface Untrusted {
    readonly source: string;
    readonly text: string;
}
export declare function untrusted(source: string, text: string): Untrusted;
/** A control attempt found inside untrusted text. */
export interface ControlAttempt {
    pattern: string;
    excerpt: string;
}
export interface Screened {
    /** The original text, unchanged. Quoting it is allowed and expected. */
    quoted: string;
    source: string;
    attempts: ControlAttempt[];
    /** True when the text tried to control the coordinator or widen authority. */
    suspicious: boolean;
}
/**
 * Screen untrusted text for control attempts, without altering it.
 *
 * Returns the text verbatim: a reviewer's point must reach a human intact, and
 * redacting it would hide the very thing worth seeing. What the screening changes
 * is the record, not the content.
 */
export declare function screen(input: Untrusted): Screened;
/** A finding a reviewer produced. Data about the candidate, not an action on it. */
export interface ReviewFinding {
    severity: 'critical' | 'high' | 'medium' | 'low';
    location: string;
    description: string;
    /** The reviewer's own words, quoted. */
    quoted: string;
    /** Set when the reviewer's text also tried to control the coordinator. */
    controlAttempts?: ControlAttempt[];
}
export interface ReviewJobSpec {
    taskId: string;
    /** The candidate the reviewer inspects. */
    candidate: {
        repo: string;
        base: string;
        head: string;
    };
    /** Workspace the reviewer may write in. Never the author's checkout. */
    workspace: string;
    /** The author's checkout, which the reviewer must not be given. */
    authorWorkspace: string;
}
export declare class ReviewIsolationError extends Error {
    readonly name = "ReviewIsolationError";
}
/**
 * Check a review job is actually isolated before it starts.
 *
 * A reviewer sharing the author's workspace can change what it is judging, and a
 * finding produced that way says nothing about the candidate that was submitted.
 */
export declare function assertIsolated(spec: ReviewJobSpec): void;
/** Operations a review job is never permitted to perform. */
export declare const REVIEW_FORBIDDEN_OPERATIONS: readonly ["push", "commit", "merge", "force-push", "deploy", "branch-write", "result-import"];
export type ReviewOperation = string;
/**
 * Decide whether a review job may perform an operation.
 *
 * `result-import` is on the forbidden list deliberately: a reviewer's output is
 * imported by the coordinator as findings, never applied by the reviewer itself.
 */
export declare function reviewMayPerform(operation: ReviewOperation): Outcome | undefined;
export interface RepairHandoff {
    taskId: string;
    prUrl: string;
    findings: ReviewFinding[];
    /** The head the findings were made against. */
    reviewedHead: string;
    /** Checks that must run again once the author changes the candidate. */
    checksToRerun: string[];
}
/**
 * Hand findings back to the author.
 *
 * Same task and same PR, by construction: a repair that opened a second PR would
 * detach the fix from the approval that authorized the work.
 */
export declare function handBackForRepair(spec: ReviewJobSpec, prUrl: string, findings: ReviewFinding[], checksToRerun: string[]): RepairHandoff;
/**
 * Whether findings still describe the candidate.
 *
 * Once the author moves the head, the reviewed evidence is about a candidate that
 * no longer exists, so the checks are owed again rather than carried over.
 */
export declare function findingsStale(handoff: RepairHandoff, currentHead: string): boolean;
