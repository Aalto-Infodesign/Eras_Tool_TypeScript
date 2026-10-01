import { pinKey } from "../stats/sankey.ts";
const DEFAULT_ITERATIONS = 6;
/** Halvings of the scale interval: 2⁻³⁰ of the upper bound is well under a pixel. */
const BISECTION_STEPS = 30;
/** The padding a crowded column may shrink to before the content grows instead. */
const MIN_PADDING = 2;
/** d3-sankey's collision threshold: overlaps smaller than this are left alone. */
const COLLISION_EPSILON = 1e-6;
/** Stands in for a hidden state's rank, so it sorts after every visible one. */
const HIDDEN_RANK = Number.MAX_SAFE_INTEGER;
const finite = (value) => (Number.isFinite(value) ? Math.max(0, value) : 0);
function emptyLayout(width, height) {
    return {
        nodes: [],
        links: [],
        columns: [],
        columnGap: 0,
        scale: 0,
        contentWidth: width,
        contentHeight: height,
        order: new Map(),
    };
}
export function layoutSankey(graph, options) {
    const width = finite(options.width);
    const height = finite(options.height);
    const { nodes, links, steps } = graph;
    if (nodes.length === 0 || steps === 0)
        return emptyLayout(width, height);
    const marginX = finite(options.marginX);
    const marginTop = finite(options.marginTop);
    const marginBottom = finite(options.marginBottom);
    const nodeWidth = finite(options.nodeWidth);
    const nodePadding = finite(options.nodePadding);
    const minNodeHeight = finite(options.minNodeHeight);
    const minLinkWidth = finite(options.minLinkWidth);
    const iterations = Math.max(0, Math.floor(options.iterations ?? DEFAULT_ITERATIONS));
    // Columns: spread over the width, or the content widens past `minColumnGap`.
    const inner = Math.max(0, width - 2 * marginX - nodeWidth);
    let contentWidth = width;
    let columnGap;
    if (steps === 1) {
        columnGap = Math.max(0, (width - nodeWidth) / 2);
    }
    else {
        columnGap = inner / (steps - 1);
        const minColumnGap = finite(options.minColumnGap);
        if (columnGap < minColumnGap) {
            columnGap = minColumnGap;
            contentWidth = 2 * marginX + nodeWidth + columnGap * (steps - 1);
        }
    }
    const xOf = (step) => steps === 1 ? marginX + inner / 2 : marginX + step * columnGap;
    const columns = Array.from({ length: steps }, () => []);
    const columnSize = new Float64Array(steps);
    for (const node of nodes) {
        ;
        columns[node.step].push(node.index);
        columnSize[node.step] = columnSize[node.step] + node.size;
    }
    // The first column holds everyone, so it is always the largest.
    let maxColumnSize = 0;
    for (let k = 0; k < steps; k++)
        maxColumnSize = Math.max(maxColumnSize, columnSize[k]);
    const linkWidth = new Float64Array(links.length);
    const nodeHeight = new Float64Array(nodes.length);
    /*
     * A node must hold its in-links stacked, and its out-links stacked above its
     * stop-here share, so its height is the largest of those and of its own size
     * — which only differ once the minimums kick in.
     */
    const measure = (ky) => {
        for (const link of links)
            linkWidth[link.index] = Math.max(link.size * ky, minLinkWidth);
        for (const node of nodes) {
            let into = 0;
            for (const l of graph.incoming[node.index]) {
                into += linkWidth[l];
            }
            let out = node.ends * ky;
            for (const l of graph.outgoing[node.index]) {
                out += linkWidth[l];
            }
            nodeHeight[node.index] = Math.max(node.size * ky, minNodeHeight, into, out);
        }
    };
    const heightOf = (column, pad) => {
        let sum = Math.max(0, column.length - 1) * pad;
        for (const n of column)
            sum += nodeHeight[n];
        return sum;
    };
    const tallest = (pad) => {
        let max = 0;
        for (const column of columns)
            max = Math.max(max, heightOf(column, pad));
        return max;
    };
    const avail = Math.max(0, height - marginTop - marginBottom);
    const fits = (ky, pad) => {
        measure(ky);
        return tallest(pad) <= avail;
    };
    /*
     * The minimums alone overflow: close the gaps, straight down to MIN_PADDING.
     *
     * Not to the exact gap at which the minimums fit — that spends every spare
     * pixel on making them fit at a scale of zero, and the bisection below then
     * finds no room for any scale at all: every node at its minimum, a column of
     * ten thousand drawn as tall as one of ten. In a column crowded enough to
     * get here the gaps are the cheapest thing to give up.
     */
    let pad = nodePadding;
    if (!fits(0, pad))
        pad = Math.min(MIN_PADDING, nodePadding);
    /*
     * Column height is monotone in the scale, so the largest scale that fits is a
     * bisection. No column's patients can be drawn taller than the space, so
     * avail / maxColumnSize bounds it from above.
     *
     * If nothing fits even at zero, the minimums are the problem and no scale
     * fixes them: take the scale the largest column would have with no padding
     * and no minimums — so widths keep encoding counts — and let the content grow.
     */
    const upper = maxColumnSize > 0 ? avail / maxColumnSize : 0;
    let scale = 0;
    let overflow = false;
    if (!fits(0, pad)) {
        overflow = true;
        scale = Math.max(0, upper);
    }
    else if (fits(upper, pad)) {
        scale = upper;
    }
    else {
        let lo = 0;
        let hi = upper;
        for (let i = 0; i < BISECTION_STEPS; i++) {
            const mid = (lo + hi) / 2;
            if (fits(mid, pad))
                lo = mid;
            else
                hi = mid;
        }
        scale = lo;
    }
    measure(scale);
    const contentHeight = overflow ? marginTop + tallest(pad) + marginBottom : height;
    const top = marginTop;
    const bottom = contentHeight - marginBottom;
    // Order within each column: by state rank, or as kept.
    const rankOf = (state) => {
        const rank = state < options.stateRank.length ? options.stateRank[state] : -1;
        return rank >= 0 ? rank : HIDDEN_RANK;
    };
    const byState = (a, b) => {
        const left = nodes[a];
        const right = nodes[b];
        return rankOf(left.state) - rankOf(right.state) || left.state - right.state;
    };
    const keep = options.order === "flow" ? options.keepOrder : null;
    if (keep !== null) {
        // Nodes the kept order has never seen (a filter brought them back) go last.
        const keptRank = (n) => {
            const node = nodes[n];
            return keep.get(pinKey({ kind: "node", step: node.step, state: node.state })) ?? HIDDEN_RANK;
        };
        for (const column of columns)
            column.sort((a, b) => keptRank(a) - keptRank(b) || byState(a, b));
    }
    else {
        for (const column of columns)
            column.sort(byState);
    }
    const y0 = new Float64Array(nodes.length);
    const extent = bottom - top;
    if (options.order === "state") {
        // Stacked and centred: the padding is the only gap, so rows line up.
        for (const column of columns) {
            let y = top + (extent - heightOf(column, pad)) / 2;
            for (const n of column) {
                y0[n] = y;
                y += nodeHeight[n] + pad;
            }
        }
    }
    else {
        relax(graph, columns, {
            y0,
            nodeHeight,
            linkWidth,
            pad,
            top,
            bottom,
            iterations,
            keep: keep !== null,
            byState,
        });
    }
    // Links: stacked down each node's edges, in and out.
    const sy0 = new Float64Array(links.length);
    const ty0 = new Float64Array(links.length);
    for (const node of nodes) {
        // Out-links by where they land, so bands leaving a node do not cross each
        // other; whatever is left below them is the node's stop-here share.
        const outs = [...graph.outgoing[node.index]].sort((a, b) => {
            const ta = links[a].target;
            const tb = links[b].target;
            return y0[ta] - y0[tb] || byState(ta, tb);
        });
        let y = y0[node.index];
        for (const l of outs) {
            sy0[l] = y;
            y += linkWidth[l];
        }
        const ins = [...graph.incoming[node.index]].sort((a, b) => {
            const sa = links[a].source;
            const sb = links[b].source;
            return y0[sa] - y0[sb] || byState(sa, sb);
        });
        y = y0[node.index];
        for (const l of ins) {
            ty0[l] = y;
            y += linkWidth[l];
        }
    }
    const order = new Map();
    for (const column of columns) {
        column.forEach((n, rank) => {
            const node = nodes[n];
            order.set(pinKey({ kind: "node", step: node.step, state: node.state }), rank);
        });
    }
    return {
        nodes: nodes.map((node) => {
            const x0 = xOf(node.step);
            const top0 = y0[node.index];
            return { x0, x1: x0 + nodeWidth, y0: top0, y1: top0 + nodeHeight[node.index] };
        }),
        links: links.map((link) => ({
            x0: xOf(link.step) + nodeWidth,
            x1: xOf(link.step + 1),
            sy0: sy0[link.index],
            ty0: ty0[link.index],
            width: linkWidth[link.index],
        })),
        columns: columns.map((_, step) => ({ step, x: xOf(step), size: columnSize[step] })),
        columnGap,
        scale,
        contentWidth,
        contentHeight,
        order,
    };
}
/*
 * The `flow` order: a port of d3-sankey's `computeNodeBreadths` (d3-sankey,
 * ISC licence, © Mike Bostock), which is what the original drew with.
 *
 * Columns start spread over the extent in their initial order, as d3 spreads
 * them. Each iteration then relaxes right to left and left to right: every node
 * moves toward the size-weighted mean of where its neighbours would make its
 * links horizontal, by `alpha = 0.99^i`; each column is re-sorted by position
 * (unless the order is kept), and collisions are resolved outward from the
 * middle node by `beta`, which reaches 1 on the last pass — so the result never
 * overlaps and never leaves the extent when the columns fit it, which the scale
 * search guarantees. A fixed number of passes and a deterministic tie-break (the
 * state rank) make it reproducible.
 *
 * Two departures from d3: node heights are this layout's (minimums included),
 * not `value · ky`, and d3's `nodeSort` hook is replaced by `keep`, which is the
 * only custom order the chart needs.
 */
