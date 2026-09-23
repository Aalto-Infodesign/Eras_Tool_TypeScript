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
