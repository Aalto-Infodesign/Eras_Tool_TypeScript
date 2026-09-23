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

export interface ClusterParams {
  /** `null` → estimated per typology as `bandwidthFactor × mean pairwise distance`. */
  readonly bandwidth: number | null
  readonly bandwidthFactor: number
  /** × bandwidth. Higher merges more aggressively → fewer, coarser clusters. */
  readonly mergeFactor: number
  /** Unique rows converged per typology. */
  readonly maxSeeds: number
  readonly maxIteration: number
  readonly epsilon: number
  readonly scoreSampleLimit: number
  /** Typologies smaller than this are treated as a single cluster. */
  readonly minSize: number
  /**
   * × bandwidth. A seed starting this close to an already-converged mode is
   * taken to sit in that mode's basin of attraction and reuses it instead of
   * iterating. `0` disables the shortcut and converges every seed, which is what
   * the original did.
   */
  readonly seedPruneFactor: number
}

export const CLUSTER_DEFAULTS: ClusterParams = {
  bandwidth: null,
  bandwidthFactor: 0.3,
  mergeFactor: 2,
  maxSeeds: 500,
  maxIteration: 100,
  epsilon: 1e-4,
  scoreSampleLimit: 500,
  minSize: 2,
  seedPruneFactor: 0.5,
}

export interface TypologyClusters {
  readonly typologyKey: string
  /** Rows in this typology; `n === patients.length`. */
  readonly n: number
  /** Duration dimensions — `trajectoryLength - 1`. */
  readonly d: number
  /** Cluster count. */
  readonly k: number
  readonly bandwidth: number

  /** Row → global patient index. */
  readonly patients: Uint32Array
  /** Row → cluster index, length `n`. */
  readonly assignment: Uint16Array
  /**
   * Gaussian-kernel membership weights, `n × k`, each row summing to 1.
   * These are kernel weights, not calibrated probabilities — the same caveat the
   * original carried, preserved here because the TSV export surfaces them.
   */
  readonly memberships: Float32Array
  /** Cluster centres, `k × d`. */
  readonly centers: Float32Array
  readonly sizes: Uint32Array
  /** Cluster → row index of its medoid. */
  readonly medoidRow: Uint32Array
  /** Cluster → global patient index of its medoid. */
  readonly medoidPatient: Uint32Array

  readonly meanSilhouette: number
  /** Cluster whose medoid has the median total duration. */
  readonly medianCluster: number
  readonly durationMs: number
}

/** Flat view over every cluster in a run, for the table and the palette. */
export interface ClusterRef {
  /** Stable index across the whole run. */
  readonly globalIndex: number
  readonly typologyKey: string
  readonly localCluster: number
  readonly size: number
  readonly medoidPatient: number
}

export interface ClusterRun {
  readonly byTypology: ReadonlyMap<string, TypologyClusters>
  /** Patient → global cluster index, `-1` when unclustered. Length `patientCount`. */
  readonly clusterOfPatient: Int32Array
  readonly clusters: readonly ClusterRef[]
  /**
   * The largest clusters, already ranked, capped at `TOP_CLUSTER_LIMIT`.
   *
   * A real dataset yields tens of thousands of clusters, and the chart only ever
   * draws a few hundred of them. Maintaining this incrementally as results
   * stream in means the render path never re-sorts the full list — which it
   * would otherwise do on every streamed update.
   */
  readonly topBySize: readonly ClusterRef[]
  readonly params: ClusterParams
}

export const TOP_CLUSTER_LIMIT = 1000
