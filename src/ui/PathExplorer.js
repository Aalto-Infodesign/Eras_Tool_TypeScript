import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useEffect, useMemo, useState } from "react";
import { useEras } from "../app/store.ts";
import { buildPalette } from "../core/render/palette.ts";
import { buildPathTree, collectTypologies, findPath, } from "../core/stats/pathTree.ts";
import { filteredSizes } from "../core/stats/silhouettes.ts";
import { Modal } from "./Modal.tsx";
import { Panel } from "./Panel.tsx";
import { PathFlow } from "./PathFlow.tsx";
import { PathMinimap } from "./PathMinimap.tsx";
const MAP_HEIGHT = 150;
const MAP_HEIGHT_EXPANDED = 300;
/**
 * Walking the cohort forward one state at a time.
 *
 * The original had two separate answers to "what can follow what": a Hasse
 * diagram over a partial order of silhouettes, computed in its own worker, and
 * a React Flow board for drawing a sequence to ask whether anyone had lived it.
 * This is one answer to both, and the cheaper one — the typologies are already
 * the distinct sequences with their counts, so reading them as a prefix tree
 * costs a single pass and no library.
 *
 * Each step shows every state that was actually observed next, with how many
 * people took it. Choosing one narrows the chart to exactly those people, which
 * makes the "prediction" question fall out of the same control: if a step is not
 * offered, nobody in the cohort ever did it. You can stop anywhere — a prefix is
 * a selection in its own right — or walk to the end of a path.
 *
 * It lives in a dialog rather than in the side column. A step is a *row* of
 * alternatives and a walk is a sequence of steps, so the thing wants two axes;
 * folded into a 300px column it could only stack, which turned the one reading
 * that matters — this branch against its siblings — into scrolling. The panel
 * keeps the part that is genuinely a summary: where you are, and how much of the
 * cohort is left.
 */
