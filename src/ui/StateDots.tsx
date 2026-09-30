import type { Palette } from "../core/render/palette.ts"

/**
 * A sequence as a run of colour — one dot per step, repeats lifted.
 *
 * The small-multiple cards read this way, and a typology key is a long string
 * wherever else it appears. Sharing the notation means the card you clicked and
 * the chip that says what you are looking at are recognisably the same thing,
 * and the chip costs a few dozen pixels instead of a line of text.
 *
 * Dumb on purpose: the labels and the repeat marks come from `sequenceLabels`
 * and `repeatedSteps`, and callers that already have them for the rows of a
 * chart pass those rather than making a second, possibly different, copy.
 */
export function StateDots({
  states,
  labels,
  repeated,
  palette,
  className,
}: {
  readonly states: readonly number[]
  readonly labels: readonly string[]
  readonly repeated: readonly boolean[]
  readonly palette: Palette
  readonly className?: string
}): React.JSX.Element {
  return (
    <span className={className === undefined ? "dots" : `dots ${className}`}>
      {states.map((state, step) => (
        <span
          key={step}
          className="dots__swatch"
          data-repeat={repeated[step] === true}
          style={{ background: palette.css[state] }}
          title={
            repeated[step] === true
              ? `${labels[step]} — this state is visited more than once`
              : labels[step]
          }
        />
      ))}
    </span>
  )
}
