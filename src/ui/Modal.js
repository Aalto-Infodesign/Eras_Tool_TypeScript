import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useRef } from "react";
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
export function Modal({ open, title, onClose, toolbar, className, closeLabel = "Close", closePrimary = false, children, }) {
    const ref = useRef(null);
    useEffect(() => {
        const dialog = ref.current;
        if (dialog === null)
            return;
        if (open && !dialog.open)
            dialog.showModal();
        else if (!open && dialog.open)
            dialog.close();
    }, [open]);
    return (_jsxs("dialog", { ref: ref, className: `modal ${className ?? ""}`, 
        // The dialog element covers the whole viewport; its children do not. So a
        // click whose target is the element itself landed on the backdrop.
        onClick: (event) => {
            if (event.target === event.currentTarget)
                onClose();
        }, onClose: onClose, children: [_jsxs("div", { className: "modal__head", children: [_jsx("h2", { children: title }), toolbar, _jsx("button", { type: "button", className: `button ${closePrimary ? "button--primary" : ""}`, onClick: onClose, children: closeLabel })] }), open && _jsx("div", { className: "modal__body", children: children })] }));
}
