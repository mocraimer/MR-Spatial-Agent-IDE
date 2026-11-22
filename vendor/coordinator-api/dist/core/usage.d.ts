/**
 * Subscription usage readings.
 *
 * A "subscription" is an account allowance, not a runtime. Two runtimes backed by
 * the same account share one subscription id and therefore one admission state —
 * which is why the id lives here rather than on the adapter.
 */
export type WindowKind = 'five-hour' | 'weekly' | 'other';
export interface UsageWindow {
    kind: WindowKind;
    /** Percent of the whole account allowance already consumed, 0-100. */
    usedPercent: number;
    /** Nominal window length. Absent when the vendor does not report one. */
    windowDurationMins?: number;
    resetsAt?: string;
    /** Vendor's own name for this bucket, kept verbatim for auditing. */
    vendorLabel: string;
}
/**
 * Which account a reading came from.
 *
 * Present so an operator can see that the allowance being read is the allowance
 * the runs will spend, rather than a second account that happens to be signed in
 * on this machine. Identifiers only — never a token, and never anything that
 * would let a reader authenticate as the account.
 */
export interface AccountIdentity {
    /** Stable account or organisation id, as the vendor reports it. */
    id: string;
    /** Plan or subscription tier, when the vendor names one. */
    plan?: string;
    /** The supported interface this identity came from. */
    source: string;
}
export interface UsageReading {
    subscriptionId: string;
    observedAt: string;
    /** The supported interface this came from, named so a reader can re-run it. */
    source: string;
    windows: UsageWindow[];
    /** Absent when the runtime exposes no supported way to name its account. */
    account?: AccountIdentity;
}
/**
 * Why a reading could not be taken. Kept as data rather than thrown, because
 * "we could not read usage" must reach the operator as a decision with a next
 * action, not as an exception that some caller might smother into a zero.
 */
export interface UsageUnavailable {
    subscriptionId: string;
    attemptedAt: string;
    source: string;
    reason: string;
    /** What the operator would do about it. */
    operatorAction: string;
}
export type UsageResult = {
    ok: true;
    reading: UsageReading;
} | {
    ok: false;
    unavailable: UsageUnavailable;
};
/**
 * Classify a vendor bucket into the two windows the thresholds are written against.
 *
 * Duration decides, never position. The Manifest's own evidence warns that a
 * vendor's `primary`/`secondary` ordering does not reliably mean five-hour and
 * weekly, so an adapter that mapped by position would silently compare a weekly
 * reading against the five-hour threshold.
 */
export declare function classifyWindow(durationMins: number | undefined, vendorLabel: string): WindowKind;
/** Pick the window a threshold applies to, or undefined when the vendor did not report it. */
export declare function windowOf(reading: UsageReading, kind: WindowKind): UsageWindow | undefined;
export declare function ageSeconds(reading: UsageReading, now?: number): number;
/**
 * The instant a window resets, read from its `resetsAt` text.
 *
 * Codex readings carry an ISO instant, which is used as is. Claude readings carry
 * the report's own words — `Oct 2, 1:59am (Europe/Athens)`, or only the time
 * (`3pm (Europe/Athens)`) for a reset within the day — in the zone named in the
 * parenthesis. The text carries no year, so it is taken from the reading's own
 * `observedAt`, rolling into the next year when the date has already passed by
 * more than a month. Text that fits neither form yields no instant: a reset
 * nobody can read is reported as unreadable, never guessed.
 */
export declare function resetInstant(resetsAt: string, observedAt: string): Date | undefined;
