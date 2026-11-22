import type { Outcome } from './outcome.js';
import type { UsageReading, UsageResult, UsageWindow, WindowKind } from './usage.js';
/** Operator-set thresholds, per subscription. Defaults are the Manifest's 60/40. */
export interface SubscriptionPolicy {
    subscriptionId: string;
    /** Stop admitting once this percent of the five-hour allowance is used. */
    fiveHourThresholdPercent: number;
    /** Stop admitting once this percent of the weekly allowance is used. */
    weeklyThresholdPercent: number;
    /** Headroom held back from every admission decision. */
    safetyMarginPercent: number;
    /** A reading older than this cannot admit work. */
    maxReadingAgeSeconds: number;
    /**
     * The windows this subscription actually meters, every one of which must be
     * read and must fit before work is admitted.
     *
     * Declared per subscription, never inferred from what a reading happens to
     * contain. A plan that meters one window and a plan whose second window failed
     * to arrive produce the same missing field, and the difference between them is
     * the difference between admitting work correctly and admitting it blind. So an
     * absent window is only ever allowed for because a person said this plan does
     * not have one, and a window named here that the reading does not carry blocks.
     */
    applicableWindows: MeteredWindow[];
    /**
     * Hours before a weekly reset over which the weekly ceiling rises, in a straight
     * line, from `weeklyThresholdPercent` to 100% at the reset. Absent means no ramp:
     * a window's room that nobody spent before it reset is lost, and this is the
     * operator's way of spending it. Five-hour windows and the margin are unchanged.
     */
    weeklyRampHours?: number;
}
/** The window kinds a subscription can be metered on. `other` is never a limit. */
export type MeteredWindow = Extract<WindowKind, 'five-hour' | 'weekly'>;
export declare const DEFAULT_POLICY: Omit<SubscriptionPolicy, 'subscriptionId'>;
/** What the ceiling of one window is at one instant, and why. */
export interface WindowCeiling {
    /** The ceiling admission applies to this window now. */
    ceilingPercent: number;
    /** The operator's ceiling for the window, before any ramp. */
    baseCeilingPercent: number;
    /** Hours until the window resets; absent when its reset time cannot be read. */
    hoursToReset?: number;
    /** Set when a ramp is configured: whether it applies now, or why not. */
    rampNote?: string;
}
/**
 * The ceiling a window admits up to at `now`.
 *
 * The weekly ceiling climbs linearly from its base to 100% across the final
 * `weeklyRampHours` before the window's reset. A reset time that cannot be read
 * applies no ramp, and says so, rather than assuming when the window ends.
 */
export declare function windowCeiling(policy: SubscriptionPolicy, kind: MeteredWindow, window: UsageWindow, observedAt: string, now: Date): WindowCeiling;
/** A window's room now: its ceiling in force, less what is used, reserved and held back as margin. */
export interface WindowRoom extends WindowCeiling {
    usedPercent: number;
    reservedPercent: number;
    marginPercent: number;
    /** Can be negative. */
    availablePercent: number;
}
export declare function windowRoom(policy: SubscriptionPolicy, kind: MeteredWindow, window: UsageWindow, observedAt: string, reservedPercent: number, now: Date): WindowRoom;
/** A job's predicted cost, in percent of each window's whole allowance. */
export interface UsageEstimate {
    fiveHourPercent: number;
    weeklyPercent: number;
    /** Where the number came from. `none` means there is no basis yet. */
    basis: 'comparable-history' | 'operator-bound' | 'calibration-approval' | 'none';
    /** How much to distrust it, in percent points. Widens the required headroom. */
    uncertaintyPercent: number;
    /** Human-readable provenance, e.g. "7 prior pi-local runs, p90". */
    detail: string;
}
export interface Reservation {
    id: string;
    subscriptionId: string;
    taskId: string;
    runId: string;
    estimate: UsageEstimate;
    createdAt: string;
    /**
     * `held` counts against headroom and can be released. `outstanding` is a job
     * whose remote state could not be confirmed stopped — it keeps its reservation
     * precisely because assuming it stopped is what would overspend the account.
     */
    state: 'held' | 'released' | 'outstanding';
    releasedAt?: string;
    note?: string;
}
export declare function getPolicy(subscriptionId: string): SubscriptionPolicy;
/** Only an operator path should reach this; authority.assertOperator gates the CLI. */
export declare function savePolicy(policy: SubscriptionPolicy): void;
export declare function listReservations(subscriptionId?: string): Reservation[];
/** Reservations still consuming headroom. */
export declare function activeReservations(subscriptionId: string): Reservation[];
export declare function saveReading(reading: UsageReading): void;
/**
 * The most recent reading for a subscription.
 *
 * Reads one file, not the whole directory. The filenames carry an ISO timestamp
 * and so sort chronologically, and this runs on the admission path where a scan
 * that grows with every past dispatch would widen the window the lock is held for.
 */
