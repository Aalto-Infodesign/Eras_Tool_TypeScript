import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { memo, useMemo } from "react";
import { ribbonPath, subBand, } from "../core/render/sankeyLayout.ts";
import { pinKey, } from "../core/stats/sankey.ts";
/**
 * The Sankey's SVG, in layers that change on different clocks.
 *
 * `SankeyBase` is the flow itself — gradients, ribbons, stop-here tails and
 * nodes — and it is memoised on the graph and the layout alone, so pointing at
 * something never re-renders a single ribbon. The hover reading is
 * `SankeyOverlay`: a few dozen elements over it, all of them
 * `pointer-events: none`. An overlay that took pointer events would flicker in
 * a loop — the hovered ribbon's own trace appears under the pointer, carries no
 * key, clears the hover, disappears, and the base ribbon is hit again — which
 * is why only the base elements carry `data-key`, and why every chart layer
 * above the canvas in the Trajectories view is non-interactive too.
 * `SankeyLabels` goes on top of both, memoised like the base: a trace is drawn
 * at full strength, and under it the names it runs through would disappear.
 *
 * Dimming is one opacity per group (`[data-tracing]` in the stylesheet), as the
 * small multiples dim their hairlines: one style change and one composite, and
 * the base never re-renders to do it.
 */
/**
 * A ribbon's resting opacity, sqrt-ramped between these by its size — the
 * lumps' count ramp, for the same reason: fifty overlapping links at one alpha
 * turn into mud, while a ramp lets the big flows read as the structure and the
 * small ones as texture over it.
 */
const REST_OPACITY_MIN = 0.28;
const REST_OPACITY_MAX = 0.6;
/**
 * Ribbons thinner than this get an invisible stroke around them to aim at.
 * Links are painted largest first, so a thin one sits on top of its neighbours
 * and its margin wins — otherwise a one-pixel flow is a one-pixel target.
 */
const HIT_MARGIN_BELOW = 4;
const HIT_STROKE = 6;
/** How far the stop-here fade reaches out of a node's right edge. */
const TAIL_PX = 10;
const NODE_RADIUS = 1.5;
/** Label metrics at 10px monospace: the gap to the node, and the width of a character. */
const LABEL_GAP = 4;
const LABEL_CHAR_PX = 6;
/** Room kept clear between a label and the next column's nodes. */
const LABEL_RESERVE = 8;
/** Below this a name is a stub that says less than the colour already does. */
const LABEL_MIN_CHARS = 5;
/** The most of a name the last column's gutter makes room for. */
const LABEL_EDGE_CHARS = 16;
/** Below this a label is taller than the node it names. */
const LABEL_MIN_HEIGHT = 9;
/** The column headers' two lines, inside the layout's top margin. */
const HEADER_STEP_Y = 12;
const HEADER_COUNT_Y = 24;
const keyCache = new WeakMap();
/**
 * Every item's key, once per graph. The base, the overlay, the tween and the
 * hit test all need them, and a graph is rebuilt on every filter frame, so they
 * are cached against the graph itself rather than rebuilt by each reader.
 */
export function graphKeys(graph) {
    const cached = keyCache.get(graph);
    if (cached !== undefined)
        return cached;
    const keys = {
        nodes: graph.nodes.map((node) => pinKey({ kind: "node", step: node.step, state: node.state })),
        links: graph.links.map((link) => pinKey({
            kind: "link",
            step: link.step,
            source: graph.nodes[link.source].state,
            target: graph.nodes[link.target].state,
        })),
    };
    keyCache.set(graph, keys);
    return keys;
}
/** `useId` output is not a valid fragment identifier everywhere; this is. */
function safeId(uid) {
    return uid.replace(/[^A-Za-z0-9_-]/g, "");
}
function gradientId(uid, source, target) {
    return `${safeId(uid)}-flow-${source}-${target}`;
}
function tailGradientId(uid) {
    return `${safeId(uid)}-tail`;
}
/** A flow's fill: its two states' gradient, or the one colour when it stays put. */
function flowFill(uid, palette, source, target) {
    return source === target
        ? (palette.css[source] ?? "currentColor")
        : `url(#${gradientId(uid, source, target)})`;
}
function largestLink(graph) {
    let max = 0;
    for (const link of graph.links)
        max = Math.max(max, link.size);
    return max;
}
function restOpacity(size, max) {
    const t = max > 0 ? Math.sqrt(Math.min(1, size / max)) : 0;
    return REST_OPACITY_MIN + (REST_OPACITY_MAX - REST_OPACITY_MIN) * t;
}
function statesOf(graph, link) {
    return [
        graph.nodes[link.source].state,
        graph.nodes[link.target].state,
    ];
}
/** Every node box is the same width; 0 for an empty layout. */
function nodeWidthOf(layout) {
    const box = layout.nodes[0];
    return box === undefined ? 0 : box.x1 - box.x0;
}
/**
 * Where a node's stop-here share leaves it: below its out-links, at the bottom
 * of its right edge — which is where the layout leaves room for it. `null` for
 * nodes nobody stops at, and for the last column, where everyone stops and a
 * tail would say nothing.
 */
