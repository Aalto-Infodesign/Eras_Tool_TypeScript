import { useMemo } from "react"

import { useEras } from "../app/store.ts"
import type { Ribbon } from "../core/cluster/ribbons.ts"
import type { Palette } from "../core/render/palette.ts"

interface Props {
  readonly ribbons: readonly Ribbon[]
  readonly width: number
  readonly height: number
  readonly marginY: number
  readonly xDomain: readonly [number, number]
  readonly rowCount: number
  readonly palette: Palette
}

/**
 * The aggregated reading: one shape per cluster instead of one line per patient.
 *
 * Ribbons live in SVG rather than on the canvas because there are at most a few
 * dozen of them — the exact opposite of the individuals layer. At that count DOM
 * is the cheaper choice and it brings hover, click and crisp edges for free,
 * which is the same split that keeps the hairline layer on the GPU.
 */
export function ClusterRibbons({
  ribbons,
  width,
  height,
  marginY,
  xDomain,
  rowCount,
  palette,
}: Props): React.JSX.Element | null {
  const selectedClusters = useEras((s) => s.selectedClusters)
  const toggleCluster = useEras((s) => s.toggleCluster)

  const project = useMemo(() => {
    const [x0, x1] = xDomain
    const span = Math.max(x1 - x0, 1e-6)
    const usable = Math.max(height - 2 * marginY, 1)
    const rowHeight = usable / Math.max(rowCount, 1)

    return {
      x: (value: number) => ((value - x0) / span) * width,
      y: (row: number) => marginY + (row + 0.5) * rowHeight,
      rowHeight,
    }
  }, [xDomain, width, height, marginY, rowCount])

  const shapes = useMemo(
    () =>
      ribbons.map((ribbon) => ({
        ribbon,
        body: ribbonPath(ribbon, project),
        spread: spreadPath(ribbon, project),
        color: palette.css[ribbon.globalIndex % palette.css.length] ?? "#888",
      })),
    [ribbons, project, palette],
  )

  if (width === 0 || height === 0 || ribbons.length === 0) return null

  return (
    <svg className="chart__ribbons" width={width} height={height}>
      {shapes.map(({ ribbon, body, spread, color }) => {
        const isSelected = selectedClusters.includes(ribbon.globalIndex)
        const isDimmed = selectedClusters.length > 0 && !isSelected

        return (
          <g
            key={ribbon.globalIndex}
            className="ribbon"
            data-selected={isSelected}
            opacity={isDimmed ? 0.18 : 1}
            onPointerDown={(event) => {
              event.stopPropagation()
              toggleCluster(ribbon.globalIndex)
            }}
          >
            {/* Interquartile spread of arrival time, behind the body. */}
            <path d={spread} fill={color} opacity={0.12} />
            <path d={body} fill={color} opacity={0.72} stroke={color} strokeWidth={0.5} />
            <title>
              {`${ribbon.typologyKey} · cluster ${ribbon.localCluster} · ${ribbon.size.toLocaleString()} patients`}
            </title>
          </g>
        )
      })}
    </svg>
  )
}

interface Projection {
  x(value: number): number
  y(row: number): number
  rowHeight: number
}

/** Median path, thickened vertically by half-width (in row units). */
function ribbonPath(ribbon: Ribbon, project: Projection): string {
  const top: string[] = []
  const bottom: string[] = []

  for (let k = 0; k < ribbon.x.length; k++) {
    const x = project.x(ribbon.x[k] as number)
    const row = ribbon.row[k] as number
    const half = (ribbon.halfWidth[k] as number) * project.rowHeight

    top.push(`${x.toFixed(1)},${(project.y(row) - half).toFixed(1)}`)
    bottom.push(`${x.toFixed(1)},${(project.y(row) + half).toFixed(1)}`)
  }

  bottom.reverse()
  return `M${top.join("L")}L${bottom.join("L")}Z`
}

/** The 25th–75th percentile arrival window at each state. */
function spreadPath(ribbon: Ribbon, project: Projection): string {
  const low: string[] = []
  const high: string[] = []

  for (let k = 0; k < ribbon.x.length; k++) {
    const y = project.y(ribbon.row[k] as number)
    low.push(`${project.x(ribbon.spreadLow[k] as number).toFixed(1)},${y.toFixed(1)}`)
    high.push(`${project.x(ribbon.spreadHigh[k] as number).toFixed(1)},${y.toFixed(1)}`)
  }

  high.reverse()
  return `M${low.join("L")}L${high.join("L")}Z`
}
