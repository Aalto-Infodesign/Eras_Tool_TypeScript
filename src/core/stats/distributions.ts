import type { TrajectoryStore } from "../types.ts"

/**
 * Histograms behind the filter sliders.
 *
 * Each filter draws the shape of the thing it cuts, on the same x scale as the
 * slider under it, so the handles land on features you can see. Computing that
 * from the store once per dataset is what keeps the drawing free while dragging:
 * the curve never changes, only the mask over it does.
 */
export interface Distribution {
  /** Count per bin, left to right across `domain`. */
  readonly counts: Uint32Array
  /** Largest bin, for the y scale and the axis label. */
  readonly max: number
  readonly domain: readonly [number, number]
  readonly binWidth: number
}

/**
 * Two curves on one axis: where trajectories *start* and where they *end*.
 *
 * The original called this the filter's "double" mode, and it is the right shape
 * for the span filters — age and calendar year keep a patient only when their
 * whole span falls inside the range, so the two handles are really cutting two
 * different populations. One curve per handle shows that.
 */
export interface DistributionPair {
  readonly start: Distribution
  readonly end: Distribution
}

export interface FilterDistributions {
  readonly age: DistributionPair
  readonly year: DistributionPair
  readonly diseaseDuration: Distribution
  readonly duration: Distribution
}

/**
 * Bins across the extent rather than the original's `Math.floor` on the raw
 * value. Integer bins read well on whole years, which is what that data was, but
 * collapse to a single bar as soon as a span is narrower than one unit — which
 * segment durations, in fractional years, routinely are.
 */
const BINS = 64

function emptyDistribution(domain: readonly [number, number]): Distribution {
  return { counts: new Uint32Array(1), max: 0, domain, binWidth: 1 }
}

/** Bins `values` over `domain`; values outside it are clamped into the end bins. */
function histogram(
  values: Float64Array,
  count: number,
  domain: readonly [number, number],
  bins = BINS,
): Distribution {
  const [lo, hi] = domain
  const span = hi - lo

  if (count === 0 || !Number.isFinite(span) || span <= 0) return emptyDistribution(domain)

  const counts = new Uint32Array(bins)
  for (let i = 0; i < count; i++) {
    const value = values[i] as number
    const slot = Math.min(bins - 1, Math.max(0, Math.floor(((value - lo) / span) * bins)))
    counts[slot] = (counts[slot] as number) + 1
  }

  let max = 0
  for (let b = 0; b < bins; b++) {
    const c = counts[b] as number
    if (c > max) max = c
  }

  return { counts, max, domain, binWidth: span / bins }
}

/** First and last value of each patient's run, which is what a span filter cuts. */
function spanOf(
  store: TrajectoryStore,
  column: Float32Array,
  domain: readonly [number, number],
): DistributionPair {
  const starts = new Float64Array(store.patientCount)
  const ends = new Float64Array(store.patientCount)
  let n = 0

  for (let p = 0; p < store.patientCount; p++) {
    const start = store.offsets[p] as number
    const end = store.offsets[p + 1] as number
    if (end === start) continue // spliced empty; see model/reshape.ts

    // The run is not sorted by value, so the span is a scan, not the endpoints.
    let lo = Infinity
    let hi = -Infinity
    for (let e = start; e < end; e++) {
      const value = column[e] as number
      if (value < lo) lo = value
      if (value > hi) hi = value
    }

    starts[n] = lo
    ends[n] = hi
    n += 1
  }

  return { start: histogram(starts, n, domain), end: histogram(ends, n, domain) }
}

export function buildDistributions(store: TrajectoryStore): FilterDistributions {
  const { extents } = store

  // Patient-level: one value each, empty patients excluded.
  const diseaseDurations = new Float64Array(store.patientCount)
  let patients = 0
  for (let p = 0; p < store.patientCount; p++) {
    if ((store.offsets[p + 1] as number) === (store.offsets[p] as number)) continue
    diseaseDurations[patients] = store.diseaseDuration[p] as number
    patients += 1
  }

  // Link-level: every transition, excluding each patient's closing self-link,
  // which carries a zero that is a convention rather than a measurement.
  const durations = new Float64Array(store.eventCount)
  let links = 0
  for (let p = 0; p < store.patientCount; p++) {
    const start = store.offsets[p] as number
    const end = store.offsets[p + 1] as number
    for (let e = start; e < end - 1; e++) {
      durations[links] = store.durations[e] as number
      links += 1
    }
  }

  return {
    age: spanOf(store, store.ages, extents.age),
    year: spanOf(store, store.years, extents.year),
    diseaseDuration: histogram(diseaseDurations, patients, extents.diseaseDuration),
    duration: histogram(durations, links, extents.duration),
  }
}
