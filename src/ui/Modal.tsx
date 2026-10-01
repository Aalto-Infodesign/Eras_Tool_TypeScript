import { useEffect, useRef } from "react"

interface Props {
  readonly open: boolean
  readonly title: string
  readonly onClose: () => void
  /** Right of the title, on the header row. */
  readonly toolbar?: React.ReactNode
  /** Added to `modal`, for a dialog that is not the default wide one. */
  readonly className?: string
  readonly children: React.ReactNode
}

/**
 * A real `<dialog>`, opened declaratively.
 *
 * The original's `Dialog` was controlled imperatively — the parent held a ref
 * and called `showModal()` — which works but leaves two sources of truth for
 * "is it open". Here an effect drives the element from a prop, and the element's
 * own `close` event reports back, so the browser's paths (Escape, the top-layer
 * dismiss) and ours cannot drift apart.
 *
 * `showModal` rather than `show`: only the modal form puts the dialog in the top
 * layer with a real `::backdrop`, traps focus and makes Escape work — all of
 * which would otherwise have to be reimplemented badly.
 *
 * Children mount only while open. The path explorer builds a trie and paints a
 * canvas; neither should happen for a dialog nobody has opened.
 */
export function Modal({
  open,
  title,
  onClose,
  toolbar,
  className,
  children,
}: Props): React.JSX.Element {
  const ref = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const dialog = ref.current
    if (dialog === null) return

    if (open && !dialog.open) dialog.showModal()
    else if (!open && dialog.open) dialog.close()
  }, [open])

  return (
    <dialog
      ref={ref}
      className={`modal ${className ?? ""}`}
      // The dialog element covers the whole viewport; its children do not. So a
      // click whose target is the element itself landed on the backdrop.
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
      onClose={onClose}
    >
      <div className="modal__head">
        <h2>{title}</h2>
        {toolbar}
        <button type="button" className="button" onClick={onClose}>
          Close
        </button>
      </div>
      {open && <div className="modal__body">{children}</div>}
    </dialog>
  )
}
