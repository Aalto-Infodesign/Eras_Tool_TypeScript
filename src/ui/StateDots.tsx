import { useEffect, useRef, useState } from "react"

import type { Palette } from "../core/render/palette.ts"

/** How long the pointer rests on the run before it spells itself out. */
const REVEAL_MS = 260

/**
 * A sequence as a run of colour — one dot per step, repeats lifted — that spells
 * itself out on rest.
 *
 * The small-multiple cards read this way and so does the chip saying which
 * typology is open, which means the thing you clicked and the thing telling you
 * where you are look alike. A key is a long string; this is a few dozen pixels,
 * and the names are one rest away.
 *
 * The panel is **one name per line, in that step's colour**, so the sequence is
 * legible at a glance rather than parsed out of a run-on string — and the colours
 * tie each name back to the dot and the rule it belongs to. It replaces the
 * `title` each dot used to carry: a native tooltip appears *under the pointer*,
 * which is exactly where the panel is, so the browser covered the thing being
 * revealed with a worse version of it.
 *
 * Dumb about content on purpose: labels and repeat marks come from
 * `sequenceLabels` and `repeatedSteps`, and callers that already hold them for
 * the rows of a chart pass those rather than making a second, possibly
 * different, copy.
 */
export function StateDots({
  states,
  labels,
  repeated,
  palette,
  hint,
  className,
  reveal = true,
}: {
  readonly states: readonly number[]
  readonly labels: readonly string[]
  readonly repeated: readonly boolean[]
  readonly palette: Palette
  /** A muted last line, for whatever the thing carrying the dots does on click. */
  readonly hint?: string
  readonly className?: string
  /**
   * Whether resting on the dots spells them out. Off where something else
   * already names the steps — the compact grid labels a card's rules on hover.
   */
  readonly reveal?: boolean
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const timer = useRef(0)

  useEffect(() => () => window.clearTimeout(timer.current), [])

  return (
    <span
      className={className === undefined ? "dots" : `dots ${className}`}
      onPointerEnter={() => {
        if (!reveal) return
        window.clearTimeout(timer.current)
        timer.current = window.setTimeout(() => setOpen(true), REVEAL_MS)
      }}
      onPointerLeave={() => {
        window.clearTimeout(timer.current)
        setOpen(false)
      }}
    >
      {states.map((state, step) => (
        <span
          key={step}
          className="dots__swatch"
          data-repeat={repeated[step] === true}
          style={{ background: palette.css[state] }}
        />
      ))}

      {open && (
        <span className="dots__panel" role="tooltip">
          {states.map((state, step) => (
            <span key={step} className="dots__entry" style={{ color: palette.css[state] }}>
              <span className="dots__step">{step + 1}</span>
              {labels[step]}
            </span>
          ))}
          {hint !== undefined && <span className="dots__hint">{hint}</span>}
        </span>
      )}
    </span>
  )
}
