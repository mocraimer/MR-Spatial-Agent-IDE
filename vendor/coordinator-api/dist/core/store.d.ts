import { checkShape } from './validate.js';
type ShapeKind = Parameters<typeof checkShape>[0];
/**
 * Durable state root. Everything the coordinator must survive a restart with lives
 * here — outside any disposable vendor session home, per the Initial Approach.
 */
export declare function stateRoot(): string;
export declare function newId(prefix: string): string;
/** Write a JSON document so a reader never observes a partial file. */
export declare function writeJson(path: string, value: unknown): void;
export declare function readJson<T>(path: string): T | undefined;
/**
 * Read a record and check it has the shape its readers assume.
 *
 * `readJson` is the raw form and stays available for small config files where a
 * missing field is handled by a default. Durable records that get spread or
 * iterated go through this instead, so a malformed one fails at the read with a
 * named error rather than as a TypeError somewhere downstream.
 */
export declare function readRecord<T>(kind: ShapeKind, path: string): T | undefined;
/**
 * Read a whole collection, checking each record.
 *
 * A single malformed file must not take down a listing the dispatch path depends
 * on — `listGrants` feeds authorization, and a `TypeError` there would refuse every
 * grant-authorized dispatch with no indication which file was at fault. Bad records
 * are skipped and named on stderr instead.
 */
export declare function listRecords<T>(kind: ShapeKind, dir: string): T[];
export declare function listJson<T>(dir: string): T[];
/** Legacy timeout constant retained for callers; live locks are never time-stolen. */
export declare const LOCK_STALE_MS = 60000;
/** Bound slow operations under a lock without relying on lock expiration. */
export declare function maxLockedOperationMs(): number;
/**
 * Kernel-owned cross-process lock on a stable inode. Never unlink these files:
 * doing so lets a new opener lock a different inode while the old holder runs.
 * Closing the owning descriptor (including process death) releases the lock.
 * All writers must use this protocol; old existence/staleness writers must be
 * quiesced before activation. Synchronous bodies must not return promises.
 */
export declare function withLock<T>(name: string, fn: () => T): T;
/**
 * Hold a complete ordered set through one synchronous operation, without recursive
 * call depth. Acquisition/resource failures never run a partial operation. Unwind
 * every owned descriptor even if acquisition, the body, or another release fails.
 */
export declare function withLocks<T>(names: readonly string[], fn: () => T): T;
/** Reuse only this process's still-owned synchronous dispatch descriptor, never an async holder. */
export declare function withDispatchFence<T>(fn: () => T): T;
/** Same ownership across awaits, with event-loop-friendly bounded acquisition. */
export declare function withLockAsync<T>(name: string, fn: () => Promise<T>): Promise<T>;
/** Stable digest used to bind a record to the exact bytes it was derived from. */
export declare function digest(value: unknown): string;
export declare function fileDigest(path: string): string;
export {};
