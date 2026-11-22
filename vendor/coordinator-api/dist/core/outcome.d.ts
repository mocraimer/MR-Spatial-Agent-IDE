/**
 * The states an operator must be able to tell apart (INV-G30).
 *
 * Every operator-visible surface renders one of these. A generic "failed" is not
 * a member of this union on purpose: an operator seeing `failed` learns nothing
 * about whether to wait, approve something, fix setup, or read a test report.
 */
export type OutcomeKind = 'completed' | 'refused' | 'awaiting-approval' | 'ready-to-dispatch' | 'quota-waiting' | 'attempts-exhausted' | 'unsupported-settings' | 'setup-blocked' | 'remote-uncertain' | 'native-unavailable' | 'checks-failed';
/**
 * An outcome an operator can act on.
 *
 * `nextAction` is required rather than optional: the gate this type serves says a
 * message must name "the next valid action", so a caller that has nothing useful
 * to say is forced to notice at compile time rather than emit a dead end.
 */
export interface Outcome {
    kind: OutcomeKind;
    /** Task this concerns, when one exists. Absent only before a task is created. */
    taskId?: string;
    /** Run this concerns, when a run had been dispatched. */
    runId?: string;
    /** What happened, in the operator's terms. No stack traces. */
    summary: string;
    /** The next valid action, phrased as something the operator can actually do. */
    nextAction: string;
    /** Proven before the task prompt was sent. Absent means unknown, not false. */
    promptNotSent?: true;
    /** Supporting facts: quota readings, check names, session ids. Never credentials. */
    details?: Record<string, unknown>;
}
export declare function label(kind: OutcomeKind): string;
/** True when the outcome leaves work outstanding that something later must resolve. */
export declare function isOutstanding(kind: OutcomeKind): boolean;
/**
 * Render an outcome for a terminal. Two lines: what happened, then what to do.
 * Deliberately not a progress bar or a percentage — elapsed facts only.
 */
export declare function render(o: Outcome): string;
