import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { createContext, useContext, useState } from "react";
export const PanelSlotContext = createContext(null);
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
export function Panel({ title, count, summary, defaultOpen = false, className, children, }) {
    const slot = useContext(PanelSlotContext);
    const [localOpen, setLocalOpen] = useState(defaultOpen);
    const isOpen = slot === null ? localOpen : (slot.open ?? defaultOpen);
    const setIsOpen = slot === null ? setLocalOpen : slot.onOpenChange;
    return (_jsxs("section", { className: `panel ${className ?? ""}`, "data-open": isOpen, "data-pinned": slot?.pinned ?? false, children: [_jsxs("div", { className: "panel__header", children: [_jsxs("button", { type: "button", className: "panel__toggle", "aria-expanded": isOpen, onClick: () => setIsOpen(!isOpen), children: [_jsx("span", { className: "panel__chevron", "aria-hidden": "true", children: "\u25B8" }), _jsx("h2", { children: title }), count !== undefined && _jsx("span", { className: "panel__count", children: count })] }), slot !== null && (_jsx("button", { type: "button", className: "panel__pin", "aria-pressed": slot.pinned, "aria-label": slot.pinned ? `Unpin ${title}` : `Pin ${title} to the top`, title: slot.pinned ? "Unpin" : "Pin to the top of the column", onClick: slot.onTogglePinned, children: _jsx(PinIcon, {}) }))] }), summary !== undefined && _jsx("div", { className: "panel__summary", children: summary }), isOpen && _jsx("div", { className: "panel__body", children: children })] }));
}
export function PinIcon() {
    return (_jsx("svg", { viewBox: "0 0 16 16", width: "12", height: "12", "aria-hidden": "true", children: _jsx("path", { d: "M10.5 1.5 14.5 5.5 12.6 6.4 9.9 9.1 10.3 12.3 9.2 13.4 6.4 10.6 2.5 14.5 1.5 13.5 5.4 9.6 2.6 6.8 3.7 5.7 6.9 6.1 9.6 3.4Z", fill: "currentColor" }) }));
}
