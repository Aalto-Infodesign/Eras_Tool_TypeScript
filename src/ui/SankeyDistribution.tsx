import { useId, useMemo, useState } from "react"

import type { Range } from "../core/query/filters.ts"
import { niceBins, niceStep, niceTicks, type NiceBins } from "../core/render/scales.ts"
import { histogram } from "../core/stats/distributions.ts"
import { useElementSize } from "./useRenderer.ts"

/**
 * Which curve is which, by what it is *for* rather than which slot it fills —
 * the same roles, in the same colours, as the outlines on the Sankey: pinned is
 * `--text`, hovered and compared are `--accent`.
 */
export type CurveRole = "pinned" | "hovered" | "compare"

export interface SankeyCurve {
  readonly values: Float64Array
  readonly role: CurveRole
  /** The exact median, from the stats row beside the chart, so tick and number agree. */
  readonly median: number
}

interface Props {
  readonly primary: SankeyCurve | null
  readonly secondary: SankeyCurve | null
  /** The same metric over everyone at the primary item's step: what "slow" is slow against. */
  readonly ghost: Float64Array | null
  readonly ghostLabel: string
  /** What an x value is, for this item and metric — "years from a to b". */
  readonly caption: string
  /** "y" for durations and ages; calendar years carry none. */
  readonly unit: string
  /** The duration filter's range, shaded when the metric is the one it filters. */
  readonly band: { readonly range: Range; readonly inverted: boolean } | null
  /**
   * While a pin is held: its key and metric. The x domain is then fixed to the
   * pinned curve and only ever widened — so hovering another flow for a
   * comparison never rescales the one being read. `null` lets it follow.
   */
  readonly lockKey: string | null
}

const MARGIN_TOP = 16
const MARGIN_RIGHT = 10
const MARGIN_BOTTOM = 30
const MARGIN_LEFT = 36
/**
 * About this many bins across the domain — edges on round numbers by
 * `niceBins`, so a readout says "2.0–2.5 y" rather than "0.1667–0.3333".
 */
const TARGET_BINS = 30
/** One x tick per this many pixels, roughly. */
const TICK_SPACING_PX = 72
const MEDIAN_TICK_PX = 6
/**
 * The ghost's median is read off a fine histogram of its own extent rather
 * than sorted for: it can hold every patient at a step — a quarter of a million
 * values, re-read on every filter frame — and a tick needs a pixel, not a
 * digit.
 */
const GHOST_MEDIAN_BINS = 1024
/** Below this many patients a curve is a handful of spikes, not a shape — it does not set the scale. */
const MIN_SHAPED = 20

interface Extent {
  readonly lo: number
  readonly hi: number
}

interface Held extends Extent {
  readonly key: string
}

interface Binned {
  readonly counts: Uint32Array
  /** Everyone the curve describes, in range or not: shares are of the whole. */
  readonly total: number
}

function extentOf(...columns: (Float64Array | null)[]): Extent | null {
  let lo = Infinity
  let hi = -Infinity
  for (const values of columns) {
    if (values === null) continue
    for (let i = 0; i < values.length; i++) {
      const v = values[i] as number
      if (v < lo) lo = v
      if (v > hi) hi = v
    }
  }
  return lo <= hi ? { lo, hi } : null
}

function binAll(values: Float64Array, bins: NiceBins): Binned {
  const { counts } = histogram(values, values.length, [bins.lo, bins.hi], bins.bins)
  return { counts, total: values.length }
}

/**
 * The ghost is binned over the *curves'* domain, and `histogram` clamps
 * anything outside into the end bins — which would draw a spike of everyone
 * beyond the edge where the domain happens to stop. Those are dropped instead;
 * the share stays a share of everyone.
 */
function binInside(values: Float64Array, bins: NiceBins): Binned {
  const inside = new Float64Array(values.length)
  let n = 0
  for (let i = 0; i < values.length; i++) {
    const v = values[i] as number
    if (v >= bins.lo && v <= bins.hi) inside[n++] = v
  }
  const { counts } = histogram(inside, n, [bins.lo, bins.hi], bins.bins)
  return { counts, total: values.length }
}

