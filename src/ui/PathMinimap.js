import { jsx as _jsx } from "react/jsx-runtime";
import { useEffect, useRef } from "react";
const PADDING = 6;
/** Anything not on the route and not reachable from it. */
const ELSEWHERE = "#8b93a7";
/** How a node relates to where you are standing. */
const OFF = 0;
const REACHABLE = 1;
const ON_PATH = 2;
/**
 * The whole tree at a glance, in the chart's colours, with the chosen paths lit.
 *
 * Canvas rather than SVG: a real dataset's tree runs to a few thousand nodes and
 * this is a texture, not a set of controls — nothing in it is clicked or
 * hovered, so there is no reason to pay for a DOM node per edge. It is the same
 * trade the stacked-lines diagram in the filter panel makes.
 *
 * Colour comes from the state a node was reached by, so the map reads against
 * the chart and the board rather than being a second, private encoding. Three
 * ranks carry the rest: off the route, still reachable from where you stand, and
 * the route itself — each brighter, thicker and larger than the last, so the
 * path is findable without hunting for a hue.
 *
 * The layout is the classic tidy tree in one dimension: depth sets x, and y is
 * assigned by walking the leaves in order and centring each parent over its
 * children. That is enough to make the shape of the cohort legible — a wide fan
 * where paths diverge, a long thin spine where everyone does the same thing.
 */
export function PathMinimap({ tree, frontier, width, height, palette }) {
    const canvasRef = useRef(null);
    useEffect(() => {
        const canvas = canvasRef.current;
        if (canvas === null || width === 0)
            return;
        const dpr = window.devicePixelRatio || 1;
        canvas.width = Math.max(1, Math.round(width * dpr));
        canvas.height = Math.max(1, Math.round(height * dpr));
        const ctx = canvas.getContext("2d");
        if (ctx === null)
            return;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, width, height);
        const { nodes } = tree;
        const layout = layoutTree(tree);
        const maxDepth = Math.max(1, layout.maxDepth);
        const usableX = Math.max(width - PADDING * 2, 1);
        const usableY = Math.max(height - PADDING * 2, 1);
        const slots = Math.max(1, layout.leaves);
        const px = (depth) => PADDING + (depth / maxDepth) * usableX;
        const py = (slot) => PADDING + ((slot + 0.5) / slots) * usableY;
        // Rank every node once: the routes taken (ancestors of the frontier, plus
        // it), then everything still reachable below it, then the rest. A step's
        // picked state that leads nowhere the next step allows is not on a route.
        const rank = new Uint8Array(nodes.length);
        const stack = [...frontier];
        while (stack.length > 0) {
            const id = stack.pop();
            rank[id] = REACHABLE;
            for (const child of nodes[id].children)
                stack.push(child);
        }
        for (const id of frontier) {
            let walk = id;
            // Routes share their ancestors; stop at the first one already lit.
            while (walk >= 0 && rank[walk] !== ON_PATH) {
                rank[walk] = ON_PATH;
                walk = nodes[walk].parent;
            }
        }
        /*
         * Batched by colour, not drawn per edge. There are a handful of states and a
         * few thousand edges, so one `Path2D` per (rank, state) turns thousands of
         * stroke calls into a dozen — the same reason the Canvas2D trajectory
         * backend groups its sub-paths by colour.
         */
        const edges = new Map();
        const dots = new Map();
        const key = (level, state) => `${level}:${state}`;
        const pathIn = (map, k) => {
            let path = map.get(k);
            if (path === undefined) {
                path = new Path2D();
                map.set(k, path);
            }
            return path;
        };
        const radius = [1.3, 2, 3.4];
        for (let id = 1; id < nodes.length; id++) {
            const node = nodes[id];
            const parent = nodes[node.parent];
            const level = rank[id];
            const k = key(level, node.state);
            const x = px(node.depth);
            const y = py(layout.slot[id]);
            const edge = pathIn(edges, k);
            edge.moveTo(px(parent.depth), py(layout.slot[parent.id]));
            edge.lineTo(x, y);
            const dot = pathIn(dots, k);
            dot.moveTo(x + radius[level], y);
            dot.arc(x, y, radius[level], 0, Math.PI * 2);
        }
        // Back to front, so the route is never buried under what it passed by.
        for (const level of [OFF, REACHABLE, ON_PATH]) {
            ctx.globalAlpha = level === OFF ? 0.3 : level === REACHABLE ? 0.65 : 1;
            ctx.lineWidth = level === ON_PATH ? 2.5 : 1;
            for (const [k, path] of edges) {
                const [rankText, stateText] = k.split(":");
                if (Number(rankText) !== level)
                    continue;
                // Off the route, hue would only compete with the part that matters.
                ctx.strokeStyle = level === OFF ? ELSEWHERE : palette[Number(stateText)] ?? ELSEWHERE;
                ctx.stroke(path);
            }
            for (const [k, path] of dots) {
                const [rankText, stateText] = k.split(":");
                if (Number(rankText) !== level)
                    continue;
                ctx.fillStyle = level === OFF ? ELSEWHERE : palette[Number(stateText)] ?? ELSEWHERE;
                ctx.fill(path);
            }
        }
        // Where you are standing: a ring on each route's end, so they read as
        // positions rather than as one more node of the paths they end.
        ctx.globalAlpha = 1;
        ctx.lineWidth = 1.5;
        for (const id of frontier) {
            const node = nodes[id];
            ctx.beginPath();
            ctx.arc(px(node.depth), py(layout.slot[id]), 5.5, 0, Math.PI * 2);
            ctx.strokeStyle = id === 0 ? ELSEWHERE : palette[node.state] ?? ELSEWHERE;
            ctx.stroke();
        }
    }, [tree, frontier, width, height, palette]);
    return (_jsx("canvas", { ref: canvasRef, className: "pathmap", style: { width, height }, role: "img", "aria-label": "Map of every path, with the chosen ones highlighted" }));
}
/**
 * Leaves get consecutive slots in depth-first order; a parent sits at the mean
 * of its children. One post-order pass, iterative so a pathological tree cannot
 * blow the stack.
 */
function layoutTree(tree) {
    const { nodes } = tree;
    const slot = new Float64Array(nodes.length);
    let nextLeaf = 0;
    let maxDepth = 0;
    // Post-order without recursion: push each node twice, and do the work the
    // second time, by which point its children have their slots.
    const stack = [{ id: 0, visited: false }];
    while (stack.length > 0) {
        const frame = stack.pop();
        const node = nodes[frame.id];
        if (!frame.visited) {
            if (node.depth > maxDepth)
                maxDepth = node.depth;
            if (node.children.length === 0) {
                slot[frame.id] = nextLeaf;
                nextLeaf += 1;
                continue;
            }
            stack.push({ id: frame.id, visited: true });
            // Reversed, so the stack pops them in their sorted order.
            for (let i = node.children.length - 1; i >= 0; i--) {
                stack.push({ id: node.children[i], visited: false });
            }
            continue;
        }
        let sum = 0;
        for (const child of node.children)
            sum += slot[child];
        slot[frame.id] = sum / node.children.length;
    }
    return { slot, leaves: Math.max(nextLeaf, 1), maxDepth };
}