export declare function latestReading(subscriptionId: string): UsageReading | undefined;
export interface WindowVerdict {
    kind: WindowKind;
    /**
     * True when this window is not in the subscription's declared set but the account
     * reported it anyway. It is checked like any other; the flag exists so the
     * operator is told the declaration is narrower than the account.
     */
    undeclared?: boolean;
    /** The ceiling in force now: the policy's threshold, raised by a ramp when one applies. */
    thresholdPercent: number;
    usedPercent: number;
    reservedPercent: number;
    marginPercent: number;
    estimatePercent: number;
    /** Ceiling minus used, reserved and margin. Can be negative. */
    availablePercent: number;
    fits: boolean;
    resetsAt?: string;
    /** Hours until the window resets, when its reset time is readable. */
    hoursToReset?: number;
    /** The policy's threshold before any ramp; set only where a ramp is configured. */
    baseThresholdPercent?: number;
    /** Whether the weekly ramp applies now, or why not; set only where a ramp is configured. */
    rampNote?: string;
}
export interface AdmissionDecision {
    admitted: boolean;
    subscriptionId: string;
    windows: WindowVerdict[];
    estimate: UsageEstimate;
    reservationId?: string;
    outcome?: Outcome;
    /** The reading the decision was made against, for the run record. */
    reading?: UsageReading;
}
export interface AdmissionRequest {
    subscriptionId: string;
    taskId: string;
    runId: string;
    estimate: UsageEstimate;
    /** Supplies a fresh reading before the synchronous reservation claim. */
    readUsage: () => Promise<UsageResult> | UsageResult;
    /**
     * Decide without reserving. A dry run asks whether work *would* be admitted;
     * holding headroom for work it will not start would refuse the real dispatches
     * behind it.
     */
    preview?: boolean;
    /** The instant the decision is made at, for the weekly ramp. Defaults to the clock. */
    now?: Date;
}
/** Read usage without holding a disk lock, then claim current headroom atomically. */
export declare function admit(req: AdmissionRequest): Promise<AdmissionDecision>;
/**
 * Synchronous admission, also used inside the coordinator's dispatch claim.
 * Reservations and policy are read under the account lock after the external
 * read returns. No promise or vendor operation may run in this critical section.
 */
export declare function admitWithReading(req: Omit<AdmissionRequest, 'readUsage'>, result: UsageResult | undefined): AdmissionDecision;
/** What reservations already hold against one window. */
export declare function reservedPercent(held: readonly Reservation[], kind: WindowKind): number;
/** Release future headroom once work is known to have settled; this does not measure its consumption. */
export declare function releaseReservation(id: string, note?: string): Reservation | undefined;
/**
 * Settle reservations whose run is no longer in flight.
 *
 * A reservation is a claim on *future* headroom. Once a run stops, what it
 * actually consumed appears in the vendor's own usage reading, so a reservation
 * still claiming headroom past that point is counted twice and never comes back.
 *
 * The dispatch path settles its own, but a process that dies between writing the
 * run record and settling leaves one stranded, and nothing else was ever going
 * to look at it: reconciliation only asks vendors about work that may still be
 * running, so a stopped run's reservation had no recovery path at all. Without
 * this the only remedy is editing state by hand, which the coordinator forbids
 * for good reason.
 *
 * Both active states are swept, and for different reasons:
 *
 *   - `held` is a live claim on a run that may or may not have stopped.
 *   - `outstanding` is a job whose remote state could not be confirmed stopped.
 *     It keeps its headroom on purpose, and it must keep it until something
 *     actually confirms the outcome. When reconciliation later does confirm
 *     one, nothing else releases it, so it would hold headroom forever.
 *
 * This never invents an outcome. It reads the run's own recorded status and
 * applies the rule the dispatch path would have applied. An outstanding
 * reservation is released only for a genuinely settled status, never for a run
 * that is merely no longer being watched.
 *
 * @param runs the run records to check, as `{id, status, reservationId}`
 */
export declare function sweepStrandedReservations(runs: {
    id: string;
    status: string;
    reservationId: string | undefined;
    promptNotSent?: true;
    runtimeDispatched?: boolean;
}[]): {
    reservationId: string;
    runId: string;
    action: 'released' | 'outstanding';
}[];
/**
 * Mark a reservation outstanding because the remote job could not be confirmed
 * stopped. It keeps consuming headroom on purpose.
 */
export declare function markOutstanding(id: string, note: string): Reservation | undefined;
