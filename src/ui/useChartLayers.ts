import { useMemo } from "react"

import { useEras } from "../app/store.ts"
import { buildStateStats, type StateStats } from "../core/render/boxplots.ts"
import { buildGeometry, rowLookup, type ColorSource, type Geometry } from "../core/render/geometry.ts"
import { buildPalette, type Palette } from "../core/render/palette.ts"
import { buildLumps, type Lump } from "../core/render/lumps.ts"

export interface ChartLayers {
  /** Every visible patient as a hairline. */
  readonly bulk: Geometry | null
  /** One quad per ordered state pair; the alternative to `bulk`, never both. */
  readonly lumps: readonly Lump[]
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
 * The two layers are alternatives. `bulk` is every visible trajectory as a
 * hairline; `lumps` collapses the same links into one quad per ordered state
 * pair. Only one of them is ever built, so switching modes does not pay for the
 * layer it is leaving behind.
 *
 * Neither needs a model behind it or a run to wait for. (Clustering, which used
 * to supply a grouping for the aggregate layer, is parked — see
 * `app/features.ts`, as is the typology-ribbon builder it fed.)
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

  const { bulk, buildMs } = useMemo(() => {
    if (store === null || stateOrder.length === 0 || chartLayer !== "lines") {
      return { bulk: null, buildMs: 0 }
    }

    const t0 = performance.now()
    const geometry = buildGeometry(store, visiblePatients, geometryOptions)
    return { bulk: geometry, buildMs: performance.now() - t0 }
  }, [store, stateOrder.length, chartLayer, visiblePatients, geometryOptions])

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
    stateStats,
    populationStats,
    rowOf,
    statePalette,
    buildMs,
    xDomain,
  }
}
