import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { isAvailable, PANELS, useSidePanels } from "../app/sidePanels.ts";
import { chartModeOf, useEras } from "../app/store.ts";
import { Modal } from "./Modal.tsx";
import { PinIcon } from "./Panel.tsx";
const TITLES = new Map(PANELS.map((panel) => [panel.id, panel.title]));
/**
 * The settings that do not earn a place on screen: tuning the chart, and
 * arranging the side column. One dialog for both, opened from the gear at the
 * end of the control bar or from the foot of the column.
 *
 * The backdrop is lighter than the other dialogs' and unblurred, so the opacity
 * slider can be judged against the chart behind it.
 */
export function SettingsModal() {
    const open = useSidePanels((s) => s.settingsOpen);
    const setOpen = useSidePanels((s) => s.setSettingsOpen);
    return (_jsxs(Modal, { open: open, title: "Settings", onClose: () => setOpen(false), className: "modal--settings", children: [_jsxs("section", { className: "settings__section", children: [_jsx("h3", { children: "Chart" }), _jsx(OpacitySetting, {})] }), _jsxs("section", { className: "settings__section", children: [_jsx("h3", { children: "Side panels" }), _jsx(PanelSettings, {})] })] }));
}
/** Moved here from the control bar; the logic is the one it had there. */
function OpacitySetting() {
    const view = useEras((s) => s.view);
    const opacity = useEras((s) => s.opacity);
    const setOpacity = useEras((s) => s.setOpacity);
    const layers = useEras((s) => s.layers);
    const selectedTypologies = useEras((s) => s.selectedTypologies);
    /*
     * The grid draws every panel's own cohort whatever the Lines toggle says —
     * those hairlines *are* the panel, the thing whose slope is being compared,
     * not a layer over something else. So the slider still governs them there,
     * where in the single chart it belongs to a layer you can switch off.
     */
    const isGrid = chartModeOf(selectedTypologies) === "multiples";
    // The hairlines step back under anything drawn over them, and the slider
    // changes meaning with them. See `ViewState.bulkFade`.
    const isBackdrop = (layers.lines || isGrid) && (layers.medoids || layers.lumps);
    const applies = view === "trajectories" && (layers.lines || isGrid);
    return (_jsxs("label", { className: "settings__row", "data-disabled": !applies, children: [_jsxs("span", { className: "settings__label", children: [isBackdrop ? "Line backdrop" : "Line opacity", _jsx("small", { children: view === "sankey"
                            ? "Trajectories view only"
                            : !applies
                                ? "Needs the Lines layer"
                                : isBackdrop
                                    ? "Mixed into the background, so crossings do not stack"
                                    : "Alpha of each trajectory line" })] }), _jsx("input", { type: "range", className: "settings__range", min: 0.02, max: 1, step: 0.01, value: opacity, disabled: !applies, onChange: (event) => setOpacity(Number(event.target.value)) }), _jsx("span", { className: "controls__value", children: applies ? opacity.toFixed(2) : "—" })] }));
}
function PanelSettings() {
    const order = useSidePanels((s) => s.order);
    const hidden = useSidePanels((s) => s.hidden);
    const pinned = useSidePanels((s) => s.pinned);
    const move = useSidePanels((s) => s.move);
    const setVisible = useSidePanels((s) => s.setVisible);
    const togglePinned = useSidePanels((s) => s.togglePinned);
    const resetLayout = useSidePanels((s) => s.resetLayout);
    const ids = order.filter(isAvailable);
    return (_jsxs(_Fragment, { children: [_jsx("p", { className: "settings__hint", children: "Pinned panels stay above the scrolling part of the column. The pin in a panel's header does the same." }), _jsx("ol", { className: "settings__panels", children: ids.map((id, index) => {
                    const title = TITLES.get(id) ?? id;
                    const isVisible = !hidden.includes(id);
                    const isPinned = pinned.includes(id);
                    return (_jsxs("li", { className: "settings__panel", "data-hidden": !isVisible, children: [_jsxs("label", { className: "settings__check", children: [_jsx("input", { type: "checkbox", checked: isVisible, onChange: (event) => setVisible(id, event.target.checked) }), title] }), _jsx("button", { type: "button", className: "settings__icon", "aria-pressed": isPinned, "aria-label": isPinned ? `Unpin ${title}` : `Pin ${title}`, title: isPinned ? "Unpin" : "Pin to the top", onClick: () => togglePinned(id), children: _jsx(PinIcon, {}) }), _jsx("button", { type: "button", className: "settings__icon", "aria-label": `Move ${title} up`, disabled: index === 0, onClick: () => move(id, -1), children: "\u2191" }), _jsx("button", { type: "button", className: "settings__icon", "aria-label": `Move ${title} down`, disabled: index === ids.length - 1, onClick: () => move(id, 1), children: "\u2193" })] }, id));
                }) }), _jsx("div", { className: "settings__actions", children: _jsx("button", { type: "button", className: "button button--tiny", onClick: resetLayout, children: "Reset to default" }) })] }));
}