function tailOf(graph, layout, n) {
    const node = graph.nodes[n];
    const box = layout.nodes[n];
    if (box === undefined || node.ends === 0 || node.step >= graph.steps - 1)
        return null;
    let out = 0;
    for (const l of graph.outgoing[n])
        out += layout.links[l]?.width ?? 0;
    const top = Math.min(box.y0 + out, box.y1 - 1);
    return { x: box.x1, y: top, height: Math.max(1, box.y1 - top) };
}
/** A box shrunk to nothing at its own centre — where an entering item starts. */
export function collapsedBox(box) {
    const mid = (box.y0 + box.y1) / 2;
    return { ...box, y0: mid, y1: mid };
}
export function collapsedBand(band) {
    const half = band.width / 2;
    return { ...band, sy0: band.sy0 + half, ty0: band.ty0 + half, width: 0 };
}
/**
 * The flow at rest. See the file comment for why this never takes hover.
 *
 * Links are painted largest first, so thin flows sit on top of the thick ones
 * they cross and can still be pointed at. A stop-here tail is a fade in the
 * muted colour, not the node's own: *ends* is one category whatever the state,
 * and drawn in the state's colour it read as more of that state's flow.
 */
export const SankeyBase = memo(function SankeyBase({ graph, layout, palette, uid, mini, exiting, }) {
    const keys = graphKeys(graph);
    const paintOrder = useMemo(() => graph.links
        .map((link) => link.index)
        .sort((a, b) => graph.links[b].size - graph.links[a].size || a - b), [graph]);
    const maxLink = useMemo(() => largestLink(graph), [graph]);
    // One gradient per state pair that changes state, whatever the step: a
    // bounding-box gradient maps onto each ribbon's own span, and a filled
    // ribbon always has a real box, so the original's nudge is not needed.
    const pairs = useMemo(() => {
        const seen = new Set();
        const out = [];
        const add = (source, target) => {
            if (source === target)
                return;
            const id = `${source}-${target}`;
            if (seen.has(id))
                return;
            seen.add(id);
            out.push([source, target]);
        };
        for (const link of graph.links) {
            const [source, target] = statesOf(graph, link);
            add(source, target);
        }
        for (const link of exiting?.links ?? [])
            add(link.source, link.target);
        return out;
    }, [graph, exiting]);
    return (_jsxs("g", { className: "sankey__base", children: [_jsxs("defs", { children: [pairs.map(([source, target]) => (_jsxs("linearGradient", { id: gradientId(uid, source, target), x1: "0", x2: "1", y1: "0", y2: "0", children: [_jsx("stop", { offset: "0", stopColor: palette.css[source] ?? "currentColor" }), _jsx("stop", { offset: "1", stopColor: palette.css[target] ?? "currentColor" })] }, `${source}-${target}`))), _jsxs("linearGradient", { id: tailGradientId(uid), x1: "0", x2: "1", y1: "0", y2: "0", children: [_jsx("stop", { offset: "0", className: "sankey__tail-stop" }), _jsx("stop", { offset: "1", className: "sankey__tail-stop sankey__tail-stop--end" })] })] }), _jsxs("g", { className: "sankey__links", children: [exiting?.links.map((link) => (_jsx("path", { className: "sankey__link sankey__link--exiting", d: ribbonPath(link.band), fill: flowFill(uid, palette, link.source, link.target), fillOpacity: REST_OPACITY_MIN }, `exit-${link.key}`))), paintOrder.map((l) => {
                        const link = graph.links[l];
                        const band = layout.links[l];
                        if (band === undefined)
                            return null;
                        const [source, target] = statesOf(graph, link);
                        const key = keys.links[l];
                        const thin = !mini && band.width < HIT_MARGIN_BELOW;
                        return (_jsx("path", { className: "sankey__link", ...(mini ? {} : { "data-key": key }), d: ribbonPath(band), fill: flowFill(uid, palette, source, target), fillOpacity: restOpacity(link.size, maxLink), ...(thin ? { stroke: "transparent", strokeWidth: HIT_STROKE } : {}) }, key));
                    })] }), _jsx("g", { className: "sankey__ends", children: graph.nodes.map((node) => {
                    const tail = tailOf(graph, layout, node.index);
                    if (tail === null)
                        return null;
                    const key = keys.nodes[node.index];
                    return (_jsx("rect", { className: "sankey__tail", ...(mini ? {} : { "data-key": key }), x: tail.x, y: tail.y, width: TAIL_PX, height: tail.height, fill: `url(#${tailGradientId(uid)})` }, key));
                }) }), _jsxs("g", { className: "sankey__nodes", children: [exiting?.nodes.map((node) => (_jsx("rect", { className: "sankey__node sankey__node--exiting", x: node.box.x0, y: node.box.y0, width: node.box.x1 - node.box.x0, height: Math.max(0, node.box.y1 - node.box.y0), rx: NODE_RADIUS, fill: palette.css[node.state] ?? "currentColor" }, `exit-${node.key}`))), graph.nodes.map((node) => {
                        const box = layout.nodes[node.index];
                        if (box === undefined)
                            return null;
                        const key = keys.nodes[node.index];
                        return (_jsx("rect", { className: "sankey__node", ...(mini ? {} : { "data-key": key }), x: box.x0, y: box.y0, width: box.x1 - box.x0, height: Math.max(0, box.y1 - box.y0), rx: NODE_RADIUS, fill: palette.css[node.state] ?? "currentColor" }, key));
                    })] })] }));
});
/**
 * How much room to keep right of the last column for its names.
 *
 * Every name sits right of its node, the last column's included. Putting those
 * on the left instead — into the gap the column before already writes into —
 * had two names meeting head on wherever a state sat at the same height in both
 * columns ("gait_tremo…gait_tremor_problems"). A gutter the width of the
 * longest name, capped, keeps every column's labels in a gap of their own.
 */
