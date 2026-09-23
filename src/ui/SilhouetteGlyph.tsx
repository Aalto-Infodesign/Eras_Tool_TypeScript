import { memo } from "react"

interface Props {
  /** The typology's ordered state sequence. */
  readonly states: Uint16Array
  /** `rows[stateId]` → band, matching the chart. `-1` for a state with no row. */
  readonly rows: Float32Array
  readonly rowCount: number
  readonly palette: readonly string[]
  /**
   * Longest sequence in the dataset. Shared by every glyph so the horizontal
   * spacing means the same thing on every card — a three-step silhouette is
   * visibly shorter than a six-step one instead of being stretched to fit.
   */
  readonly maxSteps: number
  readonly size: number
}

/** Drawing space. The browser scales the viewBox to whatever `size` asks for. */
const VIEWBOX = 100
const PADDING = 12

/**
 * One typology as its shape.
 *
 * The glyph is the same picture as the chart behind it, shrunk: x is the step
 * along the trajectory, y is the state's row in the *current* ordering, colour
 * is the same palette. So reordering the rows restacks every card, which is what
 * makes the "order states" button legible — you can see what it did.
 *
 * Kept as SVG rather than canvas because a card is a dozen elements and there
 * are only ever a screenful of them mounted (the list is windowed). That buys
 * hit-testing, a `<title>`, and CSS transitions on the geometry for free.
 *
 * Memoised on the props: a reorder changes `rows` and re-renders every mounted
 * glyph, but a selection or a scroll changes neither and re-renders none.
 */
export const SilhouetteGlyph = memo(function SilhouetteGlyph({
  states,
  rows,
  rowCount,
  palette,
  maxSteps,
  size,
}: Props): React.JSX.Element {
  // `maxSteps - 1` gaps between `maxSteps` points; a one-state dataset has none,
  // and dividing by it would put every point at infinity.
  const gaps = Math.max(maxSteps - 1, 1)
  const usable = VIEWBOX - PADDING * 2
  const band = VIEWBOX / (rowCount + 1)

  const x = (step: number): number => PADDING + (step / gaps) * usable
  const y = (state: number): number => ((rows[state] ?? 0) + 1) * band

  return (
    <svg className="glyph" viewBox={`0 0 ${VIEWBOX} ${VIEWBOX}`} width={size} height={size}>
      <g className="glyph__links">
        {Array.from(states, (state, i) => {
          const next = states[i + 1]
          if (next === undefined) return null
          return (
            <line
              key={i}
              x1={x(i)}
              y1={y(state)}
              x2={x(i + 1)}
              y2={y(next)}
              stroke={palette[state] ?? "currentColor"}
            />
          )
        })}
      </g>
      <g className="glyph__nodes">
        {Array.from(states, (state, i) => (
          <circle key={i} cx={x(i)} cy={y(state)} r={5} fill={palette[state] ?? "currentColor"} />
        ))}
      </g>
    </svg>
  )
})
