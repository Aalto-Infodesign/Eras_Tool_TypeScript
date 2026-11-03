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
    const cells: string[] = [ids.at(result.patients[row] as number), medoidIds[assigned] ?? ""]
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

/** Lines per `Blob` chunk in the members file, which runs to one line per patient. */
const MEMBER_CHUNK = 5000

/**
 * The selection as two tables joined on `typology_id`:
 *
 * - `typologies`: `typology_id, states, n_patients, n_clusters`, one row per
 *   typology with anyone in the selection.
 * - `members`: `typology_id, cluster, id, weight, is_medoid`, one row per
 *   patient — long rather than a column per cluster, so it grows only with the
 *   patients however finely a typology was clustered.
 *
 * `typology_id` is `T` + the typology's size rank. `cluster` is the cluster's
 * index within its typology, the same number the cluster summary uses.
 * `weight` is the patient's Gaussian-kernel weight in the cluster it was
 * assigned to — a kernel weight, not a calibrated weight.
 *
 * `keep` narrows every cluster to the selection: a cluster with nobody left is
 * not counted, and a medoid outside the selection has no row, so it is not
 * flagged either. A typology without clustering (too small, or not reached yet)
 * has `n_clusters` 0 and `NA` for its members' cluster and weight.
 */
export function selectionTsvs(
  typologies: readonly Typology[],
  results: ReadonlyMap<string, TypologyClusters> | null,
  keep: (patient: number) => boolean,
  ids: IdColumn,
): { typologies: string[]; members: string[] } {
  const typologyLines: string[] = [["typology_id", "states", "n_patients", "n_clusters"].join("\t")]
  const members: string[] = [
    `${["typology_id", "cluster", "id", "weight", "is_medoid"].join("\t")}\n`,
  ]
  let pending: string[] = []
  const push = (line: string): void => {
    pending.push(line)
    if (pending.length < MEMBER_CHUNK) return
    members.push(`${pending.join("\n")}\n`)
    pending = []
  }

  typologies.forEach((typology, rank) => {
    const id = `T${rank + 1}`
    const result = results?.get(typology.key)
    let size = 0
    let clusterCount = 0

    if (result === undefined) {
      for (const patient of typology.patients) {
        if (!keep(patient)) continue
        push(`${id}\tNA\t${ids.at(patient)}\tNA\tFALSE`)
        size += 1
      }
    } else {
      const seen = new Uint8Array(result.k)
      for (let row = 0; row < result.n; row++) {
        const patient = result.patients[row] as number
        if (!keep(patient)) continue
        const c = result.assignment[row] as number
        const weight = Math.round((result.memberships[row * result.k + c] ?? 0) * 1000) / 1000
        const isMedoid = result.medoidPatient[c] === patient ? "TRUE" : "FALSE"
        push(`${id}\t${c}\t${ids.at(patient)}\t${weight}\t${isMedoid}`)
        size += 1
        if (seen[c] === 0) {
          seen[c] = 1
          clusterCount += 1
        }
      }
    }

    if (size > 0) typologyLines.push([id, typology.key, size, clusterCount].join("\t"))
  })

  if (pending.length > 0) members.push(`${pending.join("\n")}\n`)
  return { typologies: [`${typologyLines.join("\n")}\n`], members }
}

// Both used to live here. They moved out when the silhouettes gained their own
// export, so that feature does not have to reach into the parked cluster code.
export { downloadText, safeFilename } from "../util/download.ts"
