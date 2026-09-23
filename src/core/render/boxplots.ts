import type { TrajectoryStore } from "../types.ts"
import type { XAxis } from "./geometry.ts"

/**
 * Per-state five-number summaries of arrival time — the original's box plot row.
 *
 * One datum per state, over *every visit* to that state by a visible patient.
 * A patient who passes through `b` twice contributes twice, and a patient's last
 * event counts like any other, which is what the original did by grouping its
 * links on `source.state` (every trajectory index produces exactly one link,
 * including the last, whose target is a self-loop).
 *
 * This is the aggregate the chart was missing: unlike ribbons it needs no
 * grouping and no model, just a pass over the events.
 */
export interface StateStats {
  /** Interned state id. */
  readonly state: number
  /** Visits counted, i.e. events not patients. */
  readonly count: number
  readonly min: number
  readonly q1: number
  readonly median: number
  readonly q3: number
  readonly max: number
}

/**
 * Quantile resolution, as buckets across the axis' full extent.
 *
 * The obvious implementation collects each state's arrival times and sorts them,
 * but that is ~75ms for a 250k dataset — and this runs twice per filter change,
 * once for the selection and once for the population behind it, which puts it
 * squarely in the way of a slider drag. Sampling instead of sorting was worse: a
 * stride sample follows the data's own order, and when that order correlates
 * with age (patients loaded oldest-first, say) every quantile comes out biased
 * by half a stride rather than merely noisy.
 *
 * A histogram has neither problem. It is one counting pass with no sort and no
 * buffer proportional to the event count, and its error is bounded by the bucket
 * width rather than by the data's arrangement. At this resolution a bucket is
 * ~1/8000th of the axis — comfortably under a pixel on any real chart.
 */
const BUCKETS = 8192

export function buildStateStats(
  store: TrajectoryStore,
  visible: Uint8Array | null,
  axis: XAxis,
  buckets: number = BUCKETS,
): StateStats[] {
  const stateCount = store.stateNames.length
  if (stateCount === 0) return []

  const xs = axis === "age" ? store.ages : store.years
  const [lo, hi] = axis === "age" ? store.extents.age : store.extents.year
  const span = Math.max(hi - lo, 1e-9)

  const { stateIds, eventPatient, eventCount } = store

  const histogram = new Uint32Array(stateCount * buckets)
  const counts = new Uint32Array(stateCount)
  const mins = new Float64Array(stateCount).fill(Infinity)
  const maxes = new Float64Array(stateCount).fill(-Infinity)

  for (let e = 0; e < eventCount; e++) {
    if (visible !== null && visible[eventPatient[e] as number] !== 1) continue

    const state = stateIds[e] as number
    const x = xs[e] as number

    // Extremes are tracked exactly: they are drawn as the glyph's span, and a
    // bucketed extreme would visibly shorten the bar.
    if (x < (mins[state] as number)) mins[state] = x
    if (x > (maxes[state] as number)) maxes[state] = x

    const slot = Math.min(buckets - 1, Math.max(0, Math.floor(((x - lo) / span) * buckets)))
    const at = state * buckets + slot
    histogram[at] = (histogram[at] as number) + 1
    counts[state] = (counts[state] as number) + 1
  }

  const stats: StateStats[] = []
  for (let s = 0; s < stateCount; s++) {
    const count = counts[s] as number
    if (count === 0) continue

    const min = mins[s] as number
    const max = maxes[s] as number
    const base = s * buckets

    // Clamped to the true extent so a bucket centre can never fall outside the
    // bar it is drawn inside.
    const at = (q: number): number =>
      Math.min(max, Math.max(min, quantileFromHistogram(histogram, base, buckets, count, q, lo, span)))

    stats.push({
      state: s,
      count,
      min,
      q1: at(0.25),
      median: at(0.5),
      q3: at(0.75),
      max,
    })
  }

  return stats
}

/**
 * Value at quantile `q`, interpolated between the buckets holding the two ranks
 * that straddle it.
 *
 * `q` addresses position `(count - 1) * q` in the sorted run, and the two
 * neighbouring ranks are blended by the fractional part — the same convention as
 * the ribbons' `quantile`, so the two layers never disagree about where a median
 * is. Taking the nearest rank instead would be cheaper and is a perfectly
 * standard definition, but it reports the median of two visits as the earlier of
 * them, which is not what the tick over a bar between them should mean.
 *
 * Both ranks are found in one walk, since they are adjacent.
 */
function quantileFromHistogram(
  histogram: Uint32Array,
  base: number,
  buckets: number,
  count: number,
  q: number,
  lo: number,
  span: number,
): number {
  const centre = (bucket: number): number => lo + ((bucket + 0.5) / buckets) * span

  const target = (count - 1) * q
  const lowerRank = Math.floor(target)
  const fraction = target - lowerRank
  const upperRank = Math.min(lowerRank + 1, count - 1)

  let cumulative = 0
  let lower: number | null = null

  for (let b = 0; b < buckets; b++) {
    cumulative += histogram[base + b] as number
    if (cumulative <= lowerRank) continue

    if (lower === null) {
      lower = centre(b)
      if (fraction === 0) return lower
    }
    if (cumulative > upperRank) return lower + fraction * (centre(b) - lower)
  }

  return lower ?? lo + span
}
