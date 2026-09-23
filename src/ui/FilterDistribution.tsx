import { useId, useMemo } from "react"

import type { Distribution } from "../core/stats/distributions.ts"

interface Curve {
  readonly distribution: Distribution
  readonly className: string
  readonly label: string
}

interface Props {
  readonly curves: readonly Curve[]
  readonly bounds: readonly [number, number]
  /** Live handle positions, so the mask follows the drag rather than the commit. */
  readonly selection: readonly [number, number]
  readonly width: number
  readonly height: number
  readonly inverted: boolean
  /** Pointer x over the slider below, in the same pixel space. */
  readonly hoverX: number | null
}

/**
 * The shape of what a filter cuts, drawn on the slider's own x scale.
 *
 * Two copies of each curve: a faint one for the whole distribution, and a bright
 * one clipped to the selected range by an SVG mask. So the selection reads as
 * *part of a whole* — you can see what you are excluding and how much of it
 * there is, which a pair of numbers can never show. Inverting swaps the mask, so
 * the lit part is always the part that survives the filter.
 *
 * Deliberately the same width as the slider and stacked directly on it: the
 * handle sits under the feature it is cutting.
 */
export function FilterDistribution({
  curves,
  bounds,
  selection,
  width,
  height,
  inverted,
  hoverX,
}: Props): React.JSX.Element | null {
  const maskId = useId()
  const [lo, hi] = bounds
  const span = Math.max(hi - lo, 1e-9)

  const toPixels = (value: number): number => ((value - lo) / span) * width

  const paths = useMemo(
    () =>
      curves.map((curve) => ({
        ...curve,
        d: stepPath(curve.distribution, width, height),
      })),
    [curves, width, height],
  )

  /** Bin under the cursor, for the readout and the rulers. */
  const probe = useMemo(() => {
    if (hoverX === null) return null

    const primary = curves[0]?.distribution
    if (primary === undefined || primary.max === 0) return null

    const bins = primary.counts.length
    const slot = Math.min(bins - 1, Math.max(0, Math.floor((hoverX / width) * bins)))

    return {
      value: lo + ((slot + 0.5) / bins) * span,
      counts: curves.map((curve) => curve.distribution.counts[slot] ?? 0),
      y: height - ((primary.counts[slot] ?? 0) / primary.max) * height,
    }
  }, [hoverX, curves, width, height, lo, span])

  if (width === 0 || paths.length === 0) return null

  const selectionStart = toPixels(selection[0])
  const selectionEnd = toPixels(selection[1])
  const peak = Math.max(...curves.map((curve) => curve.distribution.max))

  return (
    <svg className="distribution" width={width} height={height}>
      <defs>
        <mask id={maskId}>
          {/* White keeps, black cuts. Inverting is literally the complement. */}
          {inverted && <rect x={0} y={0} width={width} height={height} fill="white" />}
          <rect
            x={selectionStart}
            y={0}
            width={Math.max(selectionEnd - selectionStart, 0)}
            height={height}
            fill={inverted ? "black" : "white"}
          />
        </mask>
      </defs>

      {paths.map((curve) => (
        <path key={curve.className} className={`distribution__ghost ${curve.className}`} d={curve.d} />
      ))}
      {paths.map((curve) => (
        <path
          key={`${curve.className}-lit`}
          className={`distribution__lit ${curve.className}`}
          d={curve.d}
          mask={`url(#${maskId})`}
        />
      ))}

      <line className="distribution__axis" x1={0} y1={height} x2={width} y2={height} />

      {probe !== null && (
        <g className="distribution__probe">
          <line x1={hoverX ?? 0} y1={height} x2={hoverX ?? 0} y2={probe.y} />
          <circle cx={hoverX ?? 0} cy={probe.y} r={2.5} />
        </g>
      )}

      <text className="distribution__peak" x={2} y={9}>
        {probe === null
          ? peak.toLocaleString()
          : `${probe.value.toFixed(1)} · ${probe.counts.map((c) => c.toLocaleString()).join(" / ")}`}
      </text>
    </svg>
  )
}

/**
 * A step outline of the histogram — flat across each bin, vertical between them,
 * which is `curveStep` in the original. A smooth curve would imply data between
 * bins that was never measured.
 */
function stepPath(distribution: Distribution, width: number, height: number): string {
  const { counts, max } = distribution
  if (max === 0 || counts.length === 0) return ""

  const binWidth = width / counts.length
  const parts: string[] = []

  for (let b = 0; b < counts.length; b++) {
    const y = height - ((counts[b] as number) / max) * height
    const x0 = b * binWidth
    parts.push(`${b === 0 ? "M" : "L"}${x0.toFixed(1)},${y.toFixed(1)}`)
    parts.push(`L${(x0 + binWidth).toFixed(1)},${y.toFixed(1)}`)
  }

  return parts.join("")
}