export function PathExplorer() {
    const store = useEras((s) => s.store);
    const typologies = useEras((s) => s.typologies);
    const population = useEras((s) => s.population);
    const selectionVersion = useEras((s) => s.selectionVersion);
    const pathPrefix = useEras((s) => s.pathPrefix);
    const selectPath = useEras((s) => s.selectPath);
    const [isOpen, setIsOpen] = useState(false);
    const palette = useMemo(() => buildPalette(store?.stateNames.length ?? 0), [store?.stateNames.length]);
    /*
     * Counts come from `population` — the filters, but *not* the typology
     * narrowing the explorer itself performs. Reading them off `selection` would
     * make the tree describe its own last click: every branch but the chosen one
     * would drop to zero and the alternatives the panel exists to show would
     * vanish.
     */
    const tree = useMemo(() => {
        if (population === null || population.isEverything)
            return buildPathTree(typologies);
        const live = filteredSizes(typologies, population.mask);
        return buildPathTree(typologies, (i) => live[i]);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [typologies, population, selectionVersion]);
    const current = findPath(tree, pathPrefix);
    // A path can outlive the tree it was walked in — a reshape rebuilds the
    // typologies under it. The store drops it on a splice; this catches the rest.
    useEffect(() => {
        if (current === -1 && pathPrefix.length > 0)
            selectPath([]);
    }, [current, pathPrefix.length, selectPath]);
    if (store === null || typologies.length === 0 || current === -1)
        return null;
    const node = tree.nodes[current];
    const scoped = collectTypologies(tree, current);
    return (_jsxs(_Fragment, { children: [_jsxs(Panel, { title: "Path explorer", defaultOpen: true, count: _jsxs(_Fragment, { children: [pathPrefix.length > 0 && _jsx("em", { className: "panel__badge", children: pathPrefix.length }), node.size.toLocaleString()] }), children: [pathPrefix.length === 0 ? (_jsx("p", { className: "paths__hint", children: "Step through the cohort one state at a time, narrowing as you go." })) : (_jsxs(_Fragment, { children: [_jsx(PathFlow, { tree: tree, pathPrefix: pathPrefix, palette: palette.css, stateNames: store.stateNames, onStep: selectPath }), _jsxs("p", { className: "paths__hint", children: [node.size.toLocaleString(), " of ", tree.total.toLocaleString(), " \u00B7", " ", scoped.length.toLocaleString(), " typolog", scoped.length === 1 ? "y" : "ies"] }), _jsx(PathMinimap, { tree: tree, current: current, width: 300, height: MAP_HEIGHT, palette: palette.css })] })), _jsxs("div", { className: "paths__actions", children: [_jsx("button", { type: "button", className: "button", onClick: () => setIsOpen(true), children: "Explore \u2922" }), _jsx("button", { type: "button", className: "button button--tiny", disabled: pathPrefix.length === 0, title: "Back to the whole cohort", onClick: () => selectPath([]), children: "\u21BA" })] })] }), _jsx(Modal, { open: isOpen, title: "Path explorer", onClose: () => setIsOpen(false), toolbar: _jsxs("span", { className: "modal__note", children: [node.size.toLocaleString(), " of ", tree.total.toLocaleString(), " patients \u00B7", " ", scoped.length.toLocaleString(), " typologies"] }), children: _jsx(PathBoard, { tree: tree, pathPrefix: pathPrefix, current: current, palette: palette, stateNames: store.stateNames, onStep: selectPath }) })] }));
}
/**
 * The walk, laid out along its two real axes: one column per step taken, each
 * column holding that step's alternatives.
 *
 * Every level stays on screen, so what you *excluded* by stepping is as visible
 * as what you chose and going back is one click rather than a reset.
 */
function PathBoard({ tree, pathPrefix, current, palette, stateNames, onStep, }) {
    const [width, setWidth] = useState(900);
    const [host, setHost] = useState(null);
    useEffect(() => {
        if (host === null)
            return;
        const observer = new ResizeObserver(([entry]) => {
            const next = entry?.contentRect.width;
            if (next !== undefined)
                setWidth((value) => (value === next ? value : next));
        });
        observer.observe(host);
        return () => observer.disconnect();
    }, [host]);
    const node = tree.nodes[current];
    /** One column per step taken, plus the open step at the end. */
    const levels = [];
    for (let depth = 0; depth <= pathPrefix.length; depth++) {
        const parent = tree.nodes[findPath(tree, pathPrefix.slice(0, depth))];
        if (parent.children.length === 0)
            break;
        levels.push({ parent, chosen: depth < pathPrefix.length ? pathPrefix[depth] : -1 });
    }
    const step = (depth, state) => {
        // Clicking the state you are already on at this level steps back off it.
        onStep(pathPrefix[depth] === state
            ? pathPrefix.slice(0, depth)
            : [...pathPrefix.slice(0, depth), state]);
    };
    return (_jsxs("div", { className: "board", ref: setHost, children: [_jsx("div", { className: "board__flow", children: _jsx(PathFlow, { tree: tree, pathPrefix: pathPrefix, palette: palette.css, stateNames: stateNames, onStep: onStep, showCounts: true }) }), _jsxs("div", { className: "board__columns", children: [levels.map(({ parent, chosen }, depth) => (_jsxs("section", { className: "board__column", children: [_jsxs("header", { className: "board__column-head", children: [_jsxs("span", { children: ["Step ", depth + 1] }), _jsxs("span", { className: "board__column-count", children: [parent.children.length, " options"] })] }), _jsx("ul", { className: "board__options", children: parent.children.map((childId) => {
                                    const child = tree.nodes[childId];
                                    const isChosen = child.state === chosen;
                                    const share = parent.size === 0 ? 0 : (child.size / parent.size) * 100;
                                    return (_jsx("li", { children: _jsxs("button", { type: "button", className: "board__option", "data-chosen": isChosen, "data-dimmed": chosen !== -1 && !isChosen, "data-empty": child.size === 0, "aria-pressed": isChosen, title: isChosen ? "Step back off this state" : `${child.size} continue this way`, onClick: () => step(depth, child.state), children: [_jsx("span", { className: "paths__swatch", style: { background: palette.css[child.state] }, "aria-hidden": "true" }), _jsx("span", { className: "board__name", children: stateNames[child.state] }), _jsxs("span", { className: "board__count", children: [child.size.toLocaleString(), _jsxs("em", { children: [share.toFixed(0), "%"] })] }), child.ends > 0 && (_jsxs("span", { className: "board__ends", title: `${child.ends} stop here`, children: ["\u25CD ", child.ends.toLocaleString()] })), _jsx("span", { className: "board__bar", style: { width: `${share}%` }, "aria-hidden": "true" })] }) }, childId));
                                }) })] }, parent.id))), node.children.length === 0 && (_jsxs("section", { className: "board__column board__column--end", children: [_jsx("header", { className: "board__column-head", children: _jsx("span", { children: "End" }) }), _jsxs("p", { className: "paths__hint paths__hint--end", children: [node.ends.toLocaleString(), " trajectories finish here."] })] }))] }), _jsx("footer", { className: "board__map", children: _jsx(PathMinimap, { tree: tree, current: current, width: width, height: MAP_HEIGHT_EXPANDED, palette: palette.css }) })] }));
}
