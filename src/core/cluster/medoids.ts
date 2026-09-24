import type { ClusterRun } from "./types.ts"

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
 * - nothing selected → the run's ranked `topBySize`, already capped. A real
 *   dataset yields tens of thousands of clusters and drawing every medoid would
 *   reproduce the hairball the layer exists to replace.
 * - clusters selected → exactly those, however small, because an explicit
 *   choice outranks the ranking.
 *
 * `mask` is the current selection: a medoid whose patient the filters have
 * excluded must not be drawn, or the summary would claim a cohort that is no
 * longer on screen. Medoids are distinct by construction — a patient belongs to
 * one typology and one cluster within it — so no deduplication is needed.
 */
export function medoidPatients(
  run: ClusterRun,
  selectedClusters: readonly number[],
  mask: Uint8Array | null,
): Uint32Array {
  const chosen = selectedClusters.length === 0 ? null : new Set(selectedClusters)
  const refs = chosen === null ? run.topBySize : run.clusters

  const out = new Uint32Array(refs.length)
  let n = 0

  for (const ref of refs) {
    if (chosen !== null && !chosen.has(ref.globalIndex)) continue
    const patient = ref.medoidPatient
    if (mask !== null && mask[patient] !== 1) continue
    out[n] = patient
    n += 1
  }

  return out.subarray(0, n)
}
