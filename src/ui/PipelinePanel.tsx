import { useMemo, useState } from "react"

import { focusedTypologyOf, useEras } from "../app/store.ts"
import { clusterMembers } from "../core/cluster/medoids.ts"
import type { NumericFilter } from "../core/query/filters.ts"
import {
  isolatedClusters,
  patientIdsCsv,
  patientRecordsJson,
  pipelineFailures,
  STEP_BITS,
  survivorCounts,
  survivors,
  type PipelineStep,
} from "../core/query/pipeline.ts"
import type { TrajectoryStore } from "../core/types.ts"
import { download } from "./download.ts"
import { LABELS } from "./FiltersPanel.tsx"
import { Panel } from "./Panel.tsx"
import { useClusterRun } from "./useClusterRun.ts"

type Format = "ids" | "records"

/** A row of the chain: the dataset itself, the splice, then the ordered steps. */
type Row = "source" | "removedStates" | PipelineStep

interface Link {
  readonly row: Row
  readonly label: string
  readonly detail: string
  readonly count: number
  /** Patients this row cut from the one above; 0 for the dataset. */
  readonly cut: number
  /** Every bit up to and including this row: who an export of it leaves out. */
  readonly bits: number
}

/** The id column's name when the file did not say: the original's hardcoded one. */
const DEFAULT_ID_HEADER = "FINNGENID"

/**
 * Build & export: how the chart's patients were arrived at, as a chain, with
 * every link exportable.
 *
 * The original's Pipeline panel was a node graph of the derived-data stages,
 * each reporting how many patients survive to it. This keeps that reading —
 * one count per stage, top to bottom — but as a list in the column, in the order
 * the user applied the steps rather than the order the code happens to run
 * them. The last link is what is on screen, so exporting it is exporting the
 * visualization's individuals.
 */