function approxMedian(values: Float64Array): number {
  const extent = extentOf(values)
  if (extent === null) return NaN
  if (extent.hi === extent.lo) return extent.lo
  const { counts } = histogram(values, values.length, [extent.lo, extent.hi], GHOST_MEDIAN_BINS)
  const half = values.length / 2
  const width = (extent.hi - extent.lo) / GHOST_MEDIAN_BINS
  let seen = 0
  for (let b = 0; b < counts.length; b++) {
    const c = counts[b] as number
    if (seen + c >= half) return extent.lo + (b + (c === 0 ? 0 : (half - seen) / c)) * width
    seen += c
  }
  return extent.hi
}

/** Enough decimals to tell two multiples of `step` apart. */
function decimalsOf(step: number): number {
  if (!(step > 0) || step >= 1) return 0
  return Math.ceil(-Math.log10(step) - 1e-9)
}

/**
 * Where the patients through a Sankey item sit on one metric, against everyone
 * at the same step.
 *
 * The original's `DurationDistributionChart` drew a Catmull-Rom polygon through
 * bin midpoints: it overshot below zero, never closed to the baseline, printed
 * "0–0" for sub-year bins and collapsed on a single value. This is a step
 * histogram closed to the baseline — flat across a bin, because nothing between
 * two edges was measured — with round bin edges, y as each curve's *share* of
 * its own patients (so a flow of forty and a step of forty thousand compare
 * directly), and an empty frame rather than a broken one when there is nothing
 * to bin.
 */
