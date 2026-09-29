import { TOP_CLUSTER_LIMIT, type ClusterRef, type ClusterRun } from "./types.ts"

/**
 * The patients whose paths stand in for their clusters.
 *
 * A medoid is a real patient — the member nearest its cluster's centre — so its
 * trajectory is drawable by the ordinary geometry builder with no special
 * casing. That is what makes this layer an *alternative* to the hairlines rather
 * than a second kind of thing: same buffers, same shader, same picking, a
 * thousand lines instead of a million.
 *
 * Which clusters get a spine follows the rest of the app's scoping rule —
 * selecting never re-runs anything, it only narrows what is drawn:
 *
 * - **clusters selected** → exactly those, however small. An explicit choice
 *   outranks any ranking.
 * - **the cohort is narrowed** (a typology, a filter) → *every* cluster whose
 *   medoid survives. This is the case that matters: a typology has a handful of
 *   clusters and the panel lists all of them, so the chart must not show a
 *   subset of a list the user is reading beside it.
 * - **nothing narrows it** → the run's ranked `topBySize`. The full run is tens
 *   of thousands of clusters and drawing every medoid rebuilds the hairball the
 *   layer exists to replace.
 *
 * The cap therefore applies to the *survivors*, not to the run. Applying it to
 * the run first was the bug: on the 25k dataset it hid 2,263 of 3,263 medoids,
 * and 924 of 938 typologies were missing at least one — selecting a typology
 * with 12 clusters drew 11 spines.
 *
 * Medoids are distinct by construction — a patient belongs to one typology and
 * to one cluster within it — so no deduplication is needed.
 */
export function medoidPatients(
  run: ClusterRun,
  selectedClusters: readonly number[],
  mask: Uint8Array | null,
  limit: number = TOP_CLUSTER_LIMIT,
  /**
   * Restrict to one typology's clusters — what the focused view draws, where
   * the rows are that sequence's own steps and a cluster from anywhere else
   * would be plotted against a ladder it never walked. There are at most a few
   * dozen, so the ranked cap never comes into it.
   */
  typologyKey: string | null = null,
): Uint32Array {
  const passes = (ref: ClusterRef): boolean =>
    (typologyKey === null || ref.typologyKey === typologyKey) &&
    (mask === null || mask[ref.medoidPatient] === 1)

  if (selectedClusters.length > 0) {
    const chosen = new Set(selectedClusters)
    return collect(run.clusters.filter((ref) => chosen.has(ref.globalIndex) && passes(ref)))
  }

  const survivors = run.clusters.filter(passes)
  if (survivors.length <= limit) return collect(survivors)

  /*
   * Too many to read. Fall back to the run's ranked top list — maintained
   * incrementally as results stream, so this needs no sort on the render path.
   * Filtering it can leave fewer than `limit`; that is the honest answer for a
   * view already too crowded to count, and the stats line reports what it drew.
   */
  return collect(run.topBySize.filter(passes).slice(0, limit))
}

function collect(refs: readonly ClusterRef[]): Uint32Array {
  const out = new Uint32Array(refs.length)
  for (let i = 0; i < refs.length; i++) out[i] = (refs[i] as ClusterRef).medoidPatient
  return out
}

/**
 * Every patient assigned to the chosen clusters.
 *
 * This is what makes a medoid legible as a *representative* rather than as one
 * more line: isolate a spine and the hairlines under it become exactly the
 * people it stands for, so the summary and its evidence are on screen together.
 * Without it a medoid is indistinguishable from an arbitrary trajectory drawn
 * thicker.
 *
 * `mask` is the current selection, applied for the same reason it is applied to
 * the spines: a cluster member the filters have excluded is not on screen and
 * must not be drawn back in by isolating their cluster.
 */
export function clusterMembers(
  run: ClusterRun,
  selectedClusters: readonly number[],
  mask: Uint8Array | null,
): Uint32Array {
  const out: number[] = []

  for (const globalIndex of selectedClusters) {
    // `globalIndex` indexes `clusters` by construction — the builder assigns it
    // as the position the ref is pushed to.
    const ref = run.clusters[globalIndex]
    if (ref === undefined) continue

    const result = run.byTypology.get(ref.typologyKey)
    if (result === undefined) continue

    for (let row = 0; row < result.n; row++) {
      if (result.assignment[row] !== ref.localCluster) continue
      const patient = result.patients[row] as number
      if (mask !== null && mask[patient] !== 1) continue
      out.push(patient)
    }
  }

  // Ascending, so the geometry builder walks the store's patient columns
  // forwards rather than jumping between typologies.
  out.sort((a, b) => a - b)
  return Uint32Array.from(out)
}