function relax(graph, columns, state) {
    const { y0, nodeHeight, linkWidth, pad, top, bottom, iterations, keep, byState } = state;
    const { links } = graph;
    const sourceOf = (l) => links[l].source;
    const targetOf = (l) => links[l].target;
    const sizeOf = (l) => links[l].size;
    // Initial breadths: stacked, then the free space shared out between the gaps.
    for (const column of columns) {
        let y = top;
        for (const n of column) {
            y0[n] = y;
            y += nodeHeight[n] + pad;
        }
        const gap = (bottom - y + pad) / (column.length + 1);
        column.forEach((n, i) => {
            y0[n] = y0[n] + gap * (i + 1);
        });
    }
    // Each node's links in the order they leave or arrive, by the other end's top.
    const outs = graph.outgoing.map((list) => [...list]);
    const ins = graph.incoming.map((list) => [...list]);
    const byTarget = (a, b) => y0[targetOf(a)] - y0[targetOf(b)] || a - b;
    const bySource = (a, b) => y0[sourceOf(a)] - y0[sourceOf(b)] || a - b;
    for (const list of outs)
        list.sort(byTarget);
    for (const list of ins)
        list.sort(bySource);
    const reorderNodeLinks = (n) => {
        for (const l of ins[n])
            outs[sourceOf(l)].sort(byTarget);
        for (const l of outs[n])
            ins[targetOf(l)].sort(bySource);
    };
    // The target top that would make the link source → target horizontal.
    const targetTop = (source, target) => {
        const leaving = outs[source];
        let y = y0[source] - ((leaving.length - 1) * pad) / 2;
        for (const l of leaving) {
            if (targetOf(l) === target)
                break;
            y += linkWidth[l] + pad;
        }
        for (const l of ins[target]) {
            if (sourceOf(l) === source)
                break;
            y -= linkWidth[l];
        }
        return y;
    };
    // The source top that would make the link source → target horizontal.
    const sourceTop = (source, target) => {
        const arriving = ins[target];
        let y = y0[target] - ((arriving.length - 1) * pad) / 2;
        for (const l of arriving) {
            if (sourceOf(l) === source)
                break;
            y += linkWidth[l] + pad;
        }
        for (const l of outs[source]) {
            if (targetOf(l) === target)
                break;
            y -= linkWidth[l];
        }
        return y;
    };
    const byY = (a, b) => y0[a] - y0[b] || byState(a, b);
    const move = (n, dy) => {
        y0[n] = y0[n] + dy;
    };
    // Push overlapping nodes down, from `y` at index `i`.
    const topToBottom = (column, start, from, alpha) => {
        let y = start;
        for (let i = from; i < column.length; i++) {
            const n = column[i];
            const dy = (y - y0[n]) * alpha;
            if (dy > COLLISION_EPSILON)
                move(n, dy);
            y = y0[n] + nodeHeight[n] + pad;
        }
    };
    // Push overlapping nodes up, from `y` at index `i`.
    const bottomToTop = (column, start, from, alpha) => {
        let y = start;
        for (let i = from; i >= 0; i--) {
            const n = column[i];
            const dy = (y0[n] + nodeHeight[n] - y) * alpha;
            if (dy > COLLISION_EPSILON)
                move(n, -dy);
            y = y0[n] - pad;
        }
    };
    const resolveCollisions = (column, alpha) => {
        if (column.length === 0)
            return;
        const i = column.length >> 1;
        const subject = column[i];
        const subjectTop = y0[subject];
        bottomToTop(column, subjectTop - pad, i - 1, alpha);
        topToBottom(column, subjectTop + nodeHeight[subject] + pad, i + 1, alpha);
        bottomToTop(column, bottom, column.length - 1, alpha);
        topToBottom(column, top, 0, alpha);
    };
    const settle = (column, beta) => {
        if (!keep)
            column.sort(byY);
        resolveCollisions(column, beta);
    };
    // Reposition each node from its incoming links.
    const relaxLeftToRight = (alpha, beta) => {
        for (let k = 1; k < columns.length; k++) {
            const column = columns[k];
            for (const target of column) {
                let y = 0;
                let w = 0;
                for (const l of ins[target]) {
                    const v = sizeOf(l);
                    y += targetTop(sourceOf(l), target) * v;
                    w += v;
                }
                if (!(w > 0))
                    continue;
                move(target, (y / w - y0[target]) * alpha);
                reorderNodeLinks(target);
            }
            settle(column, beta);
        }
    };
    // Reposition each node from its outgoing links.
    const relaxRightToLeft = (alpha, beta) => {
        for (let k = columns.length - 2; k >= 0; k--) {
            const column = columns[k];
            for (const source of column) {
                let y = 0;
                let w = 0;
                for (const l of outs[source]) {
                    const v = sizeOf(l);
                    y += sourceTop(source, targetOf(l)) * v;
                    w += v;
                }
                if (!(w > 0))
                    continue;
                move(source, (y / w - y0[source]) * alpha);
                reorderNodeLinks(source);
            }
            settle(column, beta);
        }
    };
    for (let i = 0; i < iterations; i++) {
        const alpha = Math.pow(0.99, i);
        const beta = Math.max(1 - alpha, (i + 1) / iterations);
        relaxRightToLeft(alpha, beta);
        relaxLeftToRight(alpha, beta);
    }
}
const round = (value) => Math.round(value * 100) / 100;
/**
 * A link as a filled shape: two horizontal cubic Béziers joined by vertical
 * edges.
 *
 * The original stroked a centre line at `strokeWidth = link.width` and filled it
 * with an `objectBoundingBox` gradient — which renders nothing on a perfectly
 * horizontal link (a zero-height box), hence its `addPathOffset` nudge. A closed
 * fill has a real box, keeps its width exact where it meets the nodes, and takes
 * a `userSpaceOnUse` gradient without tricks.
 */
