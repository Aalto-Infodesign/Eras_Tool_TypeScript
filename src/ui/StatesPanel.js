import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useMemo } from "react";
import { useEras } from "../app/store.ts";
import { buildPalette } from "../core/render/palette.ts";
import { ClusterStaleNotice } from "./ClusterStale.tsx";
import { Panel } from "./Panel.tsx";
/**
 * The state list: reorder the chart's rows, take states out, put them back.
 *
 * Ported from the original's `StateSelection`, minus the flowchart it also fed —
 * a top list of the states in play, draggable to reorder, each with a control to
 * remove it, and a bottom list of what has been removed with a control to
 * restore it.
 *
 * Reordering used to live here, and no longer does. It existed to make one
 * sequence read as a staircase in the shared frame, and the chart answers that
 * directly now: select a typology and it is drawn along *its own steps*. A
 * global order bent toward one sequence was always a compromise for the others,
 * and it could not express a repeated state at all.
 *
 * What is left is membership: take a state out of the dataset, or put it back.
 * The order is the ingest's, and removing a state no longer disturbs it — the
 * original recomputed `statesOrder` as `difference(statesNames, removedStates)`
 * whenever removals changed, so a state came back at the end rather than where
 * it was.
 *
 * Self-contained — it reads the store directly and takes no props, so the same
 * component drops into the side column later without changes.
 */
export function StatesPanel() {
    const store = useEras((s) => s.store);
    const stateOrder = useEras((s) => s.stateOrder);
    const removedStates = useEras((s) => s.filters.removedStates);
    const states = useEras((s) => s.states);
    const toggleRemovedState = useEras((s) => s.toggleRemovedState);
    const resetStates = useEras((s) => s.resetStates);
    const palette = useMemo(() => buildPalette(store?.stateNames.length ?? 0), [store?.stateNames.length]);
    const populationOf = useMemo(() => {
        const sizes = new Map(states.map((state) => [state.id, state.population]));
        return (state) => sizes.get(state) ?? 0;
    }, [states]);
    if (store === null || stateOrder.length === 0)
        return null;
    const removed = new Set(removedStates);
    const kept = stateOrder.filter((state) => !removed.has(state));
    // Shown in the order the list holds them, not in the order they were removed.
    const dropped = stateOrder.filter((state) => removed.has(state));
    const isModified = removedStates.length > 0;
    return (_jsxs(Panel, { title: "States", defaultOpen: true, className: "panel--states", count: _jsxs(_Fragment, { children: [kept.length, removedStates.length > 0 && _jsxs("em", { children: [" / ", stateOrder.length] })] }), children: [_jsx("p", { className: "states__hint", children: "Rows of the shared view. Remove one to splice it out of every trajectory." }), _jsx(ClusterStaleNotice, {}), _jsx("ul", { className: "states", children: kept.map((state, row) => (_jsxs("li", { className: "state", children: [_jsx("span", { className: "state__row", children: row }), _jsx("span", { className: "state__row", children: " \u00B7 " }), _jsx("span", { className: "state__name", style: { color: palette.css[state] }, title: store.stateNames[state], children: store.stateNames[state] }), _jsx("span", { className: "state__population", children: populationOf(state).toLocaleString() }), _jsx("span", { className: "state__controls", children: _jsx("button", { type: "button", className: "button button--tiny", title: "Remove this state from every trajectory", 
                                // The original guards the same way: the chart needs a row.
                                disabled: kept.length <= 1, onClick: () => toggleRemovedState(state), children: "\u2715" }) })] }, state))) }), dropped.length > 0 && (_jsxs(_Fragment, { children: [_jsx("p", { className: "states__hint states__hint--removed", children: "Spliced out; trajectories link across them." }), _jsx("ul", { className: "states states--removed", children: dropped.map((state) => (_jsxs("li", { className: "state state--removed", children: [_jsx("span", { className: "state__name", title: store.stateNames[state], children: store.stateNames[state] }), _jsx("span", { className: "state__population", children: populationOf(state).toLocaleString() }), _jsx("span", { className: "state__controls", children: _jsx("button", { type: "button", className: "button button--tiny", title: "Put this state back", onClick: () => toggleRemovedState(state), children: "+" }) })] }, state))) })] })), _jsx("button", { type: "button", className: "button", disabled: !isModified, onClick: resetStates, children: "Reset states" })] }));
}
