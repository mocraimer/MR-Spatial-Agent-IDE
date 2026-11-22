import { type Actor } from './authority.js';
export interface InteractiveArchiveInput {
    archiveId: string;
    product: {
        kind: 'project' | 'space' | 'task';
        id: string;
    };
    receivers: Array<{
        spaceId: string;
        conversationId: string;
        taskId: string | null;
    }>;
    /** Existing coordinator tasks and known linked runs, not host paths or model selectors. */
    taskIds: string[];
    runIds: string[];
}
export interface InteractiveArchiveReceipt {
    version: 1;
    archiveId: string;
    fingerprint: string;
    input: InteractiveArchiveInput;
    state: 'prepared' | 'archived';
    preparedAt: string;
    preparedBy: string;
    archivedAt?: string;
    /** Expanded once under admission: descendants, conversations and retained run identities. */
    fence: {
        taskIds: string[];
        conversationIds: string[];
        runIds: string[];
    };
    runPins: Record<string, {
        record: string;
        evidence: string;
    }>;
    inventoryDigest: string;
    choices: Array<{
        by: string;
        at: string;
        action: 'archive' | 'reconcile' | 'retry';
    }>;
    failure?: 'commit-not-acknowledged' | 'asynchronous-callback';
}
/** Trusted library reads actual product SQL state; no public client/model boolean can attest it. */
export interface InteractiveArchiveObservation {
    archiveId: string;
    fingerprint: string;
    product: InteractiveArchiveInput['product'];
    state: 'archived' | 'uncommitted';
}
export type InteractiveArchiveCommit = (receipt: Readonly<InteractiveArchiveReceipt>) => InteractiveArchiveObservation;
export type InteractiveArchiveObserve = InteractiveArchiveCommit;
export interface ArchiveTarget {
    taskId: string;
    conversationId?: string;
    rootTaskId?: string;
    parentRunId?: string;
    runId?: string;
}
/** Irreversible lifecycle cutoff, not another permission store. Every fresh writer checks it. */
export declare function archivedTarget(target: ArchiveTarget): InteractiveArchiveReceipt | undefined;
export declare function assertNotArchived(target: ArchiveTarget): void;
/** Owner-only whole-history archive; no lifetime count cap, inference, stop or evidence rewrite. */
export declare function interactiveArchive(actor: Actor, raw: InteractiveArchiveInput, commit: InteractiveArchiveCommit): InteractiveArchiveReceipt;
export declare function interactiveArchiveLookup(actor: Actor, archiveId: string): InteractiveArchiveReceipt | undefined;
/** Lost acknowledgement uses a fresh trusted SQL read, never another tombstone or implicit resume. */
export declare function interactiveArchiveReconcile(actor: Actor, archiveId: string, inspect: InteractiveArchiveObserve, retryCommit?: InteractiveArchiveCommit): InteractiveArchiveReceipt;
