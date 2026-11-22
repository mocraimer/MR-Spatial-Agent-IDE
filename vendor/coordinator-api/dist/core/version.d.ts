import type { Actor } from './authority.js';
import type { Outcome } from './outcome.js';
/** What produced a run, recorded so a result can be attributed to a build. */
export interface SystemVersion {
    /** Coordinator build identity — a commit SHA or a released version. */
    coordinator: string;
    /** Per-runtime adapter identities. */
    adapters: Record<string, string>;
    /** Identity of the prompt/skill configuration in force. */
    prompts: string;
}
export interface ActiveVersionRecord extends SystemVersion {
    activatedAt: string;
    activatedBy: string;
    /** The reviewed, merged change that authorized this. */
    mergedPr: string;
    /** What was active before, so a rollback has somewhere to go. */
    previous?: SystemVersion;
}
/**
 * An unmerged build, exercised deliberately as a subject rather than a runner.
 *
 * The bootstrap build is one of these. Recording it separately is what keeps
 * "we tested this candidate" from drifting into "this candidate is now the system".
 */
export interface CandidateRecord extends SystemVersion {
    id: string;
    exercisedAt: string;
    /** Where the candidate came from — a branch, a PR, a local build. */
    origin: string;
    /** Free text: what was exercised. Never an activation. */
    purpose: string;
}
export declare function activeVersion(): ActiveVersionRecord | undefined;
export declare function versionHistory(): ActiveVersionRecord[];
export declare function listCandidates(): CandidateRecord[];
export declare class UpdateError extends Error {
    readonly name = "UpdateError";
}
export interface ActivateInput extends SystemVersion {
    /** URL of the merged, human-reviewed pull request that introduced this build. */
    mergedPr: string;
    /** Evidence the merge actually happened, checked by the caller against the forge. */
    mergeConfirmed: boolean;
}
/**
 * Make a build the ongoing runner.
 *
 * Requires the configured operator *and* a confirmed reviewed merge. Two separate
 * conditions on purpose: an operator changing a threshold or issuing a grant is a
 * configuration action, and must not be a path by which control code is replaced.
 */
export declare function activateVersion(actor: Actor, input: ActivateInput): ActiveVersionRecord;
/** Roll back to the version that was active before the current one. */
export declare function rollback(actor: Actor): ActiveVersionRecord;
/**
 * Record that an unmerged build was exercised.
 *
 * Deliberately not gated on the operator: exercising a candidate is ordinary
 * testing. It is also deliberately unable to touch the active version — the two
 * live in different files and only `activateVersion` writes the active one.
 */
export declare function recordCandidate(input: Omit<CandidateRecord, 'id' | 'exercisedAt'>): CandidateRecord;
/**
 * Refuse a mid-run swap of the thing doing the running.
 *
 * A run records the version that started it; if the active version has moved on,
 * the run keeps its own rather than picking up new control code halfway.
 */
export declare function versionForRun(runStartedWith: SystemVersion): SystemVersion;
/** Reject an attempt to make a candidate live without the operator and a merge. */
export declare function denyLiveUpdate(actor: Actor, candidate: CandidateRecord): Outcome;