export function ribbonPath(band) {
    const { x0, x1, sy0, ty0, width } = band;
    const xm = round((x0 + x1) / 2);
    const a = round(x0);
    const b = round(x1);
    const s0 = round(sy0);
    const t0 = round(ty0);
    const s1 = round(sy0 + width);
    const t1 = round(ty0 + width);
    const top = `M${a},${s0}C${xm},${s0} ${xm},${t0} ${b},${t0}`;
    const bottom = `L${b},${t1}C${xm},${t1} ${xm},${s1} ${a},${s1}Z`;
    return top + bottom;
}
/**
 * The top `fraction` of a band — a trace or a lit share drawn over it.
 *
 * A fraction of the *drawn* width, not `count · scale`: links are drawn at a
 * minimum width, so at the 250k scale most of them are wider than their count,
 * and a trace sized in patients would come out narrower than the very link it
 * traces. A fully traced link covers its band exactly; any trace at all is at
 * least a pixel (or the whole band, if that is thinner).
 */
export function subBand(band, fraction) {
    if (!(fraction > 0))
        return { ...band, width: 0 };
    if (fraction >= 1)
        return band;
    return { ...band, width: Math.max(Math.min(band.width, 1), band.width * fraction) };
}
/**
 * The kept column order, carried across a rebuild without forgetting anyone.
 *
 * A layout's `order` only ranks the nodes it has. Kept as is, a node that a
 * filter emptied mid-drag fell out of it, and when the drag brought it back it
 * was placed last in its column — its flows now crossing everything above it —
 * until the next move re-sorted. So the absent keep their slots: each column is
 * the previous list with the present nodes re-sequenced in the new layout's
 * order, and nodes never seen before go at the end, where the layout put them.
 */
export function stickyOrder(previous, next) {
    // Node keys are "n:step:state"; the step is the column.
    const columnOf = (key) => key.split(":")[1] ?? "";
    const byColumn = (order) => {
        const out = new Map();
        for (const key of order.keys()) {
            const column = columnOf(key);
            const list = out.get(column);
            if (list === undefined)
                out.set(column, [key]);
            else
                list.push(key);
        }
        for (const list of out.values()) {
            list.sort((a, b) => order.get(a) - order.get(b));
        }
        return out;
    };
    const before = byColumn(previous);
    const after = byColumn(next);
    const merged = new Map();
    for (const column of new Set([...before.keys(), ...after.keys()])) {
        const present = after.get(column) ?? [];
        const queue = present.values();
        const placed = new Set();
        const list = [];
        for (const key of before.get(column) ?? []) {
            if (next.has(key)) {
                const slot = queue.next();
                if (!slot.done) {
                    list.push(slot.value);
                    placed.add(slot.value);
                }
            }
            else {
                list.push(key);
            }
        }
        for (const key of present)
            if (!placed.has(key))
                list.push(key);
        list.forEach((key, rank) => merged.set(key, rank));
    }
    return merged;
}
