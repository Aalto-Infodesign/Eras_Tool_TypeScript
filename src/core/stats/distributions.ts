import { FAILS } from "../query/filters.ts"
import type { TrajectoryStore } from "../types.ts"

/**
 * Histograms behind the filter sliders.
 *
 * Each filter draws the shape of the thing it cuts, on the same x scale as the
 * slider under it, so the handles land on features you can see. The whole
 * dataset's curves are computed once per dataset; a typology selection adds a
 * second set over just its patients (see `failures` on `buildDistributions`).
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

/**
 * A histogram filled one value at a time, so a builder can bin as it scans
 * rather than first copying every value out — at a million patients that copy
 * was most of the cost, and the selection's curves are rebuilt on every commit.
 */
class Bins {
  private readonly counts: Uint32Array
  private readonly lo: number
  private readonly span: number
  private n = 0

  constructor(
    private readonly domain: readonly [number, number],
    private readonly bins = BINS,
  ) {
    this.lo = domain[0]
    this.span = domain[1] - domain[0]
    this.counts = new Uint32Array(bins)
  }

  /** Values outside the domain are clamped into the end bins. */
  add(value: number): void {
    const { bins, counts } = this
    const slot = Math.min(bins - 1, Math.max(0, Math.floor(((value - this.lo) / this.span) * bins)))
    counts[slot] = (counts[slot] as number) + 1
    this.n += 1
  }

  done(): Distribution {
    const { domain, span, bins, counts } = this
    if (this.n === 0 || !Number.isFinite(span) || span <= 0) return emptyDistribution(domain)

    let max = 0
    for (let b = 0; b < bins; b++) {
      const c = counts[b] as number
      if (c > max) max = c
    }

    return { counts, max, domain, binWidth: span / bins }
  }
}

/**
 * Bins `values` over `domain`; values outside it are clamped into the end bins.
 *
 * Exported for the Sankey's distribution, which bins a pinned item's values
 * over a domain from `niceBins` so that bin edges land on round numbers.
 */
export function histogram(
  values: Float64Array,
  count: number,
  domain: readonly [number, number],
  bins = BINS,
): Distribution {
  const out = new Bins(domain, bins)
  for (let i = 0; i < count; i++) out.add(values[i] as number)
  return out.done()
}

/** First and last value of each patient's run, which is what a span filter cuts. */
function spanOf(
  store: TrajectoryStore,
  column: Float32Array,
  domain: readonly [number, number],
  counts: (p: number) => boolean,
): DistributionPair {
  const starts = new Bins(domain)
  const ends = new Bins(domain)

  for (let p = 0; p < store.patientCount; p++) {
    if (!counts(p)) continue
    const start = store.offsets[p] as number
    const end = store.offsets[p + 1] as number

    // The run is not sorted by value, so the span is a scan, not the endpoints.
    let lo = Infinity
    let hi = -Infinity
    for (let e = start; e < end; e++) {
      const value = column[e] as number
      if (value < lo) lo = value
      if (value > hi) hi = value
    }

    starts.add(lo)
    ends.add(hi)
  }

  return { start: starts.done(), end: ends.done() }
}

/**
 * Without `failures`, every live patient, as the sliders draw the whole dataset.
 *
 * With them — one byte per patient, as `filterFailures` writes them, plus any
 * bit the caller adds such as `UNSELECTED` — each filter's curve counts the
 * patients that fail nothing *but that filter*. The usual crossfilter rule: a
 * filter's own range must not shape its own histogram, or everything outside
 * the handles would read as empty, while every other cut has to, or the lit part
 * would include patients the chart is not drawing.
 */
export function buildDistributions(store: TrajectoryStore, failures?: Uint8Array): FilterDistributions {
  const { extents } = store

  const keptBy = (own: number) =>
    failures === undefined
      ? (p: number) => (store.offsets[p + 1] as number) !== (store.offsets[p] as number) // spliced empty; see model/reshape.ts
      : (p: number) => ((failures[p] as number) & ~own) === 0

  // Patient-level: one value each, empty patients excluded.
  const diseaseDurations = new Bins(extents.diseaseDuration)
  const countsDisease = keptBy(FAILS.diseaseDuration)
  for (let p = 0; p < store.patientCount; p++) {
    if (countsDisease(p)) diseaseDurations.add(store.diseaseDuration[p] as number)
  }

  // Link-level: every transition, excluding each patient's closing self-link,
  // which carries a zero that is a convention rather than a measurement.
  const durations = new Bins(extents.duration)
  const countsDuration = keptBy(FAILS.duration)
  for (let p = 0; p < store.patientCount; p++) {
    if (!countsDuration(p)) continue
    const start = store.offsets[p] as number
    const end = store.offsets[p + 1] as number
    for (let e = start; e < end - 1; e++) durations.add(store.durations[e] as number)
  }

  return {
    age: spanOf(store, store.ages, extents.age, keptBy(FAILS.age)),
    year: spanOf(store, store.years, extents.year, keptBy(FAILS.year)),
    diseaseDuration: diseaseDurations.done(),
    duration: durations.done(),
  }
}
