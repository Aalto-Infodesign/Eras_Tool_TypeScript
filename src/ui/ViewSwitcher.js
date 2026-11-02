import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useEffect, useId, useMemo } from "react";
import { useEras } from "../app/store.ts";
import { buildPalette } from "../core/render/palette.ts";
import { layoutSankey } from "../core/render/sankeyLayout.ts";
import { repeatedSteps, sequenceLabels } from "../core/stats/silhouettes.ts";
import { MiniTrajectories } from "./MiniTrajectories.tsx";
import { Panel } from "./Panel.tsx";
import { exportSelection } from "./quickExport.ts";
import { SankeyBase } from "./SankeyGraphic.tsx";
import { StateDots } from "./StateDots.tsx";
import { useSankey } from "./useSankey.ts";
const NAMES = {
    sankey: "Sankey",
    trajectories: "Trajectories",
};
/** The thumbnail's height, the path explorer's minimap's: the column's one picture size. */
const MINI_HEIGHT = 150;
/**
 * The mini Sankey is laid out once at this size and scaled by its viewBox, so
 * the panel's width — which shifts with a scrollbar — never relays it out.
 */
const MINI_SANKEY_WIDTH = 300;
/** The original's keystrokes: 1 was the Sankey ("Parallel"), 2 the trajectories. */
const KEYS = {
    Digit1: "sankey",
    Numpad1: "sankey",
    Digit2: "trajectories",
    Numpad2: "trajectories",
};
function isEditable(target) {
    if (!(target instanceof HTMLElement))
        return false;
    return (target.isContentEditable ||
        target.closest("input, textarea, select, [contenteditable]") !== null);
}
/**
 * The first panel in the column: the view that is *not* in the main area, live
 * and small, and the way to swap to it.
 *
 * The reading order runs from the Sankey — every typology as one flow — down to
 * the small multiples and then to a single typology, and the two main views are
 * different *kinds* of chart rather than two readings of one selection, so which
 * one is big is a choice the store holds (`view`). Multiples-versus-single stays
 * derived: within the Trajectories view, the selection still decides.
 *
 * The thumbnail is the switch. It is one button — nothing inside it takes focus
 * or the pointer — and it shows what clicking would actually open: the Sankey
 * of the current selection, or the grid's first panels (the one typology, when
 * one is chosen). It is the only on-screen switch — the chart controls no
 * longer carry one, which is why the column will not hide this panel — and
 * 1 / 2 work from anywhere, as they did in the original.
 */
export function ViewSwitcher() {
    const hasData = useEras((s) => s.store !== null);
    const view = useEras((s) => s.view);
    const setView = useEras((s) => s.setView);
    if (!hasData)
        return null;
    const other = view === "sankey" ? "trajectories" : "sankey";
    return (_jsxs(Panel, { title: "View", count: NAMES[view], defaultOpen: true, className: "panel--view", children: [other === "trajectories" ? (_jsx(MiniButton, { view: other, label: "Switch to the Trajectories view \u2014 key 2", picture: _jsx(MiniTrajectories, {}), caption: _jsx(TrajectoriesCaption, {}), onSwap: () => setView(other) })) : (_jsx(SankeyMiniButton, { onSwap: () => setView(other) })), _jsx("button", { type: "button", className: "button button--tiny viewswitch__export", title: "Export the ids of every individual in the current selection", onClick: exportSelection, children: "\u2913 Export selection" })] }));
}
/**
 * Keys 1 and 2 swap the main view.
 *
 * Not in `ViewSwitcher`: the side column can hide that panel, and the keys must
 * keep working with it out of sight — so the column calls this, whatever it
 * shows. Never out from under something that owns the key — a field being
 * typed in, an open dialog — and never with a modifier, which belongs to the
 * browser.
 */
export function useViewKeys() {
    const setView = useEras((s) => s.setView);
    useEffect(() => {
        const onKeyDown = (event) => {
            if (event.defaultPrevented || event.repeat)
                return;
            if (event.ctrlKey || event.metaKey || event.altKey)
                return;
            if (isEditable(event.target) || document.querySelector("dialog[open]") !== null)
                return;
            const next = KEYS[event.code];
            if (next === undefined)
                return;
            event.preventDefault();
            setView(next);
        };
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, [setView]);
}
/** One `useSankey` for both the picture and its caption: the graph is built once. */
function SankeyMiniButton({ onSwap }) {
    const sankey = useSankey();
    return (_jsx(MiniButton, { view: "sankey", label: "Switch to the Sankey \u2014 key 1", picture: _jsx(MiniSankey, { ...sankey }), caption: _jsxs(_Fragment, { children: [_jsx("b", { children: "Sankey" }), _jsxs("span", { children: [sankey.graph.steps, " steps \u00B7 ", sankey.graph.links.length.toLocaleString(), " flows"] })] }), onSwap: onSwap }));
}
function MiniButton({ view, label, picture, caption, onSwap, }) {
    return (_jsxs("button", { type: "button", className: "viewswitch__mini", "aria-label": label, onClick: onSwap, children: [_jsxs("span", { className: "viewswitch__frame", "aria-hidden": "true", children: [picture, _jsx("span", { className: "viewswitch__swap", children: "\u21C4 Swap" })] }, view), _jsx("span", { className: "viewswitch__caption", children: caption })] }));
}
/**
 * The Sankey of the current selection at thumbnail size: the same graph the
 * main view draws (`useSankey`), the base layer only, laid out at a fixed size
 * and never tweened — a picture, not a chart.
 */
function MiniSankey({ graph, palette, stateRank }) {
    const order = useEras((s) => s.sankeyOrder);
    const uid = useId();
    const layout = useMemo(() => layoutSankey(graph, {
        width: MINI_SANKEY_WIDTH,
        height: MINI_HEIGHT,
        marginX: 4,
        marginTop: 4,
        marginBottom: 4,
        nodeWidth: 4,
        nodePadding: 3,
        minNodeHeight: 0.75,
        minLinkWidth: 0.75,
        minColumnGap: 0,
        order,
        stateRank,
        keepOrder: null,
    }), [graph, order, stateRank]);
    return (_jsx("svg", { className: "viewswitch__sankey", viewBox: `0 0 ${MINI_SANKEY_WIDTH} ${MINI_HEIGHT}`, preserveAspectRatio: "none", children: _jsx(SankeyBase, { graph: graph, layout: layout, palette: palette, uid: uid, mini: true, exiting: null }) }));
}
function TrajectoriesCaption() {
    const store = useEras((s) => s.store);
    const typologies = useEras((s) => s.typologies);
    const selected = useEras((s) => s.selectedTypologies);
    const stateCount = store?.stateNames.length ?? 0;
    const palette = useMemo(() => buildPalette(stateCount), [stateCount]);
    const single = useMemo(() => {
        if (store === null || selected.length !== 1)
            return null;
        const typology = typologies.find((t) => t.key === selected[0]);
        if (typology === undefined)
            return null;
        const states = Array.from(typology.states);
        return {
            states,
            labels: sequenceLabels(typology.states, store.stateNames),
            repeated: repeatedSteps(typology.states),
        };
    }, [store, typologies, selected]);
    if (single !== null) {
        return (_jsxs(_Fragment, { children: [_jsx("b", { children: "Trajectories" }), _jsx(StateDots, { states: single.states, labels: single.labels, repeated: single.repeated, palette: palette })] }));
    }
    return (_jsxs(_Fragment, { children: [_jsx("b", { children: "Trajectories" }), _jsx("span", { children: selected.length === 0
                    ? "small multiples · biggest first"
                    : `${selected.length.toLocaleString()} typologies · small multiples` })] }));
}
