import { create } from "zustand"

import { CLUSTERING_ENABLED } from "./features.ts"
import { buildDurationMatrices } from "../core/cluster/matrices.ts"
import { ClusterRunBuilder } from "../core/cluster/run.ts"
import { CLUSTER_DEFAULTS, type ClusterParams, type ClusterRun } from "../core/cluster/types.ts"
import { countLivePatients, spliceStates } from "../core/model/reshape.ts"
import { fromPayload } from "../core/model/transfer.ts"
import {
  applyFilters,
  emptyFilters,
  intersectTypologies,
  type FilterState,
  type NumericFilter,
} from "../core/query/filters.ts"
import { visibleExtent } from "../core/query/extent.ts"
import { Selection } from "../core/query/Selection.ts"
import { buildDistributions, type FilterDistributions } from "../core/stats/distributions.ts"
import { summariseStates } from "../core/stats/states.ts"
import { buildTypologies } from "../core/stats/typologies.ts"
import type { MappingCandidate } from "../core/parse/schema.ts"
import type { RendererKind } from "../core/render/Renderer.ts"
import type { XAxis } from "../core/render/geometry.ts"
import type { TrajectoryStore, Typology } from "../core/types.ts"
import { Stopwatch, type Timing } from "../core/util/time.ts"
import { ClusterClient } from "../workers/clusterClient.ts"
import { IngestClient } from "../workers/ingestClient.ts"
import type { StateSummaryPayload } from "../workers/protocol.ts"

/**
 * One flat store instead of the seven nested providers.
 *
 * The provider chain forced every consumer of any context to re-render whenever
 * any value above it changed, which is why moving a slider rippled through the
 * whole tree. Here components subscribe to the exact fields they read.
 *
 * `store` and `selection` are large mutable objects held *outside* React's
 * reconciliation: `selectionVersion` is the reactive signal that the selection's
 * contents changed, so filtering rewrites a buffer in place rather than
 * allocating a new dataset for React to diff.
 */

export type LoadStatus = "idle" | "loading" | "ready" | "error"
export type ClusterStatus = "idle" | "running" | "paused" | "done" | "error"

/** What the bulk layer is coloured by. Only `state` is reachable while clustering is parked. */
export type ColorBy = "state" | "cluster"
/**
 * Which reading the chart shows. These are alternatives, not a stack: lumps
 * replace the hairlines rather than sitting over them, as in the original, and
 * the medoid spines replace both with one line per cluster.
 *
 * `medoids` is only reachable while clustering is on — see `app/features.ts`.
 */
export type ChartLayer = "lines" | "lumps" | "medoids"

interface ErasState {
  status: LoadStatus
  error: string | null
  fileName: string | null

  /** The dataset as it is drawn — the ingest store with removed states spliced out. */
  store: TrajectoryStore | null
  /** The dataset as it was ingested. Never mutated; every splice starts here. */
  baseStore: TrajectoryStore | null
  /**
   * Patients that still have a trajectory — the cohort as anyone would count it.
   *
   * `store.patientCount` is the number of *rows*, which a splice deliberately
   * holds constant so patient indices stay valid. Removing a state can empty a
   * patient without removing their row, so that number keeps counting people who
   * are no longer in the study. This one does not, and it is what the UI reports.
   */
  cohortSize: number
  states: readonly StateSummaryPayload[]
  /**
   * Vertical ordering of *every* state, including removed ones — the list the
   * states panel shows and reorders. Keeping removed states in place here is
   * what lets a state come back to where it was rather than to the end.
   */
  stateOrder: readonly number[]
  /** `stateOrder` minus the removed states: the chart's rows, in order. */
  visibleStates: readonly number[]
  /** As the ingest derived it, for "reset" and for knowing whether to offer it. */
  baseStateOrder: readonly number[]
  /** What the last splice cost, itemised for the HUD. Empty when nothing is removed. */
  reshapeTimings: readonly Timing[]
  typologies: readonly Typology[]
  mapping: MappingCandidate | null
  timings: readonly Timing[]

