import { clusterRunOf, focusedTypologyOf, useEras } from "../app/store.ts"
import { membershipsTsv, selectionTsvs } from "../core/cluster/export.ts"
import { clusterMembers } from "../core/cluster/medoids.ts"
import {
  isolatedClusters,
  patientIdsCsv,
  pipelineFailures,
  STEP_BITS,
  survivors,
  type PipelineStep,
} from "../core/query/pipeline.ts"
import { safeFilename } from "../core/util/download.ts"
import { download } from "./download.ts"

/** The id column's name when the file did not say: the original's hardcoded one. */
const DEFAULT_ID_HEADER = "FINNGENID"

/**
 * One-click exports from the charts themselves, without opening a side panel.
 *
 * Read from the store at click time rather than subscribed to: the scan behind
 * the selection is exhaustive, and paying for it on every drag to keep a button
 * up to date would be paying for a file nobody asked for yet.
 */

type ErasState = ReturnType<typeof useEras.getState>

/**
 * Who is on screen: the last link of "Build & export", from the same scan, so
 * every file here lists the same patients that panel does. A patient survives
 * when `(failures[p] & bits) === 0`.
 */
function scanSelection(state: ErasState): { failures: Uint8Array; bits: number } | null {
  const { store, filters, typologies, selectedTypologies, selectedClusters, view } = state
  if (store === null) return null

  const clusterRun = clusterRunOf(state)
  const keys = new Set(selectedTypologies)
  const chosen =
    selectedTypologies.length > 0
      ? typologies.filter((typology) => keys.has(typology.key)).map((t) => t.patients)
      : null
  const isolated = isolatedClusters(
    clusterRun,
    selectedClusters,
    view === "trajectories" ? focusedTypologyOf(selectedTypologies) : null,
  )
  const members =
    isolated.length > 0 && clusterRun !== null ? clusterMembers(clusterRun, isolated, null) : null

  const failures = pipelineFailures(store, filters, chosen, members)
  const rows = [
    ...(filters.removedStates.length > 0 ? (["removedStates"] as const) : []),
    ...state.pipelineOrder,
  ]
  const bits = rows.reduce((acc, row) => acc | STEP_BITS[row as PipelineStep | "removedStates"], 0)
  return { failures, bits }
}

const baseName = (state: ErasState): string => (state.fileName ?? "eras").replace(/\.[^.]+$/, "")

/**
 * The selection as two files joined on `typology_id`: one row per typology, and
 * one row per patient with its cluster (`selectionTsvs`).
 */
export function exportSelection(): void {
  const state = useEras.getState()
  const scan = scanSelection(state)
  if (state.store === null || scan === null) return

  const { failures, bits } = scan
  const files = selectionTsvs(
    state.typologies,
    clusterRunOf(state)?.byTypology ?? null,
    (patient) => ((failures[patient] as number) & bits) === 0,
    state.store.ids,
  )
  const base = `${baseName(state)}-selection`
  download(`${base}-typologies.tsv`, files.typologies, "text/tab-separated-values")
  download(`${base}-members.tsv`, files.members, "text/tab-separated-values")
}

/** The selection as a plain id list, one per line: enough to join back onto the source data. */
export function exportSelectionIds(): void {
  const state = useEras.getState()
  const scan = scanSelection(state)
  if (state.store === null || scan === null) return

  const patients = survivors(scan.failures, scan.bits)
  const idHeader = state.mapping?.mapping.patientId ?? DEFAULT_ID_HEADER
  download(
    `${baseName(state)}-selection-${patients.length}.csv`,
    patientIdsCsv(state.store, patients, idHeader),
    "text/csv",
  )
}

/**
 * One typology's cluster memberships, the cluster table's "Memberships TSV".
 * False when that typology has no clustering to export.
 */
export function exportMemberships(typologyKey: string): boolean {
  const state = useEras.getState()
  const result = clusterRunOf(state)?.byTypology.get(typologyKey)
  if (state.store === null || result === undefined) return false
  download(
    `memberships_${safeFilename(typologyKey)}.tsv`,
    [membershipsTsv(result, state.store.ids)],
    "text/tab-separated-values",
  )
  return true
}
