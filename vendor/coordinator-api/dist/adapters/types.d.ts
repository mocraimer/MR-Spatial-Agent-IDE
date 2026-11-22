import type { ActionId, RuntimeId } from '../core/authority.js';
import type { Outcome } from '../core/outcome.js';
import type { SettingsSnapshot, SkillEvidence } from '../core/run.js';
import type { UsageResult } from '../core/usage.js';
/**
 * What a runtime actually lets a caller control.
 *
 * Declared per adapter rather than assumed, because the three selected runtimes
 * differ sharply: Claude Code takes `--model` and `--effort`, Pi takes `--model`
 * and `--thinking`, and Codex cloud task creation takes neither.
 */
export interface RuntimeCapabilities {
    runtime: RuntimeId;
    /** The account allowance this runtime draws on. Shared ids share admission state. */
    subscriptionId: string;
    /** False when the vendor chooses the model and the caller cannot. */
    supportsModelSelection: boolean;
    /** False when the vendor chooses the effort and the caller cannot. */
    supportsEffortSelection: boolean;
    /** Runtime-native effort names. Empty when effort is not selectable. */
    effortLevels: string[];
    /**
     * True when the runtime reports back what it actually ran with. When false, a
     * run records its effective settings as `unknown` rather than echoing the request.
     */
    reportsEffectiveSettings: boolean;
    /** True when a session id can be supplied by the caller instead of read back. */
    acceptsCallerSessionId: boolean;
    /** How this runtime is told to enter the manifest-dev skill. */
    skillInvocationForm: string;
}
/** The settings a dispatch asks for, before defaults are resolved. */
export interface SettingsRequest {
    model?: string;
    effort?: string;
    /** Set when the profile explicitly accepts whatever the vendor picks. */
    acceptVendorDefault?: boolean;
}
export interface DispatchInput {
    taskId: string;
    runId: string;
    /** The task text, which the adapter wraps in its runtime's skill invocation. */
    task: string;
    repoPath: string;
    settings: SettingsRequest;
    /**
     * The tier the authorizing approval bound this run to, when it named one.
     *
     * Supplied as a default rather than folded into `settings`, so the snapshot can
     * still say what the *caller* asked for. An approval's tier decides what runs;
     * it does not rewrite the record of who asked for what.
     */
    approvedTier?: {
        model?: string;
        effort?: string;
    };
    /** Where the adapter must persist evidence, outside any disposable vendor home. */
    evidenceDir: string;
    /** Caller-chosen session id, used where the runtime accepts one. */
    sessionId?: string;
    timeoutMs?: number;
    /**
     * How the task reaches the runtime. `skill` wraps it in the runtime's general
     * manifest-dev entry; `review-pr` enters that skill directly; `prompt` sends it
     * as written for side-effect-free evaluator prompts.
     */
    entry?: 'skill' | 'review-pr' | 'prompt' | 'interactive';
    /** Host-bound interactive identity; never a prompt/evaluator entry. */
    interactive?: {
        requestId: string;
        conversationId: string;
        parentRunId?: string;
    };
    /** The actions the run is authorized for, so an adapter can scope its tools to them. */
    actions?: ActionId[];
}
export interface DispatchResult {
    outcome: Outcome;
    settings: SettingsSnapshot;
    skill?: SkillEvidence;
    sessionId?: string;
    /** Anything the run produced that a reviewer would need. */
    artifacts?: Record<string, string>;
}
export interface RuntimeAdapter {
    readonly capabilities: RuntimeCapabilities;
    /** Only adapters with an enforced custom-tool boundary may opt in. */
    readonly guardedInteractive?: true;
    /** Read this runtime's subscription usage through a supported interface. */
    readUsage(): Promise<UsageResult>;
    /**
     * Confirm the runtime is usable now; a setup gap is reported, never guessed past.
     * `entry` scopes the check to how the task would be sent: a prompt entry does not
     * need the skill a skill entry wraps it in.
     */
    checkReadiness(entry?: 'skill' | 'review-pr' | 'prompt'): Promise<Outcome | undefined>;
    dispatch(input: DispatchInput): Promise<DispatchResult>;
    /** Reconcile a session whose local record is uncertain, using retained run evidence when available. */
    reconcile(sessionId: string, evidenceDir?: string): Promise<Outcome>;
    /**
     * A session id to use for the next dispatch, for a runtime that lets the caller
     * name one. The coordinator records it before the run starts, so a run that
     * loses contact can still be reconciled by id.
     */
    newSessionId?(): string;
    /**
     * Stop a run this machine started, by its session id. Resolves true when a live
     * process was signalled, false when none was running. A runtime without it
     * cannot be stopped from the coordinator.
     */
    stop?(sessionId: string): Promise<boolean>;
}
export declare class UnsupportedSettingError extends Error {
    readonly field: 'model' | 'effort';
    readonly name = "UnsupportedSettingError";
    constructor(message: string, field: 'model' | 'effort');
}
/**
 * Resolve a settings request against a runtime's real capabilities.
 *
 * Throws rather than adjusting. Quietly downgrading an unsupported effort to a
 * supported one would produce a run whose record says one thing and whose
 * execution did another, which is the exact confusion the settings snapshot
 * exists to prevent.
 */
export declare function resolveSettings(caps: RuntimeCapabilities, request: SettingsRequest, defaults?: {
    model?: string;
    effort?: string;
}): SettingsSnapshot['resolved'];
/** Build the snapshot a run record keeps, given what the runtime reported back. */
export declare function snapshot(caps: RuntimeCapabilities, request: SettingsRequest, resolved: SettingsSnapshot['resolved'], reported?: {
    model?: string;
    effort?: string;
}): SettingsSnapshot;
