import { useMemo } from "react"

import { useEras } from "../app/store.ts"
import { medoidPatients } from "../core/cluster/medoids.ts"
import { buildStateStats, type StateStats } from "../core/render/boxplots.ts"
import { buildGeometry, rowLookup, type ColorSource, type Geometry } from "../core/render/geometry.ts"
import { buildPalette, type Palette } from "../core/render/palette.ts"
import { buildLumps, type Lump } from "../core/render/lumps.ts"

/** Shared empty list, so the layers below a disabled mode keep their identity. */
const NO_PATIENTS = new Uint32Array()

export interface ChartLayers {
  /** Every visible patient as a hairline. */
  readonly bulk: Geometry | null
  /** One quad per ordered state pair; the alternative to `bulk`, never both. */
  readonly lumps: readonly Lump[]
  /** How many cluster spines `bulk` holds in medoid mode; `0` otherwise. */
  readonly medoidCount: number
  /** Per-state arrival summary of the selection: the box plot bars. */
  readonly stateStats: readonly StateStats[]
  /** The same before the narrowing filters: the box plot whiskers. */
  readonly populationStats: readonly StateStats[]
  readonly rowOf: Float32Array
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
 * The three layers are alternatives. `bulk` is either every visible trajectory
 * as a hairline or, in medoid mode, one spine per cluster — both are the same
 * buffers from the same builder, so the renderer, the picking and the animation
 * need no branch. `lumps` collapses the same links into one quad per ordered
 * state pair. Only one of them is ever built, so switching modes does not pay
 * for the layer it is leaving behind.
 *
 * Only the medoid layer needs a run behind it, and it is unreachable without one
 * (`setChartLayer` refuses); the other two never wait on clustering.
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
  const chartLayer = useEras((s) => s.chartLayer)
  const clusterRun = useEras((s) => s.clusterRun)
  const clusterVersion = useEras((s) => s.clusterVersion)
  const selectedClusters = useEras((s) => s.selectedClusters)

  const stateCount = store?.stateNames.length ?? 0

  const statePalette = useMemo(() => buildPalette(stateCount), [stateCount])
  const rowOf = useMemo(() => rowLookup(stateCount, stateOrder), [stateCount, stateOrder])

  const xDomain = useMemo<readonly [number, number]>(() => {
    if (xDomainOverride !== null) return xDomainOverride
    if (store === null) return [0, 1]
    return axis === "age" ? store.extents.age : store.extents.year
  }, [store, axis, xDomainOverride])

  const color = useMemo<ColorSource>(
    () => ({ kind: "state", palette: statePalette }),
    [statePalette],
  )

  const geometryOptions = useMemo(
    // Rows are resolved at draw time now, so reordering never rebuilds this.
    () => ({ axis, color, durationRange: filters.duration }),
    [axis, color, filters.duration],
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
    if (chartLayer !== "medoids" || clusterRun === null) return NO_PATIENTS
    return medoidPatients(clusterRun, selectedClusters, selection?.mask ?? null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chartLayer, clusterRun, clusterVersion, selectedClusters, selection, selectionVersion])

  const { bulk, buildMs } = useMemo(() => {
    if (store === null || stateOrder.length === 0) return { bulk: null, buildMs: 0 }

    // One builder, two readings: the difference between the density field and
    // the summary is only *which patients* are handed to it.
    const patients =
      chartLayer === "lines" ? visiblePatients : chartLayer === "medoids" ? medoids : null
    if (patients === null) return { bulk: null, buildMs: 0 }

    const t0 = performance.now()
    const geometry = buildGeometry(store, patients, geometryOptions)
    return { bulk: geometry, buildMs: performance.now() - t0 }
  }, [store, stateOrder.length, chartLayer, visiblePatients, medoids, geometryOptions])

  /**
   * One quad per ordered state pair, over the visible links.
   *
   * Built only in lump mode — it is the alternative to the hairlines, so the two
   * are never derived at the same time.
   */
  const lumps = useMemo<readonly Lump[]>(() => {
    if (store === null || chartLayer !== "lumps") return []
    return buildLumps(store, visiblePatients, { axis, durationRange: filters.duration })
  }, [store, chartLayer, visiblePatients, axis, filters.duration])

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
    lumps,
    medoidCount: medoids.length,
    stateStats,
    populationStats,
    rowOf,
    statePalette,
    buildMs,
    xDomain,
  }
}