export function PipelinePanel(): React.JSX.Element | null {
  const store = useEras((s) => s.store)
  const baseStore = useEras((s) => s.baseStore)
  const fileName = useEras((s) => s.fileName)
  const mapping = useEras((s) => s.mapping)
  const filters = useEras((s) => s.filters)
  const selectionVersion = useEras((s) => s.selectionVersion)
  const typologies = useEras((s) => s.typologies)
  const selectedTypologies = useEras((s) => s.selectedTypologies)
  const pathSteps = useEras((s) => s.pathSteps)
  const expectations = useEras((s) => s.expectations)
  const activeExpectations = useEras((s) => s.activeExpectations)
  const selectedClusters = useEras((s) => s.selectedClusters)
  const view = useEras((s) => s.view)
  const order = useEras((s) => s.pipelineOrder)
  const clusterRun = useClusterRun()
  const clusterVersion = useEras((s) => s.clusterVersion)

  const resetFilter = useEras((s) => s.resetFilter)
  const resetStates = useEras((s) => s.resetStates)
  const clearTypologies = useEras((s) => s.clearTypologies)
  const clearClusters = useEras((s) => s.clearClusters)

  const [format, setFormat] = useState<Format>("ids")

  // Computed here rather than through `isolatedClustersOf`: a selector that
  // builds a new array on every call never settles.
  const isolated = useMemo(
    () =>
      isolatedClusters(
        clusterRun,
        selectedClusters,
        view === "trajectories" ? focusedTypologyOf(selectedTypologies) : null,
      ),
    [clusterRun, selectedClusters, view, selectedTypologies],
  )

  /*
   * One exhaustive scan for every bit, then one pass to charge each patient to
   * the first link that cuts them. Re-run on every selection change, so it
   * follows a drag — the same order of cost as the filter scan itself.
   */
  const chain = useMemo(() => {
    if (store === null) return null

    const keys = new Set(selectedTypologies)
    const chosen =
      selectedTypologies.length > 0
        ? typologies.filter((typology) => keys.has(typology.key)).map((t) => t.patients)
        : null
    const members =
      isolated.length > 0 && clusterRun !== null ? clusterMembers(clusterRun, isolated, null) : null

    const failures = pipelineFailures(store, filters, chosen, members)
    const rows: Row[] = [...(filters.removedStates.length > 0 ? (["removedStates"] as const) : []), ...order]
    const counts = survivorCounts(
      failures,
      rows.map((row) => STEP_BITS[row as PipelineStep | "removedStates"]),
    )
    return { failures, rows, counts }
    // `selectionVersion` stands for the masks the scan mirrors; `clusterVersion`
    // for a run that streams in without changing identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, filters, typologies, selectedTypologies, isolated, clusterRun, clusterVersion, order, selectionVersion])

  const links = useMemo<readonly Link[]>(() => {
    if (store === null || chain === null) return []

    const names = (states: Iterable<number>): string[] =>
      Array.from(states, (state) => store.stateNames[state] ?? String(state))

    const describe = (row: Row): { label: string; detail: string } => {
      switch (row) {
        case "source":
          return { label: "Dataset", detail: fileName ?? "" }
        case "removedStates":
          return { label: "Removed states", detail: names(filters.removedStates).join(", ") }
        case "typologies": {
          const saved = expectations
            .filter((expectation) => activeExpectations.includes(expectation.id))
            .map((expectation) => expectation.name)
          if (saved.length > 0 || pathSteps.length > 0) {
            const walk = pathSteps.length > 0 ? [names(pathSteps).join(" → ")] : []
            return { label: "Path", detail: [...saved, ...walk].join(" ∪ ") }
          }
          if (selectedTypologies.length === 1) {
            const typology = typologies.find((t) => t.key === selectedTypologies[0])
            return {
              label: "Typology",
              detail: typology === undefined ? "" : names(typology.states).join(" → "),
            }
          }
          return { label: "Typologies", detail: `${selectedTypologies.length} chosen` }
        }
        case "clusters":
          return {
            label: "Clusters",
            detail: `${isolated.length} isolated in ${selectedTypologies[0] ?? ""}`,
          }
        default: {
          const range = filters[row]
          const inverted = filters.inverted[row] === true
          return {
            label: LABELS[row],
            detail:
              range === null
                ? ""
                : `${inverted ? "outside " : ""}${range.min.toFixed(1)} – ${range.max.toFixed(1)}`,
          }
        }
      }
    }

    const out: Link[] = [{ row: "source", ...describe("source"), count: store.patientCount, cut: 0, bits: 0 }]
    let bits = 0
    chain.rows.forEach((row, i) => {
      bits |= STEP_BITS[row as PipelineStep | "removedStates"]
      const count = chain.counts[i] as number
      const above = (out[out.length - 1] as Link).count
      out.push({ row, ...describe(row), count, cut: above - count, bits })
    })
    return out
  }, [
    store,
    chain,
    fileName,
    filters,
    expectations,
    activeExpectations,
    pathSteps,
    selectedTypologies,
    typologies,
    isolated,
  ])

  if (store === null || baseStore === null || chain === null) return null

  const total = store.patientCount
  const final = links[links.length - 1] as Link
  const idHeader = mapping?.mapping.patientId ?? DEFAULT_ID_HEADER

  const exportLink = (link: Link, index: number): void => {
    // The dataset link is the file as loaded; every later one reads the store
    // the chart draws, removed states spliced out of each trajectory.
    const source: TrajectoryStore = link.row === "source" ? baseStore : store
    const patients = survivors(link.row === "source" ? new Uint8Array(total) : chain.failures, link.bits)
    const base = (fileName ?? "eras").replace(/\.[^.]+$/, "")
    const name = `${base}-${String(index).padStart(2, "0")}-${slug(link.label)}-${patients.length}`

    if (format === "ids") {
      download(`${name}.csv`, patientIdsCsv(source, patients, idHeader), "text/csv")
    } else {
      download(`${name}.json`, patientRecordsJson(source, patients, idHeader), "application/json")
    }
  }

  const drop = (row: Row): void => {
    if (row === "removedStates") resetStates()
    else if (row === "typologies") clearTypologies()
    else if (row === "clusters") clearClusters()
    else if (row !== "source") resetFilter(row as NumericFilter)
  }

  return (
    <Panel
      title="Build & export"
      count={
        <span key={selectionVersion}>
          {final.count.toLocaleString()} / {total.toLocaleString()}
        </span>
      }
    >
      <div className="pipeline__format" role="group" aria-label="Export format">
        <span>Export as</span>
        <button
          type="button"
          className="button button--tiny"
          data-selected={format === "ids"}
          title="One id per line, to join back onto the source data"
          onClick={() => setFormat("ids")}
        >
          IDs · csv
        </button>
        <button
          type="button"
          className="button button--tiny"
          data-selected={format === "records"}
          title="Whole trajectories, in a JSON this tool loads back in"
          onClick={() => setFormat("records")}
        >
          Records · json
        </button>
      </div>

      <ol className="pipeline">
        {links.map((link, index) => {
          const isLast = index === links.length - 1
          return (
            <li key={link.row} className="pipeline__step" data-last={isLast} data-source={index === 0}>
              <span className="pipeline__dot" aria-hidden="true" />
              <div className="pipeline__body">
                <div className="pipeline__head">
                  <span className="pipeline__label">{link.label}</span>
                  <span className="pipeline__count">{link.count.toLocaleString()}</span>
                </div>
                <div className="pipeline__meta">
                  <span className="pipeline__detail" title={link.detail}>
                    {isLast && index > 0 ? "on screen · " : ""}
                    {link.detail}
                  </span>
                  {link.cut > 0 && <span className="pipeline__cut">−{link.cut.toLocaleString()}</span>}
                </div>
                <div className="pipeline__bar" aria-hidden="true">
                  <span style={{ width: `${total === 0 ? 0 : (link.count / total) * 100}%` }} />
                </div>
              </div>
              <div className="pipeline__actions">
                <button
                  type="button"
                  className="button button--tiny"
                  disabled={link.count === 0}
                  title={`Export the ${link.count.toLocaleString()} individuals at this step`}
                  aria-label={`Export ${link.label}`}
                  onClick={() => exportLink(link, index)}
                >
                  ⤓
                </button>
                {/* The dataset cannot be dropped, but keeps the column's width, so
                    every bar is drawn to the same length for the same share. */}
                <button
                  type="button"
                  className="button button--tiny"
                  title="Drop this step"
                  aria-label={`Drop ${link.label}`}
                  aria-hidden={index === 0}
                  tabIndex={index === 0 ? -1 : undefined}
                  style={index === 0 ? { visibility: "hidden" } : undefined}
                  onClick={() => drop(link.row)}
                >
                  ✕
                </button>
              </div>
            </li>
          )
        })}
      </ol>

      {links.length === 1 && (
        <p className="pipeline__empty">
          Nothing narrows the cohort yet. Filters, typology picks, paths and isolated clusters
          appear here as you apply them.
        </p>
      )}
    </Panel>
  )
}

const slug = (label: string): string => label.toLowerCase().replace(/[^a-z0-9]+/g, "-")
