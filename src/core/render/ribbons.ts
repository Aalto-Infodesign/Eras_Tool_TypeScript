import type { TrajectoryStore } from "../types.ts"
import { strideIndices } from "../util/sample.ts"
import type { XAxis } from "./geometry.ts"

/**
 * Aggregated ribbons — the alternate reading of the chart.
 *
 * Where the individuals layer shows every trajectory as a hairline, a ribbon
 * collapses a whole group of patients into one shape: it follows the group's
 * median arrival time at each state, and its half-width encodes how many
 * patients it carries. A dozen ribbons replace a hundred thousand lines without
 * hiding where the population actually sits.
 *
 * A *group* is any set of patients that walk the same ordered states — which is
 * exactly what a typology is, so the chart gets its aggregate reading straight
 * from the dataset with no model in between. The builder takes the group rather
 * than deriving it, so a different grouping (clusters, a manual selection) plugs
 * in without touching this file.
 *
 * Coordinates come out in **data space** (`x` = age or year, `y` = state row),
 * so the SVG overlay applies the same transform as the canvas and the two layers
 * stay registered.
 */
export interface RibbonGroup {
  /** Stable identity: selection key and colour index. */
  readonly index: number
  /** Shown in the tooltip. */
  readonly label: string
  /** Members, as global patient indices. */
  readonly patients: Uint32Array
}

export interface Ribbon {
  readonly index: number
  readonly label: string
  /** Members actually drawn, i.e. after the current filter. */
  readonly size: number
  /** Median arrival x at each trajectory position. */
  readonly x: Float32Array
  /** State row of each trajectory position. */
  readonly row: Float32Array
  /** Half-thickness in row units, one per position. */
  readonly halfWidth: Float32Array
  /** Interquartile spread of arrival x, for the uncertainty edge. */
  readonly spreadLow: Float32Array
  readonly spreadHigh: Float32Array
}

export interface RibbonOptions {
  readonly axis: XAxis
  /** `rowOf[stateId]` → vertical band index. */
  readonly rowOf: Float32Array
  /** Largest group in view; ribbons are scaled relative to it. */
  readonly maxSize: number
  /** Half-thickness of the largest ribbon, in row units. */
  readonly maxHalfWidth: number
  /** Members sampled per position when computing quantiles. */
  readonly sampleLimit: number
  /** Restricts members to the current selection; `null` means all. */
  readonly visible: Uint8Array | null
}

export function buildRibbon(
  store: TrajectoryStore,
  group: RibbonGroup,
  options: RibbonOptions,
): Ribbon | null {
  // Members of this group that survive the current filter.
  const members: number[] = []
  for (let i = 0; i < group.patients.length; i++) {
    const patient = group.patients[i] as number
    if (options.visible !== null && options.visible[patient] !== 1) continue
    members.push(patient)
  }
  if (members.length === 0) return null

  const first = members[0] as number
  const length = (store.offsets[first + 1] as number) - (store.offsets[first] as number)
  if (length === 0) return null

  const xs = options.axis === "age" ? store.ages : store.years
  const sample = strideIndices(members.length, options.sampleLimit)

  const x = new Float32Array(length)
  const row = new Float32Array(length)
  const spreadLow = new Float32Array(length)
  const spreadHigh = new Float32Array(length)
  const halfWidth = new Float32Array(length)

  // Quantiles are per position, so one scratch buffer is reused down the path.
  const values = new Float64Array(sample.length)

  // Thickness is scaled by the square root of size: a group ten times larger
  // reads as clearly bigger without a hundred-fold ribbon that swallows the chart.
  const scale = options.maxSize === 0 ? 0 : Math.sqrt(members.length / options.maxSize)
  const width = options.maxHalfWidth * scale

  for (let k = 0; k < length; k++) {
    for (let i = 0; i < sample.length; i++) {
      const patient = members[sample[i] as number] as number
      values[i] = xs[(store.offsets[patient] as number) + k] as number
    }
    values.sort()

    x[k] = quantile(values, 0.5)
    spreadLow[k] = quantile(values, 0.25)
    spreadHigh[k] = quantile(values, 0.75)

    const state = store.stateIds[(store.offsets[first] as number) + k] as number
    row[k] = options.rowOf[state] as number
    halfWidth[k] = width
  }

  return {
    index: group.index,
    label: group.label,
    size: members.length,
    x,
    row,
    halfWidth,
    spreadLow,
    spreadHigh,
  }
}

/** Ribbons for the largest groups currently in view, biggest first. */
export function buildRibbons(
  store: TrajectoryStore,
  groups: readonly RibbonGroup[],
  limit: number,
  options: Omit<RibbonOptions, "maxSize">,
): Ribbon[] {
  const ranked = groups.slice().sort((a, b) => b.patients.length - a.patients.length)
  const maxSize = ranked[0]?.patients.length ?? 0

  const ribbons: Ribbon[] = []
  for (const group of ranked) {
    if (ribbons.length >= limit) break
    const ribbon = buildRibbon(store, group, { ...options, maxSize })
    if (ribbon !== null) ribbons.push(ribbon)
  }
  return ribbons
}

/** Linear-interpolated quantile over a pre-sorted buffer. */
export function quantile(sorted: Float64Array, q: number): number {
  const n = sorted.length
  if (n === 0) return 0
  if (n === 1) return sorted[0] as number

  const position = (n - 1) * q
  const lower = Math.floor(position)
  const upper = Math.ceil(position)
  const weight = position - lower

  return (sorted[lower] as number) * (1 - weight) + (sorted[upper] as number) * weight
}
