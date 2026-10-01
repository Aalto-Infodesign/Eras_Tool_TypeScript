/**
 * Minimal scales. d3-scale is excellent but its band scale allocates a Map and
 * an index array on every reconstruction, and the chart rebuilds scales on
 * every layout change — so these are dependency-free closures instead.
 */

export interface LinearScale {
  (value: number): number
  readonly domain: readonly [number, number]
  readonly range: readonly [number, number]
  invert(pixel: number): number
}

export function scaleLinear(
  domain: readonly [number, number],
  range: readonly [number, number],
): LinearScale {
  const [d0, d1] = domain
  const [r0, r1] = range
  const span = d1 - d0
  const factor = span === 0 ? 0 : (r1 - r0) / span

  const scale = ((value: number) => r0 + (value - d0) * factor) as {
    (value: number): number
    domain: readonly [number, number]
    range: readonly [number, number]
    invert(pixel: number): number
  }

  scale.domain = domain
  scale.range = range
  scale.invert = (pixel: number) => (factor === 0 ? d0 : d0 + (pixel - r0) / factor)

  return scale
}

export interface BandScale {
  readonly step: number
  readonly bandwidth: number
  /** Centre of the band at `index`. */
  center(index: number): number
  /** Band index nearest a pixel position, clamped to the domain. */
  indexAt(pixel: number): number
}

export function scaleBand(count: number, extent: number, padding = 0): BandScale {
  const step = count === 0 ? 0 : extent / count
  const bandwidth = step * (1 - padding)

  return {
    step,
    bandwidth,
    center: (index: number) => index * step + step / 2,
    indexAt: (pixel: number) => {
      if (step === 0) return 0
      const index = Math.floor(pixel / step)
      return index < 0 ? 0 : index >= count ? count - 1 : index
    },
  }
}

/**
 * A round step — 1, 2 or 5 × 10ⁿ — that cuts `span` into about `count` pieces.
 *
 * d3-array's `tickIncrement` rule (the raw step rounded at √50, √10 and √2), so
 * axes step the way every d3 axis in the original did. 0 when there is nothing
 * to cut.
 */
export function niceStep(span: number, count: number): number {
  if (!Number.isFinite(span) || !Number.isFinite(count) || !(span > 0) || !(count > 0)) return 0
  const raw = span / count
  const power = Math.pow(10, Math.floor(Math.log10(raw)))
  const error = raw / power
  const factor =
    error >= Math.sqrt(50) ? 10 : error >= Math.sqrt(10) ? 5 : error >= Math.SQRT2 ? 2 : 1
  return factor * power
}

/*
 * The i-th multiple of a step, without the float drift of `i * 0.1`: a step
 * below one is 10ⁿ / (1, 2 or 5), so its inverse is a whole number and dividing
 * by it lands on the nearest double to the decimal — d3's trick, for the same
 * reason. `indexOf` is the inverse, snapped when it is within rounding of a
 * whole index.
 */
function multiples(step: number): { at(index: number): number; indexOf(value: number): number } {
  const inverse = step < 1 ? Math.round(1 / step) : 0
  return {
    at: (index) => (inverse > 0 ? index / inverse : index * step),
    indexOf: (value) => {
      const raw = inverse > 0 ? value * inverse : value / step
      const whole = Math.round(raw)
      return Math.abs(raw - whole) < 1e-9 ? whole : raw
    },
  }
}

/** Round values inside [lo, hi], about `count` of them — an axis's labels. */
export function niceTicks(lo: number, hi: number, count: number): number[] {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return []
  const a = Math.min(lo, hi)
  const b = Math.max(lo, hi)
  if (a === b) return [a]

  const step = niceStep(b - a, count)
  if (step === 0) return []

  const { at, indexOf } = multiples(step)
  const first = Math.ceil(indexOf(a))
  const last = Math.floor(indexOf(b))
  const out: number[] = []
  for (let i = first; i <= last; i++) out.push(at(i))
  return out
}

export interface NiceBins {
  readonly lo: number
  readonly hi: number
  readonly step: number
  readonly bins: number
}

/**
 * A binning of [lo, hi] into about `target` bins whose edges are round numbers.
 *
 * Thirty bins over an arbitrary extent put edges at 0.1667 and 0.3333, and a
 * readout of "0.17–0.33 y" is a number nobody can use. So the bin width is a
 * `niceStep`, the domain is snapped outward to multiples of it, and the count
 * follows — pass `lo`, `hi` and `bins` to `histogram` and every edge reads as
 * written. A single value (or an empty input, taken as [0, 1]) is widened by a
 * step either side rather than collapsing to nothing.
 */
export function niceBins(lo: number, hi: number, target = 30): NiceBins {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return niceBins(0, 1, target)
  const a = Math.min(lo, hi)
  const b = Math.max(lo, hi)

  const step = niceStep(b > a ? b - a : 1, Math.max(1, target))
  const { at, indexOf } = multiples(step)
  let first = Math.floor(indexOf(a))
  let last = Math.ceil(indexOf(b))
  if (last === first) {
    first -= 1
    last += 1
  }

  return { lo: at(first), hi: at(last), step, bins: last - first }
}
