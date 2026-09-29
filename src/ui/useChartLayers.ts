import { useMemo } from "react"

import { useEras } from "../app/store.ts"
import { clusterMembers, medoidPatients } from "../core/cluster/medoids.ts"
import { TOP_CLUSTER_LIMIT } from "../core/cluster/types.ts"
import { sequenceLabels } from "../core/stats/silhouettes.ts"
import { buildStateStats, type StateStats } from "../core/render/boxplots.ts"
import {
  buildGeometry,
  rowLookup,
  type ColorSource,
  type Geometry,
  type GeometryOptions,
} from "../core/render/geometry.ts"
import { buildPalette, type Palette } from "../core/render/palette.ts"
import { buildLumps, type Lump } from "../core/render/lumps.ts"

/** Shared empty list, so the layers below a disabled mode keep their identity. */
const NO_PATIENTS = new Uint32Array()

export interface ChartLayers {
  /**
   * The layer the renderer draws first and picks from: the hairlines when they
   * are on, the medoid spines when they are the only line-shaped layer.
   */
  readonly bulk: Geometry | null
  /** Medoid spines when they sit *over* the hairlines; the renderer's own slot. */
  readonly overlay: Geometry | null
  /**
   * Patients the hairline layer is drawing: the whole selection, or — while
   * clusters are isolated — only their members.
   */
  readonly linePatients: Uint32Array
  /** True while the hairlines are scoped to the isolated clusters. */
  readonly isIsolated: boolean
  /**
   * Whether the hairlines are actually being drawn. Not the same as the toggle:
   * the focused view draws them regardless, because seeing the members under
   * the spine is the whole of what it is for.
   */
  readonly linesDrawn: boolean
  /** One quad per ordered state pair; the alternative to `bulk`, never both. */
  readonly lumps: readonly Lump[]
  /** How many cluster spines `bulk` holds in medoid mode; `0` otherwise. */
  readonly medoidCount: number
  /** Per-state arrival summary of the selection: the box plot bars. */
  readonly stateStats: readonly StateStats[]
  /** The same before the narrowing filters: the box plot whiskers. */
  readonly populationStats: readonly StateStats[]
  readonly rowOf: Float32Array
  /**
   * Row → state id. Normally the visible state order; while a typology is
   * focused, that typology's sequence, so a repeated state appears twice.
   */
  readonly rowStates: readonly number[]
  /** Row → label; a repeated state in a focused sequence carries its visit number. */
  readonly rowLabels: readonly string[]
  /** True while rows are steps of one sequence rather than states. */
  readonly byPosition: boolean
  /** The builder inputs, so a second view can derive its own panels from them. */
  readonly geometryOptions: GeometryOptions
  readonly statePalette: Palette
  readonly buildMs: number
  readonly xDomain: readonly [number, number]
}

/**
 * Derives every drawable layer from the store.
 *
 * Both layers are rebuilt only when *what is shown* changes — never on a resize,
 * a pan or a hover, which the shader and the overlay handle on their own.
 *
 * The three layers stack, and each is built only when it is on — switching one
 * off stops paying for it immediately.
 *
 * The hairlines and the medoid spines are the same buffers from the same
 * builder handed different patient lists, so the renderer, the picking and the
 * animation need no branch between them. What differs is only *which slot* they
 * land in: the renderer keeps a separate overlay buffer so the spines can be
 * toggled without touching the megabytes underneath them.
 *
 * Only the medoid layer needs a run behind it, and it is unreachable without one
 * (`toggleLayer` refuses); the other two never wait on clustering.
 */
