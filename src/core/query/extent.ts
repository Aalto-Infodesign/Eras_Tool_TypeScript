import type { XAxis } from "../render/geometry.ts"
import type { TrajectoryStore } from "../types.ts"

/**
 * The x extent of the patients currently in view.
 *
 * `store.extents` describes the whole dataset and is what the chart scales to by
 * default, so filtering down to a decade leaves that decade squeezed into a
 * sliver of the axis. This is the extent of what is actually drawn, for zooming
 * the axis onto it.
 *
 * Returns `null` when nothing is in view, so the caller can leave the current
 * scale alone rather than collapse it to a point.
 */
export function visibleExtent(
  store: TrajectoryStore,
  patients: Uint32Array,
  axis: XAxis,
): readonly [number, number] | null {
  const xs = axis === "age" ? store.ages : store.years

  let lo = Infinity
  let hi = -Infinity

  for (let i = 0; i < patients.length; i++) {
    const p = patients[i] as number
    const start = store.offsets[p] as number
    const end = store.offsets[p + 1] as number

    for (let e = start; e < end; e++) {
      const value = xs[e] as number
      if (value < lo) lo = value
      if (value > hi) hi = value
    }
  }

  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null
  // A single point has no span; widen it so the scale stays invertible.
  if (hi === lo) return [lo - 0.5, hi + 0.5]

  return [lo, hi]
}
