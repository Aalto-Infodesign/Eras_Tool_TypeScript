import type { IdColumn } from "../model/IdColumn.ts"
import type { TypologyClusters } from "./types.ts"

/**
 * Export payloads, built as strings by pure functions so they are testable
 * without a DOM. The download itself is the caller's business.
 *
 * Membership values are Gaussian-kernel weights, not calibrated probabilities —
 * the header says so explicitly, because the original only noted it in a code
 * comment while the exported file carried no such warning to whoever opened it.
 */

/** One id per line: the members of a single cluster. */
export function clusterMemberIds(
  result: TypologyClusters,
  cluster: number,
  ids: IdColumn,
): string[] {
  const out: string[] = []
  for (let row = 0; row < result.n; row++) {
    if (result.assignment[row] === cluster) out.push(ids.at(result.patients[row] as number))
  }
  return out
}

/** TSV of every patient in a typology: hard assignment plus one column per cluster. */
export function membershipsTsv(result: TypologyClusters, ids: IdColumn): string {
  const medoidIds: string[] = []
  for (let c = 0; c < result.k; c++) {
    medoidIds.push(ids.at(result.medoidPatient[c] as number))
  }

  const lines: string[] = [
    `# membership values are Gaussian-kernel weights (rows sum to 1), not calibrated probabilities`,
    `# typology=${result.typologyKey} bandwidth=${result.bandwidth.toFixed(6)} clusters=${result.k}`,
    ["FINNGENID", "assigned_cluster_medoid", ...medoidIds.map((id) => `membership_${id}`)].join(
      "\t",
    ),
  ]

  for (let row = 0; row < result.n; row++) {
    const assigned = result.assignment[row] as number
    const cells: string[] = [
      ids.at(result.patients[row] as number),
      medoidIds[assigned] ?? "",
    ]
    for (let c = 0; c < result.k; c++) {
      cells.push((result.memberships[row * result.k + c] ?? 0).toFixed(6))
    }
    lines.push(cells.join("\t"))
  }

  return lines.join("\n")
}

/** One row per cluster across the whole run — the table, as a file. */
export function clusterSummaryTsv(
  results: ReadonlyMap<string, TypologyClusters>,
  ids: IdColumn,
): string {
  const lines: string[] = [
    ["typology", "cluster", "size", "medoid", "bandwidth", "mean_silhouette", "is_median"].join(
      "\t",
    ),
  ]

  for (const result of results.values()) {
    for (let c = 0; c < result.k; c++) {
      lines.push(
        [
          result.typologyKey,
          String(c),
          String(result.sizes[c] ?? 0),
          ids.at(result.medoidPatient[c] as number),
          result.bandwidth.toFixed(6),
          result.meanSilhouette.toFixed(4),
          c === result.medianCluster ? "1" : "0",
        ].join("\t"),
      )
    }
  }

  return lines.join("\n")
}

// Both used to live here. They moved out when the silhouettes gained their own
// export, so that feature does not have to reach into the parked cluster code.
export { downloadText, safeFilename } from "../util/download.ts"