export function useChartLayers(): ChartLayers {
  const store = useEras((s) => s.store)
  const selection = useEras((s) => s.selection)
  const population = useEras((s) => s.population)
  const selectionVersion = useEras((s) => s.selectionVersion)
  const stateOrder = useEras((s) => s.visibleStates)
  const axis = useEras((s) => s.axis)
  const xDomainOverride = useEras((s) => s.xDomainOverride)
  const filters = useEras((s) => s.filters)
  const layers = useEras((s) => s.layers)
  const focusedKey = useEras((s) => s.focusedTypology)
  const typologies = useEras((s) => s.typologies)
  const clusterRun = useEras((s) => s.clusterRun)
  const clusterVersion = useEras((s) => s.clusterVersion)
  const selectedClusters = useEras((s) => s.selectedClusters)

  const stateCount = store?.stateNames.length ?? 0

  const statePalette = useMemo(() => buildPalette(stateCount), [stateCount])

  const focused = useMemo(
    () => (focusedKey === null ? null : (typologies.find((t) => t.key === focusedKey) ?? null)),
    [typologies, focusedKey],
  )
  const byPosition = focused !== null

  /**
   * The rows, and the lookup that puts geometry on them.
   *
   * Focused, both come from the typology's own sequence: row `i` *is* step `i`,
   * so the lookup is the identity and `positions.y` carries the step. That is
   * the whole trick — nothing else in the pipeline has to know, because every
   * layer already resolves a row through this one array.
   */
  const rowStates = useMemo<readonly number[]>(
    () => (focused === null ? stateOrder : Array.from(focused.states)),
    [focused, stateOrder],
  )

  const rowLabels = useMemo<readonly string[]>(() => {
    if (store === null) return []
    if (focused === null) return stateOrder.map((state) => store.stateNames[state] ?? String(state))
    return sequenceLabels(focused.states, store.stateNames)
  }, [store, focused, stateOrder])

  const rowOf = useMemo(() => {
    if (focused === null) return rowLookup(stateCount, stateOrder)
    const identity = new Float32Array(focused.states.length)
    for (let i = 0; i < identity.length; i++) identity[i] = i
    return identity
  }, [focused, stateCount, stateOrder])

  const xDomain = useMemo<readonly [number, number]>(() => {
    if (xDomainOverride !== null) return xDomainOverride
    if (store === null) return [0, 1]
    return axis === "age" ? store.extents.age : store.extents.year
  }, [store, axis, xDomainOverride])

  const color = useMemo<ColorSource>(
    () => ({ kind: "state", palette: statePalette }),
    [statePalette],
  )

  const geometryOptions = useMemo<GeometryOptions>(
    // Rows are resolved at draw time now, so reordering never rebuilds this.
    () => ({
      axis,
      color,
      durationRange: filters.duration,
      ...(byPosition ? { rowsFrom: "position" as const } : {}),
    }),
    [axis, color, filters.duration, byPosition],
  )

  const visiblePatients = useMemo<Uint32Array>(
    () => selection?.indices() ?? new Uint32Array(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selection, selectionVersion],
  )

  /**
   * The cluster representatives, in medoid mode.
   *
   * Keyed on `clusterVersion` as well as the run, because results stream in and
   * mutate the run in place — the object identity does not change when the
   * hundredth typology lands, but the ranked top list does.
   */
  const medoids = useMemo<Uint32Array>(() => {
    if (!layers.medoids || clusterRun === null) return NO_PATIENTS
    /*
     * Focused, the spines are that typology's own clusters — which is the
     * natural pairing, since a typology is exactly the unit the clusterer works
     * on. They land on the same per-step ladder as the hairlines, so a spine is
     * a cluster's path through this sequence rather than through the global rows.
     */
    return medoidPatients(
      clusterRun,
      selectedClusters,
      selection?.mask ?? null,
      TOP_CLUSTER_LIMIT,
      focusedKey,
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layers.medoids, clusterRun, clusterVersion, selectedClusters, selection, selectionVersion, focusedKey])

  /*
   * Isolating a cluster narrows the hairlines to its members.
   *
   * This is what makes a medoid readable as a representative rather than as one
   * more line drawn thicker: the spine and the people it stands for are on
   * screen together, and the density under it is that cluster's own. Selecting
   * clusters already scoped the spines; it now scopes what is underneath them
   * too, so the cluster table's selection finally means something in the chart.
   */
  const isIsolated = clusterRun !== null && selectedClusters.length > 0

  const linePatients = useMemo<Uint32Array>(() => {
    if (focused !== null && !isIsolated) {
      // The projection is only meaningful over the sequence it came from.
      const mask = selection?.mask ?? null
      const members: number[] = []
      for (let i = 0; i < focused.patients.length; i++) {
        const patient = focused.patients[i] as number
        if (mask === null || mask[patient] === 1) members.push(patient)
      }
      return Uint32Array.from(members)
    }
    if (!isIsolated || clusterRun === null) return visiblePatients
    return clusterMembers(clusterRun, selectedClusters, selection?.mask ?? null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focused, isIsolated, clusterRun, clusterVersion, selectedClusters, visiblePatients, selection, selectionVersion])

  // One builder, two readings: the difference between the density field and the
  // summary is only *which patients* are handed to it.
  const lineGeometry = useMemo(() => {
    // Focused, the hairlines are the whole reading — the spines and the lumps
    // are grouped by state, which is not what the rows mean here.
    if (store === null || rowStates.length === 0 || !(layers.lines || byPosition)) return null
    const t0 = performance.now()
    return { geometry: buildGeometry(store, linePatients, geometryOptions), ms: performance.now() - t0 }
  }, [store, rowStates.length, layers.lines, byPosition, linePatients, geometryOptions])

  const medoidGeometry = useMemo(() => {
    if (store === null || rowStates.length === 0 || medoids.length === 0) return null
    const t0 = performance.now()
    return { geometry: buildGeometry(store, medoids, geometryOptions), ms: performance.now() - t0 }
  }, [store, rowStates.length, medoids, geometryOptions])

  /*
   * Which slot each one lands in. The spines go on top when the hairlines are
   * there to go on top *of*; alone, they are the bulk — which also makes them
   * the layer hover picks from, since picking reads the bulk buffer.
   */
  const bulk = (lineGeometry ?? medoidGeometry)?.geometry ?? null
  const overlay = lineGeometry === null ? null : (medoidGeometry?.geometry ?? null)
  const buildMs = (lineGeometry?.ms ?? 0) + (medoidGeometry?.ms ?? 0)

  /**
   * One quad per ordered state pair, over the visible links.
   *
   * Built only in lump mode — it is the alternative to the hairlines, so the two
   * are never derived at the same time.
   */
  const lumps = useMemo<readonly Lump[]>(() => {
    if (store === null || byPosition || !layers.lumps) return []
    return buildLumps(store, visiblePatients, { axis, durationRange: filters.duration })
  }, [store, byPosition, layers.lumps, visiblePatients, axis, filters.duration])

  /**
   * Box plot stats. Both sides are one scan plus a sort per state, and they are
   * keyed on the selection version rather than on the compacted index list, so a
   * filter drag recomputes them once per change and not once per frame.
   */
  const stateStats = useMemo(() => {
    if (store === null) return []
    return buildStateStats(store, selection?.mask ?? null, axis)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, selection, selectionVersion, axis])

  const populationStats = useMemo(() => {
    if (store === null) return []
    return buildStateStats(store, population?.mask ?? null, axis)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, population, selectionVersion, axis])

  return {
    bulk,
    overlay,
    linePatients,
    isIsolated,
    lumps,
    medoidCount: medoids.length,
    stateStats,
    populationStats,
    rowOf,
    rowStates,
    rowLabels,
    byPosition,
    linesDrawn: lineGeometry !== null,
    geometryOptions,
    statePalette,
    buildMs,
    xDomain,
  }
}
