import type { IdColumn } from "../model/IdColumn.ts"
import type { Typology } from "../types.ts"
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

/**
 * One row per typology in the selection, its clusters packed into one JSON cell:
 * `[{"medoid": id, "members": [[id, weight], …]}, …]`, largest cluster first.
 *
 * The membership TSV grows a column per cluster; this grows only with the
 * patients, because each one carries a single weight — its membership in the
 * cluster it was assigned to. `keep` narrows every cluster to the selection; a
 * cluster with nobody left is dropped, but a medoid outside the selection still
 * names its cluster. A typology without clustering (too small, or not reached
 * yet) is one cluster with a `null` medoid and `null` weights.
 *
 * Returned as one chunk per line, for a `Blob`: a typology of half a million
 * patients is a cell of megabytes.
 */
export function typologyClustersTsv(
  typologies: readonly Typology[],
  results: ReadonlyMap<string, TypologyClusters> | null,
  keep: (patient: number) => boolean,
  ids: IdColumn,
): string[] {
  const chunks: string[] = [
    `# clusters = JSON [{"medoid": id, "members": [[id, weight], ...]}, ...]; weight = Gaussian-kernel membership in the assigned cluster, not a calibrated probability; medoid null = not clustered\n`,
    `${["typology_id", "states", "n_patients", "n_clusters", "clusters"].join("\t")}\n`,
  ]

  typologies.forEach((typology, rank) => {
    const result = results?.get(typology.key)
    let clusters: { medoid: string; members: string[] }[]

    if (result === undefined) {
      const members: string[] = []
      for (const patient of typology.patients) {
        if (keep(patient)) members.push(`[${JSON.stringify(ids.at(patient))},null]`)
      }
      clusters = [{ medoid: "null", members }]
    } else {
      clusters = Array.from({ length: result.k }, (_, c) => ({
        medoid: JSON.stringify(ids.at(result.medoidPatient[c] as number)),
        members: [] as string[],
      }))
      for (let row = 0; row < result.n; row++) {
        const patient = result.patients[row] as number
        if (!keep(patient)) continue
        const c = result.assignment[row] as number
        const weight = Math.round((result.memberships[row * result.k + c] ?? 0) * 1000) / 1000
        clusters[c]?.members.push(`[${JSON.stringify(ids.at(patient))},${weight}]`)
      }
    }

    clusters = clusters
      .filter((cluster) => cluster.members.length > 0)
      .sort((a, b) => b.members.length - a.members.length)
    const size = clusters.reduce((sum, cluster) => sum + cluster.members.length, 0)
    if (size === 0) return

    const cell = `[${clusters
      .map((cluster) => `{"medoid":${cluster.medoid},"members":[${cluster.members.join(",")}]}`)
      .join(",")}]`
    chunks.push(
      `${[
        `T${rank + 1}`,
        typology.key,
        String(size),
        String(result === undefined ? 0 : clusters.length),
        cell,
      ].join("\t")}\n`,
    )
  })

  return chunks
}

// Both used to live here. They moved out when the silhouettes gained their own
// export, so that feature does not have to reach into the parked cluster code.
export { downloadText, safeFilename } from "../util/download.ts"