export function labelGutter(stateNames) {
    let longest = 0;
    for (const name of stateNames)
        longest = Math.max(longest, name.length);
    return LABEL_GAP + Math.min(longest, LABEL_EDGE_CHARS) * LABEL_CHAR_PX + LABEL_GAP;
}
/**
 * State names beside their nodes, and a header per step — the reading the
 * original left to a legend beside the chart.
 *
 * Its own layer, on top of the overlay and memoised like the base: a trace is
 * drawn at full strength, and with the names underneath it the path being
 * traced would lose the very labels that say where it goes. Never hit-tested,
 * so a name over a ribbon does not steal the ribbon's hover.
 *
 * A name gets the gap to the next column and no more; past that it is cut with
 * an ellipsis, and a stub too short to say more than the colour already does is
 * left out — the tooltip always has the full name.
 */
export const SankeyLabels = memo(function SankeyLabels({ graph, layout, palette, stateNames, edgeRoom, }) {
    const keys = graphKeys(graph);
    const nodeWidth = nodeWidthOf(layout);
    const innerChars = Math.floor((layout.columnGap - nodeWidth - LABEL_GAP - LABEL_RESERVE) / LABEL_CHAR_PX);
    const edgeChars = Math.floor((edgeRoom - 2 * LABEL_GAP) / LABEL_CHAR_PX);
    return (_jsxs("g", { className: "sankey__text", children: [_jsx("g", { className: "sankey__labels", children: graph.nodes.map((node) => {
                    const box = layout.nodes[node.index];
                    if (box === undefined || box.y1 - box.y0 < LABEL_MIN_HEIGHT)
                        return null;
                    const chars = node.step === graph.steps - 1 ? edgeChars : innerChars;
                    if (chars < LABEL_MIN_CHARS)
                        return null;
                    const name = stateNames[node.state] ?? String(node.state);
                    const text = name.length > chars ? `${name.slice(0, chars - 1)}…` : name;
                    return (_jsx("text", { className: "sankey__label", x: box.x1 + LABEL_GAP, y: (box.y0 + box.y1) / 2, fill: palette.css[node.state] ?? "currentColor", children: text }, keys.nodes[node.index]));
                }) }), _jsx("g", { className: "sankey__columns", children: layout.columns.map((column) => {
                    const first = column.step === 0;
                    const last = column.step === layout.columns.length - 1 && layout.columns.length > 1;
                    // The outer columns align to the edge they sit on, so neither
                    // header hangs off the surface.
                    const x = first ? column.x : last ? column.x + nodeWidth : column.x + nodeWidth / 2;
                    const anchor = first ? "start" : last ? "end" : "middle";
                    return (_jsxs("text", { className: "sankey__column", x: x, textAnchor: anchor, children: [_jsxs("tspan", { className: "sankey__column-step", x: x, y: HEADER_STEP_Y, children: ["step ", column.step + 1] }), _jsx("tspan", { className: "sankey__column-count", x: x, y: HEADER_COUNT_Y, children: column.size.toLocaleString() })] }, column.step));
                }) })] }));
});
/**
 * Everything drawn *about* the flow: the duration filter's lit share, a trace,
 * and the outlines. Never hit-tested — see the file comment.
 *
 * Sizes are fractions of what is drawn, not counts times the scale: most links
 * are drawn at a minimum width, and a trace sized in patients would come out
 * thinner than the very link it traces (`subBand`).
 */