  selection: Selection | null
  /**
   * The same patients *before* the narrowing filters — the population the
   * selection is read against. The box plot whiskers are the gap between the
   * two, which is the original's `filteredLinks` vs `selectedLinks` split.
   */
  population: Selection | null
  /** Bumped together with `selection`; both are rewritten in place. */
  selectionVersion: number
  filters: FilterState
  /** Histograms behind the sliders. Rebuilt whenever the dataset is reshaped. */
  distributions: FilterDistributions | null
  selectedTypologies: readonly string[]

  axis: XAxis
  /**
   * Overrides the chart's x scale, which otherwise spans the whole dataset.
   *
   * Held separately from `axis` rather than folded into it because it is a view
   * state, not a data one: nothing downstream of the scale changes, and clearing
   * it must put the axis back exactly where it was.
   */
  xDomainOverride: readonly [number, number] | null
  rendererKind: RendererKind
  opacity: number
  hoveredPatient: number | null
  selectedPatients: readonly number[]

  clusterStatus: ClusterStatus
  clusterError: string | null
  clusterProgress: { done: number; total: number }
  clusterRun: ClusterRun | null
  /** Bumped whenever streamed results mutate `clusterRun` in place. */
  clusterVersion: number
  clusterPreviews: ReadonlyMap<string, Uint32Array>
  clusterParams: ClusterParams
  selectedClusters: readonly number[]

  colorBy: ColorBy
  chartLayer: ChartLayer
  showMedoids: boolean

  loadFile(file: File): Promise<void>
  loadUrl(url: string): Promise<void>
  setFilters(next: Partial<FilterState>): void
  resetFilter(key: NumericFilter): void
  toggleInverted(key: NumericFilter): void
  toggleTypology(key: string): void
  clearTypologies(): void
  setStateOrder(order: readonly number[]): void
  moveState(state: number, delta: number): void
  toggleRemovedState(state: number): void
  resetStates(): void
  setAxis(axis: XAxis): void
  /** Zooms the x scale onto the extent of the patients currently in view. */
  fitXDomain(): void
  resetXDomain(): void
  setRendererKind(kind: RendererKind): void
  setOpacity(opacity: number): void
  setHoveredPatient(patient: number | null): void
  togglePatient(patient: number): void

  startClustering(params?: ClusterParams): void
  pauseClustering(): void
  resumeClustering(): void
  cancelClustering(): void
  toggleCluster(globalIndex: number): void
  clearClusters(): void
  setColorBy(colorBy: ColorBy): void
  setChartLayer(layer: ChartLayer): void
  setShowMedoids(show: boolean): void

  reset(): void
}

const client = new IngestClient()
const clusterClient = new ClusterClient()

/** How often streamed cluster results are pushed into the store. */
const CLUSTER_FLUSH_MS = 120

/** Probed once at module load; the UI can still override it to compare backends. */
function detectRendererKind(): RendererKind {
  if (typeof document === "undefined") return "canvas2d"
  try {
    return document.createElement("canvas").getContext("webgl2") === null ? "canvas2d" : "webgl2"
  } catch {
    return "canvas2d"
  }
}

const initial = {
  status: "idle" as LoadStatus,
  error: null,
  fileName: null,
  store: null,
  baseStore: null,
  cohortSize: 0,
  states: [],
  stateOrder: [],
  visibleStates: [],
  baseStateOrder: [],
  reshapeTimings: [],
  typologies: [],
  mapping: null,
  timings: [],
  selection: null,
  population: null,
  selectionVersion: 0,
  filters: emptyFilters,
  distributions: null,
  selectedTypologies: [],
  axis: "age" as XAxis,
  xDomainOverride: null,
  rendererKind: detectRendererKind(),
  opacity: 0.35,
  hoveredPatient: null,
  selectedPatients: [],

  clusterStatus: "idle" as ClusterStatus,
  clusterError: null,
  clusterProgress: { done: 0, total: 0 },
  clusterRun: null,
  clusterVersion: 0,
  clusterPreviews: new Map<string, Uint32Array>(),
  clusterParams: CLUSTER_DEFAULTS,
  selectedClusters: [],

  colorBy: "state" as ColorBy,
  chartLayer: "lines" as ChartLayer,
  showMedoids: true,
}

