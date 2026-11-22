/**
 * Structural guards for records read back from disk.
 *
 * `readJson<T>` casts parsed JSON to the requested type, which is sound only if
 * the file really holds that shape. Nothing guarantees it: a record may predate a
 * field, a crash may leave a partial write, or an operator may hand-edit the state
 * directory. Where code then spreads or iterates a field the type promises is an
 * array, the failure is a TypeError far from the cause.
 *
 * These guards are deliberately shallow. They check the fields whose absence
 * actually breaks something — arrays that get spread, identifiers that get
 * compared — rather than validating every leaf, because a guard nobody can read is
 * one nobody maintains.
 */
export declare class RecordShapeError extends Error {
    readonly name = "RecordShapeError";
    constructor(kind: string, path: string, detail: string);
}
/** Fields each stored kind must carry for the code that reads it not to crash. */
declare const REQUIRED: Record<string, {
    strings: string[];
    numbers: string[];
    arrays: string[];
    /**
     * Fields a record may omit, but may not hold a wrong type in. Absence is
     * compatibility — an approval written before the field existed is still good.
     * A present value of the wrong type is corruption, and reaches the reader as
     * an `Approval` whose `model` is a number.
     */
    optionalStrings?: string[];
}>;
/**
 * Check a stored record has the shape its readers assume.
 *
 * Returns the value unchanged when it is usable, and throws a named error when it
 * is not — a clear failure at the read, rather than an opaque one at first use.
 */
export declare function checkShape<T>(kind: keyof typeof REQUIRED, path: string, value: unknown): T;
/** The kinds `checkShape` knows about, exported so tests can enumerate them. */
export declare const SHAPE_KINDS: string[];
export {};