export function SankeyOverlay({ graph, layout, palette, uid, trace, traceTone, pinned, compare, hovered, inRange, }) {
    const maxLink = useMemo(() => largestLink(graph), [graph]);
    const accent = traceTone === "accent";
    const outline = (item, role) => {
        if (item.kind === "link") {
            const band = layout.links[item.index];
            if (band === undefined)
                return null;
            return (_jsx("path", { className: "sankey__mark", "data-role": role, d: ribbonPath(band) }, `${role}-l${item.index}`));
        }
        const box = layout.nodes[item.index];
        if (box === undefined)
            return null;
        return (_jsx("rect", { className: "sankey__mark", "data-role": role, x: box.x0 - 1, y: box.y0 - 1, width: box.x1 - box.x0 + 2, height: Math.max(0, box.y1 - box.y0) + 2, rx: NODE_RADIUS + 1 }, `${role}-n${item.index}`));
    };
    return (_jsxs("g", { className: "sankey__overlay", children: [inRange !== null && (_jsx("g", { className: "sankey__lit", children: graph.links.map((link) => {
                    const band = layout.links[link.index];
                    const lit = inRange[link.index] ?? 0;
                    if (band === undefined || lit === 0)
                        return null;
                    const [source, target] = statesOf(graph, link);
                    return (_jsx("path", { d: ribbonPath(subBand(band, lit / link.size)), fill: flowFill(uid, palette, source, target), fillOpacity: restOpacity(link.size, maxLink) }, link.index));
                }) })), trace !== null && (_jsxs("g", { className: "sankey__trace", "data-tone": traceTone, children: [graph.links.map((link) => {
                        const band = layout.links[link.index];
                        const traced = trace.links[link.index] ?? 0;
                        if (band === undefined || traced === 0)
                            return null;
                        const [source, target] = statesOf(graph, link);
                        return (_jsx("path", { d: ribbonPath(subBand(band, traced / link.size)), ...(accent ? {} : { fill: flowFill(uid, palette, source, target) }) }, `l${link.index}`));
                    }), graph.nodes.map((node) => {
                        const box = layout.nodes[node.index];
                        const traced = trace.nodes[node.index] ?? 0;
                        if (box === undefined || traced === 0)
                            return null;
                        const height = Math.max(0, box.y1 - box.y0);
                        return (_jsx("rect", { x: box.x0, y: box.y0, width: box.x1 - box.x0, height: Math.min(height, Math.max(1, (height * traced) / node.size)), rx: NODE_RADIUS, ...(accent ? {} : { fill: palette.css[node.state] ?? "currentColor" }) }, `n${node.index}`));
                    }), graph.nodes.map((node) => {
                        const tail = tailOf(graph, layout, node.index);
                        if (tail === null)
                            return null;
                        // Who of the traced stops here: everyone traced at the node minus
                        // everyone traced leaving it.
                        let leaving = 0;
                        for (const l of graph.outgoing[node.index]) {
                            leaving += trace.links[l] ?? 0;
                        }
                        const stopping = (trace.nodes[node.index] ?? 0) - leaving;
                        if (stopping <= 0)
                            return null;
                        return (_jsx("rect", { className: "sankey__trace-tail", x: tail.x, y: tail.y, width: TAIL_PX, height: Math.min(tail.height, Math.max(1, (tail.height * stopping) / node.ends)), fill: `url(#${tailGradientId(uid)})` }, `t${node.index}`));
                    })] })), _jsxs("g", { className: "sankey__marks", children: [hovered !== null && outline(hovered, "hovered"), compare !== null && outline(compare, "compare"), pinned !== null && outline(pinned, "pinned")] })] }));
}