export function SankeyDistribution({
  primary,
  secondary,
  ghost,
  ghostLabel,
  caption,
  unit,
  band,
  lockKey,
}: Props): React.JSX.Element {
  const [host, setHost] = useState<HTMLDivElement | null>(null)
  const size = useElementSize(host)
  const clipId = `${useId().replace(/[^A-Za-z0-9_-]/g, "")}-plot`
  const [probeX, setProbeX] = useState<number | null>(null)

  const natural = useMemo(
    () => extentOf(primary?.values ?? null, secondary?.values ?? null),
    [primary, secondary],
  )

  /*
   * The held domain, adjusted during render rather than in an effect: an effect
   * would paint one frame at the unheld domain first, which is exactly the
   * rescale the hold exists to prevent. Guarded, so it settles in one pass.
   */
  const [held, setHeld] = useState<Held | null>(null)
  let domain: Extent | null = natural
  if (lockKey === null) {
    if (held !== null) setHeld(null)
  } else {
    const kept = held !== null && held.key === lockKey ? held : null
    if (natural !== null) {
      const lo = kept === null ? natural.lo : Math.min(kept.lo, natural.lo)
      const hi = kept === null ? natural.hi : Math.max(kept.hi, natural.hi)
      if (kept === null || kept.lo !== lo || kept.hi !== hi) setHeld({ key: lockKey, lo, hi })
      domain = { lo, hi }
    } else if (kept !== null) {
      // The pinned item went dormant under a filter: keep its frame.
      domain = kept
    }
  }

  const lo = domain?.lo ?? NaN
  const hi = domain?.hi ?? NaN
  const bins = useMemo(
    () => (Number.isNaN(lo) || Number.isNaN(hi) ? null : niceBins(lo, hi, TARGET_BINS)),
    [lo, hi],
  )

  const binned = useMemo(() => {
    if (bins === null) return null
    return {
      primary: primary !== null && primary.values.length > 0 ? binAll(primary.values, bins) : null,
      secondary:
        secondary !== null && secondary.values.length > 0 ? binAll(secondary.values, bins) : null,
      ghost: ghost !== null && ghost.length > 0 ? binInside(ghost, bins) : null,
    }
  }, [bins, primary, secondary, ghost])

  const ghostMedian = useMemo(() => (ghost === null ? NaN : approxMedian(ghost)), [ghost])

  const width = size.width
  const height = size.height
  const plotWidth = Math.max(0, width - MARGIN_LEFT - MARGIN_RIGHT)
  const plotHeight = Math.max(0, height - MARGIN_TOP - MARGIN_BOTTOM)
  const base = MARGIN_TOP + plotHeight

  if (width === 0 || height === 0) {
    return <div ref={setHost} className="sankey__dist" />
  }

  const frame = (
    <>
      <line
        className="sankey__dist-axis"
        x1={MARGIN_LEFT}
        x2={MARGIN_LEFT + plotWidth}
        y1={base}
        y2={base}
      />
      <text className="sankey__dist-caption" x={MARGIN_LEFT} y={height - 3}>
        {caption}
      </text>
    </>
  )

  if (bins === null || binned === null) {
    return (
      <div ref={setHost} className="sankey__dist">
        <svg width={width} height={height} aria-hidden="true">
          {frame}
        </svg>
      </div>
    )
  }

  const span = bins.hi - bins.lo
  const x = (value: number): number => MARGIN_LEFT + ((value - bins.lo) / span) * plotWidth
  const right = MARGIN_LEFT + plotWidth
  const clampX = (px: number): number => Math.min(right, Math.max(MARGIN_LEFT, px))

  /*
   * The scale belongs to what is being read — the primary curve and the step
   * behind it. A comparison joins it only once it has enough patients to have a
   * shape: two patients are two bins at 50% each, and letting them set the
   * scale flattened a thousand-patient pinned curve into the baseline. A small
   * comparison that overshoots is clipped at the top of the plot instead.
   */
  const scaled = [
    binned.primary,
    binned.ghost,
    binned.secondary !== null && binned.secondary.total >= MIN_SHAPED ? binned.secondary : null,
  ]
  let peak = 0
  for (const curve of scaled) {
    if (curve === null || curve.total === 0) continue
    for (let b = 0; b < curve.counts.length; b++) {
      peak = Math.max(peak, (curve.counts[b] as number) / curve.total)
    }
  }
  if (peak === 0 && binned.secondary !== null && binned.secondary.total > 0) {
    // Nothing else to scale by: the comparison is all there is.
    for (let b = 0; b < binned.secondary.counts.length; b++) {
      peak = Math.max(peak, (binned.secondary.counts[b] as number) / binned.secondary.total)
    }
  }
  const yMax = peak > 0 ? peak : 1
  const y = (share: number): number => base - (share / yMax) * plotHeight

  const pathOf = (curve: Binned): string => {
    const parts = [`M${x(bins.lo).toFixed(1)},${base.toFixed(1)}`]
    for (let b = 0; b < curve.counts.length; b++) {
      const top = y(curve.total === 0 ? 0 : (curve.counts[b] as number) / curve.total).toFixed(1)
      parts.push(`L${x(bins.lo + b * bins.step).toFixed(1)},${top}`)
      parts.push(`L${x(bins.lo + (b + 1) * bins.step).toFixed(1)},${top}`)
    }
    parts.push(`L${x(bins.hi).toFixed(1)},${base.toFixed(1)}Z`)
    return parts.join("")
  }

  const tickCount = Math.max(2, Math.floor(plotWidth / TICK_SPACING_PX))
  const ticks = niceTicks(bins.lo, bins.hi, tickCount)
  const tickDecimals = decimalsOf(niceStep(span, tickCount))
  const shareTicks = niceTicks(0, yMax, 2).filter((share) => share > 0)
  const shareDecimals = decimalsOf(niceStep(yMax * 100, 2))
  const binDecimals = decimalsOf(bins.step)

  const probeBin =
    probeX === null
      ? null
      : Math.min(
          bins.bins - 1,
          Math.max(0, Math.floor(((probeX - MARGIN_LEFT) / plotWidth) * bins.bins)),
        )
  const edge = (b: number): string => (bins.lo + b * bins.step).toFixed(binDecimals)
  const probeRange =
    probeBin === null
      ? ""
      : `${edge(probeBin)}–${edge(probeBin + 1)}${unit === "" ? "" : ` ${unit}`}`

  const readout = (curve: Binned | null, role: string): React.JSX.Element | null => {
    if (curve === null || probeBin === null) return null
    const count = curve.counts[probeBin] ?? 0
    const share = curve.total === 0 ? 0 : (count / curve.total) * 100
    return (
      <tspan key={role} className="sankey__dist-reading" data-role={role}>
        {`  ${count.toLocaleString()} (${share.toFixed(1)}%)`}
      </tspan>
    )
  }

  const medianTick = (median: number, role: string): React.JSX.Element | null =>
    Number.isFinite(median) && median >= bins.lo && median <= bins.hi ? (
      <line
        key={role}
        className="sankey__dist-median"
        data-role={role}
        x1={x(median)}
        x2={x(median)}
        y1={base}
        y2={base + MEDIAN_TICK_PX}
      />
    ) : null

  return (
    <div ref={setHost} className="sankey__dist">
      <svg
        width={width}
        height={height}
        aria-hidden="true"
        onPointerMove={(event) => {
          const rect = event.currentTarget.getBoundingClientRect()
          const px = event.clientX - rect.left
          setProbeX(px >= MARGIN_LEFT && px <= MARGIN_LEFT + plotWidth ? px : null)
        }}
        onPointerLeave={() => setProbeX(null)}
      >
        {band !== null &&
          (band.inverted ? (
            <>
              <rect
                className="sankey__dist-band"
                x={MARGIN_LEFT}
                y={MARGIN_TOP}
                width={Math.max(0, clampX(x(band.range.min)) - MARGIN_LEFT)}
                height={plotHeight}
              />
              <rect
                className="sankey__dist-band"
                x={clampX(x(band.range.max))}
                y={MARGIN_TOP}
                width={Math.max(0, MARGIN_LEFT + plotWidth - clampX(x(band.range.max)))}
                height={plotHeight}
              />
            </>
          ) : (
            <rect
              className="sankey__dist-band"
              x={clampX(x(band.range.min))}
              y={MARGIN_TOP}
              width={Math.max(0, clampX(x(band.range.max)) - clampX(x(band.range.min)))}
              height={plotHeight}
            />
          ))}

        {shareTicks.map((share) => (
          <g key={share}>
            <line
              className="sankey__dist-grid"
              x1={MARGIN_LEFT}
              x2={MARGIN_LEFT + plotWidth}
              y1={y(share)}
              y2={y(share)}
            />
            <text
              className="sankey__dist-tick"
              x={MARGIN_LEFT - 4}
              y={y(share)}
              textAnchor="end"
              dominantBaseline="middle"
            >
              {`${(share * 100).toFixed(shareDecimals)}%`}
            </text>
          </g>
        ))}

        <defs>
          <clipPath id={clipId}>
            <rect x={MARGIN_LEFT} y={MARGIN_TOP} width={plotWidth} height={plotHeight + 1} />
          </clipPath>
        </defs>
        <g clipPath={`url(#${clipId})`}>
          {binned.ghost !== null && (
            <path className="sankey__dist-ghost" d={pathOf(binned.ghost)} />
          )}
          {binned.secondary !== null && secondary !== null && (
            <path
              className="sankey__dist-curve"
              data-role={secondary.role}
              d={pathOf(binned.secondary)}
            />
          )}
          {binned.primary !== null && primary !== null && (
            <path
              className="sankey__dist-curve"
              data-role={primary.role}
              d={pathOf(binned.primary)}
            />
          )}
        </g>

        {frame}

        {ticks.map((tick) => (
          <text
            key={tick}
            className="sankey__dist-tick"
            x={x(tick)}
            y={base + 14}
            textAnchor="middle"
          >
            {tick.toFixed(tickDecimals)}
          </text>
        ))}

        {binned.ghost !== null && medianTick(ghostMedian, "ghost")}
        {secondary !== null && medianTick(secondary.median, secondary.role)}
        {primary !== null && medianTick(primary.median, primary.role)}

        {binned.ghost !== null && (
          <text className="sankey__dist-legend" x={right} y={height - 3} textAnchor="end">
            {ghostLabel}
          </text>
        )}

        {probeX !== null && probeBin !== null && (
          <>
            <line
              className="sankey__dist-probe"
              x1={probeX}
              x2={probeX}
              y1={MARGIN_TOP}
              y2={base}
            />
            <text className="sankey__dist-readout" x={MARGIN_LEFT} y={MARGIN_TOP - 5}>
              {probeRange}
              {readout(binned.primary, primary?.role ?? "pinned")}
              {readout(binned.secondary, secondary?.role ?? "compare")}
              {readout(binned.ghost, "ghost")}
            </text>
          </>
        )}
      </svg>
    </div>
  )
}
