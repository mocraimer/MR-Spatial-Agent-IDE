import type { CandidateIdentity, SettingsSnapshot } from './run.js';
/**
 * How a piece of evidence was produced.
 *
 * Kept separate rather than collapsed into pass/fail because the contract requires
 * real-provider, native, emulator/mocked and judgment results to be reported apart
 * from each other: a mocked pass and a real pass are not interchangeable, however
 * green they both look.
 */
export type EvidenceClass = 'real-provider' | 'native' | 'emulator' | 'mocked' | 'judgment';
/** Why a piece of evidence cannot satisfy the check it claims to. */
export type Disqualifier = 'missing' | 'skipped' | 'failed' | 'stale' | 'superseded' | 'inaccessible' | 'configuration-mismatch' | 'wrong-class';
export interface EvidenceItem {
    /** The required check this claims to satisfy. */
    check: string;
    class: EvidenceClass;
    /** What the producer said happened. Not itself acceptance. */
    reportedOutcome: 'passed' | 'failed' | 'skipped' | 'errored';
    /** Candidate this ran against. Compared with the candidate under judgement. */
    candidate: CandidateIdentity;
    /** Runtime settings in force, where the check depends on them. */
    settings?: SettingsSnapshot;
    /** Version of the fixtures or oracle used, fixed before the trial. */
    fixtureVersion?: string;
    observedAt: string;
    /** Attempt number, where the producer retried. First failure is retained. */
    attempt?: number;
    /** True when the producer could not be read at all. */
    inaccessible?: boolean;
    /** Free-text source, e.g. a workflow run URL. */
    source: string;
}
/**
 * The operator has put a check's scope out of the current phase.
 *
 * A deferral is a scope decision, so it carries who made it. Nothing an agent or an
 * evaluation produces can construct one: `assertOperatorDeferrals` rejects any
 * deferral whose author is not the configured operator, which is what stops a run
 * from quietly widening its own definition of done.
 */
export interface CheckDeferral {
    reason: string;
    /** The operator who deferred it. An agent identity here is refused. */
    deferredBy: string;
    deferredAt: string;
}
/** What the approved configuration says must hold before a candidate is accepted. */
export interface RequiredCheck {
    name: string;
    /** The evidence class that can satisfy this check. A mock cannot satisfy a real one. */
    requiredClass: EvidenceClass;
    /** Fixture/oracle version this check must have run against, when it has one. */
    fixtureVersion?: string;
    /**
     * Set when the operator has deferred this check's scope. A deferred check does not
     * block acceptance and is never reported as passed — it reports as deferred, so a
     * reader sees an absence of coverage rather than a green tick or nothing at all.
     */
    deferral?: CheckDeferral;
}
export interface Verdict {
    check: string;
    satisfied: boolean;
    /**
     * The operator deferred this check's scope, so its absence does not block. Never
     * true at the same time as `satisfied`: deferred means untested, not passed.
     */
    deferred?: boolean;
    /** Present when not satisfied. */
    disqualifier?: Disqualifier;
    detail: string;
    /** The item considered, when one was found. */
    item?: EvidenceItem;
}
export interface AggregateReport {
    candidate: CandidateIdentity;
    verdicts: Verdict[];
    /** Per-class counts, so a reader cannot mistake mocked coverage for real coverage. */
    byClass: Record<EvidenceClass, {
        satisfied: number;
        required: number;
    }>;
    /** Checks that failed at least once before later passing. */
    flaky: string[];
    /** Deferred check names, so a reader can see what the result does not cover. */
    deferred: string[];
    accepted: boolean;
    /** What was actually tested, in the reader's terms. Never implies untested scope. */
    scopeStatement: string;
}
export interface AggregateOptions {
    maxEvidenceAgeMs?: number;
    now?: number;
    /**
     * Check names this particular configuration requires despite their deferral.
     *
     * A deferral is a decision about the current phase, not about every run inside it.
     * A configuration that asks for a deferred check back gets it enforced, and the
     * missing evidence blocks exactly as it would have before the deferral.
     */
    enforceDeferred?: readonly string[];
}
/**
 * Decide whether a candidate is accepted, from the required checks and the
 * evidence offered for them.
 *
 * The whole point is that offering evidence is not the same as satisfying a check.
 * Every disqualifier below was chosen because it is a way real evidence looks green
 * while establishing nothing.
 */
export declare function aggregate(candidate: CandidateIdentity, required: RequiredCheck[], evidence: EvidenceItem[], options?: AggregateOptions): AggregateReport;
/**
 * Refuse deferrals that did not come from the operator.
 *
 * A deferral removes a check from what blocks acceptance, so it is an authority
 * decision wearing configuration's clothes. Without this, anything that can write
 * the check list — an agent's proposed configuration, an evaluation result — could
 * retire the checks it was about to fail. The operator identity is compared against
 * the configured one rather than merely being present.
 */
export declare function assertOperatorDeferrals(required: readonly RequiredCheck[], operatorId: string): void;
