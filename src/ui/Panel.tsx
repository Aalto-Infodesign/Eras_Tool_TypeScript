import { useState } from "react"

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
  const [isOpen, setIsOpen] = useState(defaultOpen)

  return (
    <section className={`panel ${className ?? ""}`} data-open={isOpen}>
      <button
        type="button"
        className="panel__header"
        aria-expanded={isOpen}
        onClick={() => setIsOpen((open) => !open)}
      >
        <span className="panel__chevron" aria-hidden="true">
          ▸
        </span>
        <h2>{title}</h2>
        {count !== undefined && <span className="panel__count">{count}</span>}
      </button>

      {summary !== undefined && <div className="panel__summary">{summary}</div>}

      {isOpen && <div className="panel__body">{children}</div>}
    </section>
  )
}
