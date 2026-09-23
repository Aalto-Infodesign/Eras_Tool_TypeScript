import { useMemo } from "react"

import { useEras } from "../app/store.ts"
import type { Palette } from "../core/render/palette.ts"

interface Props {
  readonly width: number
  readonly height: number
  readonly marginY: number
  readonly xDomain: readonly [number, number]
  readonly rowOf: Float32Array
  readonly palette: Palette
}

/**
 * The handful of trajectories that are hovered or selected, drawn thick and
 * opaque over everything else.
 *
 * This is the split that makes the whole thing fast — the canvas draws the
 * hundreds of thousands of lines nobody interacts with individually, and SVG
 * draws the two or three that carry the interaction. The original put *every*
 * line in SVG, which meant paying interaction cost for lines that were one
 * pixel of a dense mass.
 *
 * The row lines and labels this used to carry now live in `ChartGrid`, under the
 * aggregate layers rather than over them.
 */
export function TrajectoryOverlay({
  width,
  height,
  marginY,
  xDomain,
  rowOf,
  palette,
}: Props): React.JSX.Element | null {
  const store = useEras((s) => s.store)
  const stateOrder = useEras((s) => s.visibleStates)
  const axis = useEras((s) => s.axis)
  const hovered = useEras((s) => s.hoveredPatient)
  const selected = useEras((s) => s.selectedPatients)

  const rowHeight = useMemo(() => {
    const usable = Math.max(height - 2 * marginY, 1)
    return usable / Math.max(stateOrder.length, 1)
  }, [height, marginY, stateOrder.length])

  const toPixels = useMemo(() => {
    const [x0, x1] = xDomain
    const span = Math.max(x1 - x0, 1e-6)
    return {
      x: (value: number) => ((value - x0) / span) * width,
      y: (row: number) => marginY + (row + 0.5) * rowHeight,
    }
  }, [xDomain, width, marginY, rowHeight])

  const highlighted = useMemo(() => {
    if (store === null) return []
    const ids = hovered === null ? selected : [...selected, hovered]
    const unique = Array.from(new Set(ids))

    return unique.map((patient) => {
      const start = store.offsets[patient] as number
      const end = store.offsets[patient + 1] as number
      const xs = axis === "age" ? store.ages : store.years

      const points: string[] = []
      for (let e = start; e < end; e++) {
        const state = store.stateIds[e] as number
        const row = rowOf[state] as number
        if (row < 0) continue
        points.push(`${toPixels.x(xs[e] as number).toFixed(1)},${toPixels.y(row).toFixed(1)}`)
      }

      return {
        patient,
        id: store.ids.at(patient),
        points: points.join(" "),
        isHovered: patient === hovered,
      }
    })
  }, [store, hovered, selected, axis, rowOf, toPixels])

  if (store === null || width === 0 || height === 0) return null

  return (
    <svg className="chart__overlay" width={width} height={height} aria-hidden="true">
      {highlighted.map((trajectory) => (
        <g key={trajectory.patient}>
          <polyline
            points={trajectory.points}
            className="chart__highlight-halo"
            fill="none"
          />
          <polyline
            points={trajectory.points}
            className={
              trajectory.isHovered ? "chart__highlight chart__highlight--hovered" : "chart__highlight"
            }
            fill="none"
            stroke={palette.css[0]}
          />
        </g>
      ))}

      {hovered !== null && highlighted.length > 0 && (
        <text
          x={width - 8}
          y={16}
          textAnchor="end"
          className="chart__hovered-label"
        >
          {store.ids.at(hovered)}
        </text>
      )}
    </svg>
  )
}
