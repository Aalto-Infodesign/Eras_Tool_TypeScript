/**
 * Clustering results, columnar.
 *
 * The original worker returned, per silhouette, an array of cluster objects each
 * holding a `memberIDs: string[]`, plus an `assignments` array of
 * `{ trajectoryID, cluster, memberships: number[] }` — so a 25k dataset produced
 * ~25k objects and ~25k nested membership arrays *per run*, all of which had to
 * be structured-cloned back across the worker boundary.
 *
 * Here everything is a typed array indexed by row, and rows map to global patient
 * indices through `patients`. Membership lookup for patient `p` in cluster `c` is
 * `memberships[row * k + c]`. The whole result transfers.
 */
export const CLUSTER_DEFAULTS = {
    bandwidth: null,
    bandwidthFactor: 0.3,
    mergeFactor: 2,
    maxSeeds: 500,
    maxIteration: 100,
    epsilon: 1e-4,
    scoreSampleLimit: 500,
    minSize: 2,
    seedPruneFactor: 0.5,
};
export const TOP_CLUSTER_LIMIT = 1000;
