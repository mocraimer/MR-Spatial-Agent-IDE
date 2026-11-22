/** Content-addressed build stamp, written after compilation, never inferred from activation. */
export interface BuildIdentity {
    digest: string;
    revision: string | null;
    dirty: boolean;
    builtAt: string;
}
/** Captured once. Rebuilding files or activating metadata cannot relabel this process. */
export declare const loadedBuild: Readonly<BuildIdentity> | null;
export declare function buildIdentityView(selectedCoordinator?: string): {
    loaded: Readonly<BuildIdentity> | null;
    onDisk: Readonly<BuildIdentity> | null;
    selectedCoordinator: string | null;
    loadedMatchesDisk: boolean | null;
    loadedMatchesSelected: boolean | null;
};
