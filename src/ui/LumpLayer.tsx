import { useMemo, useState } from "react"

import { useEras } from "../app/store.ts"
import type { Lump } from "../core/render/lumps.ts"
import type { Palette } from "../core/render/palette.ts"

interface Props {
  readonly lumps: readonly Lump[]
  readonly width: number
  readonly height: number
  readonly marginY: number
  readonly xDomain: readonly [number, number]
  /** `rowOf[stateId]` → vertical band, `-1` when hidden, fractional mid-animation. */
  readonly rowOf: Float32Array
  readonly rowCount: number
  readonly palette: Palette
}

/** Inset of each edge from its row, as a fraction of the row height. */
const PADDING_RATIO = 0.14
/** Ceiling on that inset, in CSS pixels, so tall rows do not get fat lumps. */
const MAX_PADDING = 7
/** Horizontal skew that keeps a→b from sitting exactly on top of b→a. */
const OFFSET_X = 2
/** Opacity ramp across lump sizes, as the original's `opacityScale`. */
const MIN_OPACITY = 0.5
const MAX_OPACITY = 0.8
/** A lump carrying a single link is a line, not a shape. */
const EXTREME_OPACITY = 0.2

/**
 * One quad per ordered state pair — the original's `LumpPolygon`.
 *
 * The four corners are the source extent on the source row and the target extent
 * on the target row:
 *
 * ```
 *   source row   ┌──────────────┐        ← sourceMin … sourceMax, flat
 *                 \              \
 *   target row     └──────────────┘      ← targetMin … targetMax, flat
 * ```
 *
 * Both edges are horizontal by construction, because both ends of an edge take
 * that row's y. This replaces the median-path ribbon, whose outline walked every
 * state of a group with a per-position half-width — an outline that spiked
 * wherever the half-width or the row changed between adjacent points.
 *
 * Each edge is inset toward the other by `padding`, so touching lumps stay
 * distinguishable, and the whole quad is skewed by `OFFSET_X` in the direction of
 * travel, so a→b and b→a do not coincide. A lump whose source and target are the
 * same state is the self-link case: `targetY === sourceY`, the two insets fall
 * either side of the row, and it renders as a flat band lying on it.
 */
export function LumpLayer({
  lumps,
  width,
  height,
  marginY,
  xDomain,
  rowOf,
  rowCount,
  palette,
}: Props): React.JSX.Element | null {
  const stateNames = useEras((s) => s.store?.stateNames ?? null)
  const [hovered, setHovered] = useState<string | null>(null)

  const project = useMemo(() => {
    const [x0, x1] = xDomain
    const span = Math.max(x1 - x0, 1e-6)
    const usable = Math.max(height - 2 * marginY, 1)
    const rowHeight = usable / Math.max(rowCount, 1)

    return {
      x: (value: number) => ((value - x0) / span) * width,
      y: (row: number) => marginY + (row + 0.5) * rowHeight,
      padding: Math.min(MAX_PADDING, rowHeight * PADDING_RATIO),
    }
  }, [xDomain, width, height, marginY, rowCount])

  /**
   * Opacity ramps with size across the lumps actually in view, so the ordering
   * of the transitions reads even when every one of them is large.
   */
  const opacityOf = useMemo(() => {
    let lo = Infinity
    let hi = -Infinity
    for (const lump of lumps) {
      if (lump.count < lo) lo = lump.count
      if (lump.count > hi) hi = lump.count
    }

    const span = hi - lo
    return (count: number): number =>
      span <= 0 ? MAX_OPACITY : MIN_OPACITY + ((count - lo) / span) * (MAX_OPACITY - MIN_OPACITY)
  }, [lumps])

  const shapes = useMemo(
    () =>
      lumps.flatMap((lump) => {
        const sourceRow = rowOf[lump.sourceState] ?? -1
        const targetRow = rowOf[lump.targetState] ?? -1
        if (sourceRow < 0 || targetRow < 0) return []

        const key = `${lump.sourceState}-${lump.targetState}`
        const sourceY = project.y(sourceRow)
        const targetY = project.y(targetRow)

        // Both edges move toward each other; a self-link (same row) falls back
        // to source-above, target-below, which is the band lying on the row.
        const descending = targetY > sourceY
        const pad = project.padding
        const sourceEdgeY = sourceY + (descending ? pad : -pad)
        const targetEdgeY = targetY + (descending ? -pad : pad)
        const offset = descending ? -OFFSET_X : OFFSET_X

        const points = [
          [project.x(lump.sourceMin) - offset, sourceEdgeY],
          [project.x(lump.sourceMax) - offset, sourceEdgeY],
          [project.x(lump.targetMax) + offset, targetEdgeY],
          [project.x(lump.targetMin) + offset, targetEdgeY],
        ]

        return [
          {
            key,
            lump,
            sourceRow,
            targetRow,
            points: points
              .map(([x, y]) => `${(x as number).toFixed(1)},${(y as number).toFixed(1)}`)
              .join(" "),
            sourceY,
            targetY,
          },
        ]
      }),
    [lumps, rowOf, project],
  )

  if (width === 0 || height === 0 || shapes.length === 0) return null

  return (
    <svg className="chart__lumps" width={width} height={height}>
      <defs>
        {shapes.map(({ key, lump, sourceRow, targetRow }) => (
          <linearGradient
            key={key}
            id={`lump-gradient-${key}`}
            x1="0%"
            x2="0%"
            y1={sourceRow > targetRow ? "100%" : "0%"}
            y2={sourceRow > targetRow ? "0%" : "100%"}
          >
            <stop offset="0%" stopColor={palette.css[lump.sourceState] ?? "#888"} />
            <stop offset="85%" stopColor={palette.css[lump.targetState] ?? "#888"} />
          </linearGradient>
        ))}
      </defs>

      {shapes.map(({ key, lump, points, sourceY, targetY }) => {
        const isSelf = lump.sourceState === lump.targetState
        const fill = isSelf
          ? (palette.css[lump.sourceState] ?? "#888")
          : `url(#lump-gradient-${key})`

        const isHovered = hovered === key
        const opacity = hovered === null ? opacityOf(lump.count) : isHovered ? 1 : 0.2

        // A single link has no extent to fill, so it reads as the line it is.
        if (lump.count === 1) {
          return (
            <line
              key={key}
              className="lump lump--extreme"
              x1={project.x(lump.sourceMin)}
              x2={project.x(lump.targetMin)}
              y1={sourceY}
              y2={targetY}
              stroke={fill}
              opacity={hovered === null ? EXTREME_OPACITY : isHovered ? 1 : 0.1}
              onPointerEnter={() => setHovered(key)}
              onPointerLeave={() => setHovered(null)}
            >
              <title>{title(lump, stateNames, isSelf)}</title>
            </line>
          )
        }

        return (
          <polygon
            key={key}
            className="lump"
            points={points}
            fill={fill}
            opacity={opacity}
            onPointerEnter={() => setHovered(key)}
            onPointerLeave={() => setHovered(null)}
          >
            <title>{title(lump, stateNames, isSelf)}</title>
          </polygon>
        )
      })}
    </svg>
  )
}

function title(lump: Lump, stateNames: readonly string[] | null, isSelf: boolean): string {
  const name = (state: number): string => stateNames?.[state] ?? String(state)

  const transition = isSelf
    ? `${name(lump.sourceState)} (no further change)`
    : `${name(lump.sourceState)} → ${name(lump.targetState)}`

  return `${transition} · ${lump.count.toLocaleString()} transitions`
}