export const useEras = create<ErasState>()((set, get) => {
  /**
   * Recomputes the mask in place and bumps the version. Never allocates a new
   * Selection, so this is safe to call from a pointer-move handler.
   */
  const recompute = (): void => {
    const { store, selection, population, filters, selectedTypologies, typologies } = get()
    if (store === null || selection === null || population === null) return

    /*
     * Two scans, not one. `population` stops at the filters that describe *who
     * is in the study* — age, calendar span, disease duration — while
     * `selection` goes on to apply the narrowing ones: the per-segment duration
     * filter and any chosen typologies. The box plots need both, because their
     * whiskers show exactly what the narrowing left out. A second linear pass
     * over a byte-per-patient mask is a rounding error next to rebuilding the
     * geometry that follows it.
     */
    applyFilters(store, { ...filters, duration: null }, population)
    applyFilters(store, filters, selection)

    if (selectedTypologies.length > 0) {
      const chosen = typologies.filter((t) => selectedTypologies.includes(t.key))
      intersectTypologies(
        selection,
        chosen.map((t) => t.patients),
      )
    }

    set({ selectionVersion: get().selectionVersion + 1 })
  }

  /**
   * Re-derives the dataset and everything downstream of it.
   *
   * Removing a state is not a filter. As in the original, it edits the source:
   * the state is spliced out of every trajectory and then typologies,
   * populations, the row ordering's inputs and every axis extent are rebuilt
   * over what is left. Two patients whose paths differed only by the removed
   * state become the *same* typology; a filter could never do that.
   *
   * The cost is the ingest's aggregate passes, not the ingest — no parse, no
   * store construction from records, just a linear copy and the two summaries.
   * It runs on the main thread because a state toggle is a deliberate, occasional
   * click rather than a drag, and the HUD reports what it cost.
   *
   * `stateOrder` is *not* rederived from the new summaries: it is the user's
   * ordering, and rebuilding it here would yank the rows around on every
   * removal. The original had exactly that bug.
   */
  const syncStates = (nextOrder?: readonly number[], nextRemoved?: readonly number[]): void => {
    const { baseStore, stateOrder, filters, selectedTypologies } = get()
    if (baseStore === null) return

    const order = nextOrder ?? stateOrder
    const removedStates = nextRemoved ?? filters.removedStates
    const removedSet = new Set(removedStates)

    const clock = new Stopwatch()

    let store = baseStore
    let states = get().states
    let typologies = get().typologies

    if (removedStates.length > 0) {
      const mask = new Uint8Array(baseStore.stateNames.length)
      for (const state of removedStates) {
        if (state >= 0 && state < mask.length) mask[state] = 1
      }
      store = clock.measure("splice states", () => spliceStates(baseStore, mask))
    }

    // Recomputed either way: restoring a state has to undo the last splice's
    // aggregates just as removing one replaced them.
    const distributions = clock.measure("filter histograms", () => buildDistributions(store))
    const cohortSize = countLivePatients(store)
    const summaries = clock.measure("summarise states", () => summariseStates(store))
    states = summaries.map((summary) => ({
      id: Number(summary.id),
      name: summary.name,
      population: summary.population,
      frequencies: summary.frequencies,
    }))
    typologies = clock.measure("group typologies", () => buildTypologies(store))

    const keys = new Set(typologies.map((typology) => typology.key))

    set({
      store,
      cohortSize,
      states,
      typologies,
      distributions,
      // A splice merges typologies, so a selected key can simply cease to exist.
      selectedTypologies: selectedTypologies.filter((key) => keys.has(key)),
      stateOrder: order,
      visibleStates: order.filter((state) => !removedSet.has(state)),
      reshapeTimings: removedStates.length > 0 ? clock.timings : [],
      filters: { ...filters, removedStates },
      // Hover and picking address the old geometry; both are rebuilt from here.
      hoveredPatient: null,
      // A splice moves the extents, so a fitted axis no longer fits anything.
      xDomainOverride: null,
    })

    recompute()
  }

  const receive = (
    fileName: string,
    result: Awaited<ReturnType<IngestClient["ingest"]>>,
  ): void => {
    const store = fromPayload(result.store)
    const selection = new Selection(store.patientCount)
    const population = new Selection(store.patientCount)

    set({
      status: "ready",
      error: null,
      fileName,
      store,
      baseStore: store,
      // `buildStore` drops empty trajectories, so at ingest every row is live.
      cohortSize: store.patientCount,
      distributions: buildDistributions(store),
      states: result.states,
      stateOrder: result.stateOrder,
      visibleStates: result.stateOrder,
      baseStateOrder: result.stateOrder,
      typologies: result.typologies,
      mapping: result.mapping,
      timings: result.timings,
      reshapeTimings: [],
      selection,
      population,
      selectionVersion: get().selectionVersion + 1,
      // A new file is the global reset signal, as it was in the original.
      filters: emptyFilters,
      selectedTypologies: [],
      selectedPatients: [],
      hoveredPatient: null,
      xDomainOverride: null,

      clusterRun: null,
      clusterPreviews: new Map(),
      clusterProgress: { done: 0, total: 0 },
      clusterError: null,
      selectedClusters: [],
      // The medoid layer has nothing to draw until the new run produces one,
      // and an empty chart reads as a bug rather than as "still working".
      chartLayer: get().chartLayer === "medoids" ? "lines" : get().chartLayer,
    })

    // Clustering ran once here, over the whole dataset. It is parked behind
    // `CLUSTERING_ENABLED`; `startClustering` is a no-op while that is off, so a
    // load now settles straight into the chart.
    get().startClustering()
  }

  const fail = (error: unknown): void => {
    set({ status: "error", error: error instanceof Error ? error.message : String(error) })
  }

  return {
    ...initial,

    async loadFile(file) {
      set({ status: "loading", error: null, fileName: file.name })
      try {
        receive(file.name, await client.ingest(await file.text(), file.name))
      } catch (error) {
        fail(error)
      }
    },

    async loadUrl(url) {
      const fileName = url.split("/").pop() ?? url
      set({ status: "loading", error: null, fileName })
      try {
        const response = await fetch(url)
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
        receive(fileName, await client.ingest(await response.text(), fileName))
      } catch (error) {
        fail(error)
      }
    },

    setFilters(next) {
      set({ filters: { ...get().filters, ...next } })
      recompute()
    },

    /** Drops one range *and* its inversion — a reset is back to "not filtering". */
    resetFilter(key) {
      const filters = get().filters
      set({
        filters: { ...filters, [key]: null, inverted: { ...filters.inverted, [key]: false } },
      })
      recompute()
    },

    toggleInverted(key) {
      const filters = get().filters
      set({
        filters: {
          ...filters,
          inverted: { ...filters.inverted, [key]: filters.inverted[key] !== true },
        },
      })
      recompute()
    },

    toggleTypology(key) {
      const current = get().selectedTypologies
      set({
        selectedTypologies: current.includes(key)
          ? current.filter((k) => k !== key)
          : [...current, key],
      })
      recompute()
    },

    clearTypologies() {
      set({ selectedTypologies: [] })
      recompute()
    },

    setStateOrder(order) {
      syncStates(order)
    },

    /**
     * Nudges one state up or down the list — the keyboard-reachable equivalent
     * of dragging it, and what the original's state labels offered as arrows.
     */
    moveState(state, delta) {
      const order = get().stateOrder.slice()
      const from = order.indexOf(state)
      if (from === -1) return

      const to = Math.max(0, Math.min(order.length - 1, from + delta))
      if (to === from) return

      order.splice(from, 1)
      order.splice(to, 0, state)
      syncStates(order)
    },

    toggleRemovedState(state) {
      const current = get().filters.removedStates
      syncStates(
        undefined,
        current.includes(state) ? current.filter((s) => s !== state) : [...current, state],
      )
    },

    resetStates() {
      syncStates(get().baseStateOrder, [])
    },

    setAxis(axis) {
      // An override is in the old axis' units — ages on a calendar scale would
      // put the whole dataset off screen — so switching axes drops it.
      set({ axis, xDomainOverride: null })
    },

    fitXDomain() {
      const { store, selection, axis } = get()
      if (store === null || selection === null) return

      const extent = visibleExtent(store, selection.indices(), axis)
      if (extent !== null) set({ xDomainOverride: extent })
    },

    resetXDomain() {
      set({ xDomainOverride: null })
    },
    setRendererKind(rendererKind) {
      set({ rendererKind })
    },
    setOpacity(opacity) {
      set({ opacity })
    },
    setHoveredPatient(hoveredPatient) {
      set({ hoveredPatient })
    },

    togglePatient(patient) {
      const current = get().selectedPatients
      set({
        selectedPatients: current.includes(patient)
          ? current.filter((p) => p !== patient)
          : [...current, patient],
      })
    },

    startClustering(params) {
      if (!CLUSTERING_ENABLED) return

      const { store, typologies, clusterParams } = get()
      if (store === null || typologies.length === 0) return

      const effective = params ?? clusterParams
      const matrices = buildDurationMatrices(store, typologies)

      if (matrices.length === 0) {
        set({ clusterStatus: "done", clusterProgress: { done: 0, total: 0 } })
        return
      }

      const builder = new ClusterRunBuilder(store.patientCount, effective)

      /**
       * Results stream one typology at a time, and a real dataset has thousands
       * of them. Pushing each one straight into the store would mean thousands
       * of React updates and thousands of re-sorts of the cluster list, which
       * costs far more than the clustering itself. Updates are coalesced instead:
       * the run still streams, the UI just samples it.
       */
      let flushHandle: ReturnType<typeof setTimeout> | null = null
      let pendingProgress = { done: 0, total: matrices.length }

      const flush = (): void => {
        if (flushHandle !== null) {
          clearTimeout(flushHandle)
          flushHandle = null
        }
        set({
          clusterRun: builder.snapshot(),
          clusterVersion: get().clusterVersion + 1,
          clusterProgress: pendingProgress,
        })
      }

      const scheduleFlush = (): void => {
        if (flushHandle !== null) return
        flushHandle = setTimeout(flush, CLUSTER_FLUSH_MS)
      }

      set({
        clusterParams: effective,
        clusterStatus: "running",
        clusterError: null,
        clusterProgress: { done: 0, total: matrices.length },
        clusterRun: builder.snapshot(),
        clusterPreviews: new Map(),
        selectedClusters: [],
      })

      clusterClient.run(matrices, effective, {
        onPreview(typologyKey, medoidPatients) {
          const previews = new Map(get().clusterPreviews)
          previews.set(typologyKey, medoidPatients)
          set({ clusterPreviews: previews })
        },
        onResult(result, index, total) {
          builder.add(result)
          pendingProgress = { done: index + 1, total }

          const previews = get().clusterPreviews
          if (previews.has(result.typologyKey)) {
            const next = new Map(previews)
            next.delete(result.typologyKey) // the final result supersedes it
            set({ clusterPreviews: next })
          }

          scheduleFlush()
        },
        onDone() {
          flush() // never leave the last typologies sitting in the buffer
          set({ clusterStatus: "done" })
        },
        onError(message) {
          flush()
          set({ clusterStatus: "error", clusterError: message })
        },
      })
    },

    pauseClustering() {
      clusterClient.pause()
      set({ clusterStatus: get().clusterStatus === "running" ? "paused" : get().clusterStatus })
    },

    resumeClustering() {
      clusterClient.resume()
      set({ clusterStatus: get().clusterStatus === "paused" ? "running" : get().clusterStatus })
    },

    cancelClustering() {
      clusterClient.cancel()
      set({ clusterStatus: "idle" })
    },

    toggleCluster(globalIndex) {
      const current = get().selectedClusters
      set({
        selectedClusters: current.includes(globalIndex)
          ? current.filter((c) => c !== globalIndex)
          : [...current, globalIndex],
      })
    },

    clearClusters() {
      set({ selectedClusters: [] })
    },

    setColorBy(colorBy) {
      set({ colorBy })
    },
    setChartLayer(chartLayer) {
      // Medoids need a run behind them. Nothing else in the app can put the
      // chart into a layer whose data has gone, so the guard lives here rather
      // than as a fallback in the render path.
      if (chartLayer === "medoids" && (!CLUSTERING_ENABLED || get().clusterRun === null)) return
      set({ chartLayer })
    },
    setShowMedoids(showMedoids) {
      set({ showMedoids })
    },

    reset() {
      clusterClient.cancel()
      set({ ...initial, rendererKind: get().rendererKind })
    },
  }
})
