/**
 * One evaluation case, with the expectation fixed before the trial.
 *
 * `expected` is written down in advance precisely so that a disappointing result
 * cannot be reinterpreted afterwards as the expected one.
 */
export interface EvalCase {
    id: string;
    /** Which of the four classes this exercises. */
    kind: 'approved-repair' | 'approved-feature' | 'reviewer-detects-bad-candidate' | 'refusal-or-pending';
    description: string;
    /** Fixed inputs: base ref, fixture ids, event payloads. */
    inputs: Record<string, string>;
    /** Checks that must run for this case to count. */
    requiredChecks: string[];
    /** The outcome recorded before the trial. */
    expected: string;
    /** True when the inputs are deliberately mutated test data, not a real incident. */
    isFixture: boolean;
}
export interface ScoringRule {
    id: string;
    description: string;
    /** How a case contributes. Recorded so a later change is visible. */
    rule: string;
}
/** A whole suite, versioned by the digest of its own content. */
export interface EvalSuite {
    version: string;
    cases: EvalCase[];
    scoring: ScoringRule[];
    /** Digest over cases + scoring, computed when the suite is frozen. */
    oracleDigest: string;
    frozenAt: string;
}
/** Compute the digest that identifies a suite's oracle. */
export declare function oracleDigestOf(cases: EvalCase[], scoring: ScoringRule[]): string;
export declare class OracleError extends Error {
    readonly name = "OracleError";
}
/**
 * Freeze a suite.
 *
 * Freezing is what makes "the expectation was fixed before the trial" checkable
 * rather than asserted. Re-freezing the same version with different content is
 * refused: that is the move a candidate would make to pass under an old label.
 */
export declare function freezeSuite(version: string, cases: EvalCase[], scoring: ScoringRule[]): EvalSuite;
export declare function getSuite(version: string): EvalSuite | undefined;
export declare function listSuites(): EvalSuite[];
export interface CaseResult {
    caseId: string;
    /** What actually happened. */
    observed: string;
    /** Evidence backing the observation. Absent or corrupt evidence fails the case. */
    evidenceRef?: string;
    evidenceCorrupt?: boolean;
    /** Checks that actually ran for this case. */
    ranChecks: string[];
}
export interface TrialResult {
    suiteVersion: string;
    /** The oracle the trial ran against, compared with the frozen one. */
    oracleDigestAtRun: string;
    /** Configuration the trial exercised, so like can be compared with like. */
    configuration: string;
    caseVerdicts: Array<{
        caseId: string;
        passed: boolean;
        reason: string;
    }>;
    /** Raw counts. Deliberately not a composite score. */
    passed: number;
    failed: number;
    total: number;
    /** Set when the oracle moved between freezing and running. */
    oracleTampered?: boolean;
    ranAt: string;
}
/**
 * Score a trial against its frozen suite.
 *
 * Every failure mode below is a way a run could look better than it was: a moved
 * oracle, a case quietly dropped, a check that did not run, evidence that was
 * withheld or corrupted. None of them can improve a result.
 */
export declare function scoreTrial(suite: EvalSuite, results: CaseResult[], configuration: string, presentedCases?: EvalCase[]): TrialResult;
export declare function listTrials(): TrialResult[];
/**
 * One case's outcome under two configurations.
 *
 * `undefined` means that configuration did not run the case — distinct from
 * running it and failing, which is why this is not a boolean.
 */
export interface CaseComparison {
    caseId: string;
    a: boolean | undefined;
    b: boolean | undefined;
}
/** Compare matching cases across two configurations, showing raw outcomes. */
export declare function compareConfigurations(trials: TrialResult[], a: string, b: string): CaseComparison[];
