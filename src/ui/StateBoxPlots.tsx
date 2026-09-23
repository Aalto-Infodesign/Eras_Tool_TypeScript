import { useMemo } from "react"

import { useEras } from "../app/store.ts"
import type { StateStats } from "../core/render/boxplots.ts"
import type { Palette } from "../core/render/palette.ts"

interface Props {
  readonly width: number
  readonly height: number
  readonly marginY: number
  readonly xDomain: readonly [number, number]
  /** stateId → row, fractional while a reorder animates. */
  readonly rowOf: Float32Array
  /** Arrival stats of the current selection: the bar and its median tick. */
  readonly stats: readonly StateStats[]
  /** The same, before the narrowing filters: the whiskers reach out to these. */
  readonly population: readonly StateStats[]
  readonly palette: Palette
}

/** Thickness of the range bar, in CSS pixels (the original's `strokeWidth={3}`). */
const BAR_HEIGHT = 5
/** Half-height of a whisker's end cap. */
const CAP_HEIGHT = 4
/** Width of the median tick. */
const MEDIAN_WIDTH = 1.5
/** Gap between a bar's end and its extent label. */
const LABEL_GAP = 5

/**
 * One range-and-median glyph per state row — the original's `BoxPlot`.
 *
 * The glyph reads as: how early and how late this state is reached, by whom.
 *
 * - the **bar** spans the current selection's min → max arrival, with a tick at
 *   its median;
 * - the **whiskers** run from the bar's ends out to where the *unnarrowed*
 *   population reaches, with an end cap at each extreme.
 *
 * That second part is the whole point, and it is what the TypeScript rewrite had
 * lost: it puts the selection inside the population it was drawn from, so
 * narrowing shows you what you excluded rather than silently rescaling. With
 * nothing narrowed the two coincide and the whiskers vanish, exactly as in the
 * original.
 *
 * Note that the original computes `q1`/`q3` in its five-number summary and then
 * never draws them — its bar is the min→max extent, not the interquartile box
 * the name suggests. That is reproduced here; the quartiles are carried on
 * `StateStats` and are what a true box would need.
 */
export function StateBoxPlots({
  width,
  height,
  marginY,
  xDomain,
  rowOf,
  stats,
  population,
  palette,
}: Props): React.JSX.Element | null {
  const stateOrder = useEras((s) => s.visibleStates)

  const project = useMemo(() => {
    const [x0, x1] = xDomain
    const span = Math.max(x1 - x0, 1e-6)
    const usable = Math.max(height - 2 * marginY, 1)
    const rowHeight = usable / Math.max(stateOrder.length, 1)

    return {
      x: (value: number) => ((value - x0) / span) * width,
      y: (row: number) => marginY + (row + 0.5) * rowHeight,
    }
  }, [xDomain, width, height, marginY, stateOrder.length])

  const fullByState = useMemo(
    () => new Map(population.map((entry) => [entry.state, entry])),
    [population],
  )

  if (width === 0 || height === 0 || stats.length === 0) return null

  return (
    <svg className="chart__boxplots" width={width} height={height} aria-hidden="true">
      {stats.map((stat) => {
        const row = rowOf[stat.state]
        if (row === undefined || row < 0) return null

        const color = palette.css[stat.state] ?? "currentColor"
        const y = project.y(row)
        const min = project.x(stat.min)
        const max = project.x(stat.max)
        const full = fullByState.get(stat.state)

        return (
          <g key={stat.state} className="boxplot" transform={`translate(0 ${y.toFixed(1)})`}>
            {full !== undefined && (
              <>
                <Whisker from={project.x(full.min)} to={min} color={color} />
                <Whisker from={project.x(full.max)} to={max} color={color} />
              </>
            )}

            <rect
              className="boxplot__bar"
              x={min}
              width={Math.max(max - min, 0.5)}
              y={-BAR_HEIGHT / 2}
              height={BAR_HEIGHT}
              fill={color}
            />
            <rect
              className="boxplot__median"
              x={project.x(stat.median) - MEDIAN_WIDTH / 2}
              width={MEDIAN_WIDTH}
              y={-BAR_HEIGHT / 2}
              height={BAR_HEIGHT}
            />

            <text className="boxplot__label" x={min - LABEL_GAP} textAnchor="end" fill={color}>
              {`${stat.min.toFixed(0)}y`}
            </text>
            <text className="boxplot__label" x={max + LABEL_GAP} textAnchor="start" fill={color}>
              {`${stat.max.toFixed(0)}y`}
            </text>
          </g>
        )
      })}
    </svg>
  )
}

/** One side: a thin line out to the population's extreme, capped there. */
function Whisker({
  from,
  to,
  color,
}: {
  from: number
  to: number
  color: string
}): React.JSX.Element | null {
  if (Math.abs(from - to) < 0.5) return null

  return (
    <g className="boxplot__whisker">
      <line x1={from} x2={to} y1={0} y2={0} stroke={color} />
      <rect x={from - 0.25} width={0.5} y={-CAP_HEIGHT / 2} height={CAP_HEIGHT} fill={color} />
    </g>
  )
}
