import type { Outcome } from './outcome.js';
/**
 * The paid provider-call ledger.
 *
 * Deliberately a separate ledger from subscription admission: one counts dollars
 * billed per call, the other counts percent of an account allowance. Mixing them
 * would let a healthy subscription percentage look like room for a paid call, or
 * a dollar figure look like subscription headroom. Neither is true.
 */
export interface LedgerPolicy {
    /** Total paid spend this bootstrap may reach, in USD. */
    allowanceUsd: number;
    /** Set when the operator has explicitly changed it, for the audit trail. */
    setBy?: string;
    setAt?: string;
}
export declare const BOOTSTRAP_ALLOWANCE_USD = 10;
/**
 * Money, printed at the precision it actually has.
 *
 * Two decimals is the wrong default for this ledger. A real translation call came
 * back at $0.0018, which `toFixed(2)` renders as `$0.00` and a remaining balance of
 * `$10.00` — spend that happened, reported as spend that did not. Over many small
 * calls the allowance would drain while the display insisted nothing had been used.
 * Whole-cent amounts still print as two decimals, because most do.
 */
export declare function formatUsd(usd: number): string;
export interface CallReservation {
    id: string;
    taskId: string;
    runId: string;
    /** Provider and operation, e.g. `openai:embeddings`. */
    operation: string;
    /** Conservative upper bound reserved before the call. */
    boundUsd: number;
    /** How the bound was derived. A call with no defensible bound is refused. */
    boundBasis: string;
    createdAt: string;
    state: 'reserved' | 'settled' | 'released';
    /** Reconciled actual cost, when the provider reports one. */
    actualUsd?: number;
    /** Set when the provider exposes no usable actual figure. */
    actualUnknown?: boolean;
    settledAt?: string;
}
export declare function getLedgerPolicy(): LedgerPolicy;
/** Only an operator path reaches this; the CLI gates it with assertOperator. */
export declare function setLedgerPolicy(policy: LedgerPolicy): void;
export declare function listCalls(): CallReservation[];
/**
 * Committed spend: settled actuals where known, otherwise the reserved bound.
 *
 * An unknown actual keeps charging its bound rather than dropping to zero — a
 * provider that reports nothing must not become free.
 */
export declare function committedUsd(): number;
export declare function remainingUsd(): number;
export interface CallRequest {
    taskId: string;
    runId: string;
    operation: string;
    /** Conservative upper bound. Must be > 0 and defensible. */
    boundUsd: number;
    boundBasis: string;
}
export type CallDecision = {
    allowed: true;
    reservation: CallReservation;
    remainingUsd: number;
} | {
    allowed: false;
    outcome: Outcome;
};
/** Reserve budget for one paid call, or refuse with a reason the operator can act on. */
export declare function reserveCall(req: CallRequest): CallDecision;
/**
 * Reconcile a call against what it actually cost.
 *
 * `actualUsd` of `undefined` records the cost as unknown rather than zero, and the
 * bound keeps being charged. Retries settle as their own reservations, so a
 * retried call consumes the allowance twice — which is the point.
 */
export declare function settleCall(id: string, actualUsd?: number): CallReservation | undefined;
/** Release a reservation for a call that never happened. */
export declare function releaseCall(id: string): CallReservation | undefined;
