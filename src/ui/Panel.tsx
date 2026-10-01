import { createContext, useContext, useState } from "react"

/**
 * What the side column knows about the panel it placed here: whether it is
 * pinned, and its fold. A context rather than props, so no panel component has
 * to thread its own id through — the column wraps each one in a slot.
 *
 * Without a slot (a panel rendered anywhere else) the fold is local state and
 * there is no pin.
 */
export interface PanelSlot {
  readonly pinned: boolean
  readonly onTogglePinned: () => void
  /** `undefined` until the panel is first toggled: the panel's own default holds. */
  readonly open: boolean | undefined
  readonly onOpenChange: (open: boolean) => void
}

export const PanelSlotContext = createContext<PanelSlot | null>(null)

interface Props {
  readonly title: string
  /** Shown on the right of the header, and kept visible while collapsed. */
  readonly count?: React.ReactNode
  /**
   * Rendered under the header and, unlike `children`, kept on screen when the
   * panel folds away.
   *
   * For the state a panel has *put on the data* rather than the controls that
   * put it there. A collapsed Filters panel was still cutting the cohort with no
   * sign of how, which is the one thing a fold must not hide — the count in the
   * header says the selection shrank, not what shrank it.
   */
  readonly summary?: React.ReactNode
  readonly defaultOpen?: boolean
  readonly className?: string
  readonly children: React.ReactNode
}

/**
 * A collapsible side panel — the shell every panel in the column shares.
 *
 * The column stacks four of these and only so much of it fits on screen, so each
 * one folds away. They are independent disclosures rather than a true accordion:
 * opening one does not close the others, because the panels answer different
 * questions and wanting two at once is the normal case.
 *
 * The header is a real `<button>` with `aria-expanded`, so the whole column is
 * operable from the keyboard. The count stays in the header while collapsed,
 * which is what makes a folded panel still worth having on screen.
 */
export function Panel({
  title,
  count,
  summary,
  defaultOpen = false,
  className,
  children,
}: Props): React.JSX.Element {
  const slot = useContext(PanelSlotContext)
  const [localOpen, setLocalOpen] = useState(defaultOpen)

  const isOpen = slot === null ? localOpen : (slot.open ?? defaultOpen)
  const setIsOpen = slot === null ? setLocalOpen : slot.onOpenChange

  return (
    <section
      className={`panel ${className ?? ""}`}
      data-open={isOpen}
      data-pinned={slot?.pinned ?? false}
    >
      {/* Two buttons side by side, not one inside the other: a button may not
          contain another interactive element. */}
      <div className="panel__header">
        <button
          type="button"
          className="panel__toggle"
          aria-expanded={isOpen}
          onClick={() => setIsOpen(!isOpen)}
        >
          <span className="panel__chevron" aria-hidden="true">
            ▸
          </span>
          <h2>{title}</h2>
          {count !== undefined && <span className="panel__count">{count}</span>}
        </button>
        {slot !== null && (
          <button
            type="button"
            className="panel__pin"
            aria-pressed={slot.pinned}
            aria-label={slot.pinned ? `Unpin ${title}` : `Pin ${title} to the top`}
            title={slot.pinned ? "Unpin" : "Pin to the top of the column"}
            onClick={slot.onTogglePinned}
          >
            <PinIcon />
          </button>
        )}
      </div>

      {summary !== undefined && <div className="panel__summary">{summary}</div>}

      {isOpen && <div className="panel__body">{children}</div>}
    </section>
  )
}

export function PinIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
      <path
        d="M10.5 1.5 14.5 5.5 12.6 6.4 9.9 9.1 10.3 12.3 9.2 13.4 6.4 10.6 2.5 14.5 1.5 13.5 5.4 9.6 2.6 6.8 3.7 5.7 6.9 6.1 9.6 3.4Z"
        fill="currentColor"
      />
    </svg>
  )
}
