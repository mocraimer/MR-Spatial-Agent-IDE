import type { ActionId, RuntimeId } from './authority.js';
import type { AuthorityDecision } from './authority.js';
import type { Outcome } from './outcome.js';
import type { Screened } from './review.js';
import type { Job } from './intake.js';
/**
 * A CI failure as reported by a configured source.
 *
 * Every string here came from outside the coordinator, so nothing in it is read
 * as an instruction. The repository, workflow and conclusion are matched against
 * the grant; the title and summary are only ever quoted.
 */
export interface CiFailureEvent {
    /** Where this arrived from, e.g. `github-actions:example-org/larkspur`. */
    source: string;
    repo: string;
    workflowName: string;
    runId: string;
    headSha: string;
    branch: string;
    conclusion: string;
    /** Free text from the forge. Untrusted. */
    title: string;
    /** Free text from the forge. Untrusted. */
    summary?: string;
    /** True when this is recorded test data rather than a live event. */
    isFixture?: boolean;
}
export interface IntakeConfig {
    /** Work class CI repairs are filed under. Must match the grant to dispatch. */
    workClass: string;
    runtime: RuntimeId;
    profile: string;
    actions: ActionId[];
    /** Checks a repair job owes before it can settle. */
    obligations: string[];
    /**
     * Base branch a repair's pull request must target.
     *
     * Optional because the repository usually already states it. A repo whose
     * floor (`agentsys floor`) names a base supplies its own, so an ordinary caller does not restate
     * what the policy already fixes; naming a different one here is still refused
     * by the floor check rather than quietly accepted.
     */
    prBase?: string;
}
export interface IntakeResult {
    event: CiFailureEvent;
    /** The job, when one was created or matched. Absent when intake refused outright. */
    job?: Job;
    created?: boolean;
    decision?: AuthorityDecision;
    outcome: Outcome;
    /** Screening of the event's free text, kept with the record. */
    screened: Screened[];
}
/** Two deliveries of the same CI run are the same work. */
export declare function idempotencyKeyFor(event: CiFailureEvent): string;
/**
 * Turn a CI failure into work, if something authorizes it.
 *
 * Order matters. The event is screened and a job is recorded first, so a duplicate
 * delivery cannot become a second job even when authorization later refuses it —
 * and so a refusal is attributable to a specific event rather than vanishing.
 */
export declare function ingestCiFailure(event: CiFailureEvent, config: IntakeConfig): IntakeResult;
