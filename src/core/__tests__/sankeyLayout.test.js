import { describe, expect, it } from "vitest";
import { buildStore } from "../model/build.ts";
import { rowLookup } from "../render/geometry.ts";
import { layoutSankey, ribbonPath, stickyOrder, subBand, } from "../render/sankeyLayout.ts";
import { buildSankey, pinKey } from "../stats/sankey.ts";
import { filteredSizes } from "../stats/silhouettes.ts";
import { buildTypologies } from "../stats/typologies.ts";
const patient = (id, trajectory) => ({
    id,
    trajectory,
    switchEventAge: trajectory.map((_, i) => 20 + i * 10),
    years: trajectory.map((_, i) => 2000 + i * 10),
    diseaseDuration: trajectory.length * 10,
});
/** `count` copies of one trajectory. */
const many = (prefix, count, trajectory) => Array.from({ length: count }, (_, i) => patient(`${prefix}${i}`, trajectory));
/** A few branching, merging and stopping flows over three steps. */
const cohort = () => buildStore([
    ...many("abc", 30, ["a", "b", "c"]),
    ...many("abd", 20, ["a", "b", "d"]),
    ...many("ae", 40, ["a", "e"]),
    ...many("ebc", 12, ["e", "b", "c"]),
    ...many("edd", 6, ["e", "d", "d"]),
    ...many("f", 1, ["f"]),
]);
const graphOf = (store) => {
    const typologies = buildTypologies(store);
    const mask = new Uint8Array(store.patientCount).fill(1);
    return buildSankey(typologies, filteredSizes(typologies, mask), store.stateNames.length);
};
/** States ranked by name, whatever order they were first seen in. */
const alphabetical = (store) => {
    const ids = store.stateNames.map((_, i) => i);
    ids.sort((a, b) => store.stateNames[a].localeCompare(store.stateNames[b]));
    return rowLookup(store.stateNames.length, ids);
};
/** The main view's constants, in a box big enough to hold everything. */
const optionsFor = (store, overrides = {}) => ({
    width: 800,
    height: 400,
    marginX: 8,
    marginTop: 30,
    marginBottom: 10,
    nodeWidth: 12,
    nodePadding: 10,
    minNodeHeight: 2,
    minLinkWidth: 1,
    minColumnGap: 96,
    order: "state",
    stateRank: alphabetical(store),
    keepOrder: null,
    ...overrides,
});
const EPSILON = 1e-5;
/** Every number the layout returns, for finiteness checks. */
const numbersOf = (layout) => [
    layout.columnGap,
    layout.scale,
    layout.contentWidth,
    layout.contentHeight,
    ...layout.nodes.flatMap((n) => [n.x0, n.x1, n.y0, n.y1]),
    ...layout.links.flatMap((l) => [l.x0, l.x1, l.sy0, l.ty0, l.width]),
    ...layout.columns.flatMap((c) => [c.x, c.size]),
];
/** Node indices per column, top to bottom. */
const columnsOf = (graph, layout) => Array.from({ length: graph.steps }, (_, step) => graph.nodes
    .filter((n) => n.step === step)
    .map((n) => n.index)
    .sort((a, b) => layout.nodes[a].y0 - layout.nodes[b].y0));
/** Inside the vertical extent, and no two boxes in a column closer than `gap`. */
const expectSound = (graph, layout, options, gap) => {
    expect(numbersOf(layout).every(Number.isFinite)).toBe(true);
    for (const box of layout.nodes) {
        expect(box.y0).toBeGreaterThanOrEqual(options.marginTop - EPSILON);
        expect(box.y1).toBeLessThanOrEqual(layout.contentHeight - options.marginBottom + EPSILON);
        expect(box.x0).toBeGreaterThanOrEqual(0);
        expect(box.x1).toBeLessThanOrEqual(layout.contentWidth + EPSILON);
    }
    for (const column of columnsOf(graph, layout)) {
        for (let i = 1; i < column.length; i++) {
            const above = layout.nodes[column[i - 1]];
            const below = layout.nodes[column[i]];
            expect(below.y0 - above.y1).toBeGreaterThanOrEqual(gap - EPSILON);
        }
    }
};
const stateAt = (store, graph) => (n) => store.stateNames[graph.nodes[n].state];
describe("sankey layout", () => {
    it("stacks each column in state-rank order, centred", () => {
        const store = cohort();
        const graph = graphOf(store);
        const options = optionsFor(store);
        const layout = layoutSankey(graph, options);
        expectSound(graph, layout, options, options.nodePadding);
        const names = columnsOf(graph, layout).map((column) => column.map(stateAt(store, graph)));
        expect(names).toEqual([["a", "e", "f"], ["b", "d", "e"], ["c", "d"]]);
        // Centred: the space above and below a column is shared equally.
        for (const column of columnsOf(graph, layout)) {
            const topGap = layout.nodes[column[0]].y0 - options.marginTop;
            const bottomGap = options.height - options.marginBottom - layout.nodes[column.at(-1)].y1;
            expect(topGap).toBeCloseTo(bottomGap);
        }
    });
    it("follows the state rank rather than the state id", () => {
        const store = cohort();
        const graph = graphOf(store);
        const reversed = store.stateNames.map((_, i) => i).reverse();
        const stateRank = rowLookup(store.stateNames.length, reversed);
        const layout = layoutSankey(graph, optionsFor(store, { stateRank }));
        const names = columnsOf(graph, layout).map((column) => column.map(stateAt(store, graph)));
        expect(names).toEqual([["f", "e", "a"], ["e", "d", "b"], ["d", "c"]]);
    });
    it("draws sizes to one scale, with minimums only below them", () => {
        const store = cohort();
        const graph = graphOf(store);
        const layout = layoutSankey(graph, optionsFor(store));
        expect(layout.scale).toBeGreaterThan(0);
        for (const link of graph.links) {
            expect(layout.links[link.index].width).toBeCloseTo(Math.max(link.size * layout.scale, 1));
        }
        for (const node of graph.nodes) {
            const box = layout.nodes[node.index];
            expect(box.y1 - box.y0).toBeGreaterThanOrEqual(node.size * layout.scale - EPSILON);
            expect(box.y1 - box.y0).toBeGreaterThanOrEqual(2 - EPSILON);
            expect(box.x1 - box.x0).toBe(12);
        }
    });
    it("uses the height: the tallest column fills it", () => {
        const store = cohort();
        const graph = graphOf(store);
        const options = optionsFor(store);
        const layout = layoutSankey(graph, options);
        const spans = columnsOf(graph, layout).map((column) => layout.nodes[column.at(-1)].y1 - layout.nodes[column[0]].y0);
        const tallest = Math.max(...spans);
        expect(tallest).toBeCloseTo(options.height - options.marginTop - options.marginBottom, 3);
        expect(layout.contentHeight).toBe(options.height);
    });
    it("stacks a node's out-links from its top, with the stop-here share below them", () => {
        const store = cohort();
        const graph = graphOf(store);
        const layout = layoutSankey(graph, optionsFor(store));
        const bySource = (a, b) => layout.links[a].sy0 - layout.links[b].sy0;
        const byTarget = (a, b) => layout.links[a].ty0 - layout.links[b].ty0;
        for (const node of graph.nodes) {
            const box = layout.nodes[node.index];
            const outs = [...graph.outgoing[node.index]].sort(bySource);
            let y = box.y0;
            for (const l of outs) {
                expect(layout.links[l].sy0).toBeCloseTo(y);
                y += layout.links[l].width;
            }
            expect(y + node.ends * layout.scale).toBeLessThanOrEqual(box.y1 + EPSILON);
            const ins = [...graph.incoming[node.index]].sort(byTarget);
            y = box.y0;
            for (const l of ins) {
                expect(layout.links[l].ty0).toBeCloseTo(y);
                y += layout.links[l].width;
            }
            expect(y).toBeLessThanOrEqual(box.y1 + EPSILON);
        }
    });
    it("orders out-links by where they land, so they leave a node without crossing", () => {
        const store = cohort();
        const graph = graphOf(store);
        const layout = layoutSankey(graph, optionsFor(store));
        const bySource = (a, b) => layout.links[a].sy0 - layout.links[b].sy0;
        for (const node of graph.nodes) {
            const outs = [...graph.outgoing[node.index]].sort(bySource);
            const targets = outs.map((l) => layout.nodes[graph.links[l].target].y0);
            expect(targets).toEqual([...targets].sort((a, b) => a - b));
        }
    });
    it("joins each band to its nodes' edges", () => {
        const store = cohort();
        const graph = graphOf(store);
        const layout = layoutSankey(graph, optionsFor(store));
        for (const link of graph.links) {
            expect(layout.links[link.index].x0).toBe(layout.nodes[link.source].x1);
            expect(layout.links[link.index].x1).toBe(layout.nodes[link.target].x0);
        }
        // Everyone at step 0; a-e and f stop before step 2.
        expect(layout.columns.map((c) => c.size)).toEqual([109, 108, 68]);
    });
    it("widens the content instead of squeezing columns past the minimum gap", () => {
        const store = cohort();
        const graph = graphOf(store);
        const layout = layoutSankey(graph, optionsFor(store, { width: 120 }));
        expect(layout.columnGap).toBe(96);
        expect(layout.contentWidth).toBe(8 * 2 + 12 + 96 * 2);
        expect(layout.columns.map((c) => c.x)).toEqual([8, 104, 200]);
    });
    it("spreads columns across the width when there is room", () => {
        const store = cohort();
        const graph = graphOf(store);
        const layout = layoutSankey(graph, optionsFor(store));
        expect(layout.contentWidth).toBe(800);
        expect(layout.columnGap).toBeCloseTo((800 - 16 - 12) / 2);
        expect(layout.nodes[graph.nodeAt(2, store.stateNames.indexOf("c"))].x1).toBeCloseTo(800 - 8);
    });
    it("reports each node's rank in its column", () => {
        const store = cohort();
        const graph = graphOf(store);
        const layout = layoutSankey(graph, optionsFor(store));
        columnsOf(graph, layout).forEach((column) => column.forEach((n, rank) => {
            const node = graph.nodes[n];
            expect(layout.order.get(pinKey({ kind: "node", step: node.step, state: node.state }))).toBe(rank);
        }));
        expect(layout.order.size).toBe(graph.nodes.length);
    });
    it("is deterministic", () => {
        const store = cohort();
        const graph = graphOf(store);
        expect(layoutSankey(graph, optionsFor(store))).toEqual(layoutSankey(graph, optionsFor(store)));
    });
});
describe("sankey layout, untangled", () => {
    /** a→d and b→c: in (alphabetical) state order the two flows cross. */
    const crossing = () => buildStore([...many("ad", 10, ["a", "d"]), ...many("bc", 10, ["b", "c"])]);
    it("stays in bounds and never overlaps", () => {
        const store = cohort();
        const graph = graphOf(store);
        const options = optionsFor(store, { order: "flow" });
        const layout = layoutSankey(graph, options);
        expectSound(graph, layout, options, options.nodePadding);
        // Every step is a column with something in it.
        expect(layout.columns).toHaveLength(graph.steps);
        for (const column of columnsOf(graph, layout))
            expect(column.length).toBeGreaterThan(0);
    });
    it("uncrosses flows the state order crosses", () => {
        const store = crossing();
        const graph = graphOf(store);
        const id = (name) => store.stateNames.indexOf(name);
        const y = (layout, step, name) => layout.nodes[graph.nodeAt(step, id(name))].y0;
        const byState = layoutSankey(graph, optionsFor(store));
        expect(y(byState, 0, "a") < y(byState, 0, "b")).not.toBe(y(byState, 1, "d") < y(byState, 1, "c"));
        const untangled = layoutSankey(graph, optionsFor(store, { order: "flow" }));
        expect(y(untangled, 0, "a") < y(untangled, 0, "b")).toBe(y(untangled, 1, "d") < y(untangled, 1, "c"));
    });
    it("is deterministic", () => {
        const store = cohort();
        const graph = graphOf(store);
        const options = optionsFor(store, { order: "flow" });
        expect(layoutSankey(graph, options)).toEqual(layoutSankey(graph, options));
    });
    it("keeps a given column order and only moves nodes within it", () => {
        const store = crossing();
        const graph = graphOf(store);
        const id = (name) => store.stateNames.indexOf(name);
        // Force the crossing order the relaxation would undo.
        const keepOrder = new Map([
            [pinKey({ kind: "node", step: 0, state: id("a") }), 0],
            [pinKey({ kind: "node", step: 0, state: id("b") }), 1],
            [pinKey({ kind: "node", step: 1, state: id("c") }), 0],
            [pinKey({ kind: "node", step: 1, state: id("d") }), 1],
        ]);
        const options = optionsFor(store, { order: "flow", keepOrder });
        const layout = layoutSankey(graph, options);
        expectSound(graph, layout, options, options.nodePadding);
        expect(layout.order).toEqual(keepOrder);
    });
    it("reproduces its own order when fed it back, even as sizes change", () => {
        const store = cohort();
        const graph = graphOf(store);
        const first = layoutSankey(graph, optionsFor(store, { order: "flow" }));
        // Drop the biggest typology, as a filter drag might: sizes change, the
        // order must not.
        const typologies = buildTypologies(store);
        const sizes = filteredSizes(typologies, new Uint8Array(store.patientCount).fill(1));
        sizes[typologies.findIndex((t) => t.key === "a-e")] = 5;
        const resized = buildSankey(typologies, sizes, store.stateNames.length);
        const again = layoutSankey(resized, optionsFor(store, { order: "flow", keepOrder: first.order }));
        expect(again.order).toEqual(first.order);
    });
    it("puts nodes the kept order has never seen after the ones it has", () => {
        const store = cohort();
        const graph = graphOf(store);
        const keepOrder = new Map([[pinKey({ kind: "node", step: 0, state: store.stateNames.indexOf("f") }), 0]]);
        const layout = layoutSankey(graph, optionsFor(store, { order: "flow", keepOrder }));
        expect(layout.order.get(pinKey({ kind: "node", step: 0, state: store.stateNames.indexOf("f") }))).toBe(0);
    });
});
describe("sankey layout, crowded", () => {
    /** Eight states in every column: the minimums alone need more than 20px. */
    const crowded = () => {
        const names = ["a", "b", "c", "d", "e", "f", "g", "h"];
        return buildStore(names.flatMap((first, i) => names.map((second, j) => {
            const third = names[(i + j) % names.length];
            return patient(`${first}${second}`, [first, second, third]);
        })));
    };
    it("overflows rather than dropping anything, with a scale that still encodes counts", () => {
        const store = crowded();
        const graph = graphOf(store);
        const options = optionsFor(store, { height: 60 });
        const layout = layoutSankey(graph, options);
        expect(layout.scale).toBeGreaterThan(0);
        expect(layout.contentHeight).toBeGreaterThan(options.height);
        expect(layout.nodes).toHaveLength(graph.nodes.length);
        expect(layout.links).toHaveLength(graph.links.length);
        // The padding shrank to its floor before the content grew.
        expectSound(graph, layout, options, 2);
        for (const node of graph.nodes) {
            const box = layout.nodes[node.index];
            expect(box.y1 - box.y0).toBeGreaterThanOrEqual(node.size * layout.scale - EPSILON);
        }
    });
    it("overflows soundly when untangled too", () => {
        const store = crowded();
        const graph = graphOf(store);
        const options = optionsFor(store, { height: 60, order: "flow" });
        const layout = layoutSankey(graph, options);
        expect(layout.contentHeight).toBeGreaterThan(options.height);
        expectSound(graph, layout, options, 2);
    });
    it("closes the gaps before overflowing when that is enough", () => {
        const store = crowded();
        const graph = graphOf(store);
        // Eight nodes of ≥ 8px (eight 1px links each) need 64px, plus 7 gaps.
        const options = optionsFor(store, { height: 30 + 10 + 64 + 7 * 4 });
        const layout = layoutSankey(graph, options);
        expect(layout.contentHeight).toBe(options.height);
        // Closed to the floor, not to the exact gap that fits the minimums.
        expectSound(graph, layout, options, 2);
        expect(layout.scale).toBeGreaterThan(0);
    });
    it("keeps a scale that encodes counts when it has to close the gaps", () => {
        // One state with 2,000 patients beside nineteen with 2: at the nominal 10px
        // padding the minimums alone overflow. Closing the gaps only as far as the
        // minimums need left no room for any scale, and drew the 2,000 as tall as
        // the 2s.
        const names = Array.from({ length: 20 }, (_, i) => `s${i}`);
        const store = buildStore([
            ...many("big", 2000, ["s0"]),
            ...names.slice(1).flatMap((name) => many(name, 2, [name])),
        ]);
        const graph = graphOf(store);
        const options = optionsFor(store, { height: 30 + 10 + 200 });
        const layout = layoutSankey(graph, options);
        expect(layout.contentHeight).toBe(options.height);
        expect(layout.scale).toBeGreaterThan(0);
        const big = graph.nodes.find((node) => node.size === 2000);
        const small = graph.nodes.find((node) => node.size === 2);
        const heightOf = (index) => layout.nodes[index].y1 - layout.nodes[index].y0;
        expect(heightOf(big.index)).toBeGreaterThan(20 * heightOf(small.index));
        expectSound(graph, layout, options, 2);
    });
});
describe("sticky column order", () => {
    const key = (step, state) => pinKey({ kind: "node", step, state });
    const order = (entries) => new Map(entries);
    const ranked = (map, step) => [...map.entries()]
        .filter(([k]) => k.split(":")[1] === String(step))
        .sort((a, b) => a[1] - b[1])
        .map(([k]) => k);
    it("keeps an emptied node's slot, so it comes back where it was", () => {
        const before = order([[key(1, 0), 0], [key(1, 1), 1], [key(1, 2), 2]]);
        // A filter emptied state 1 at step 1: the next layout only ranks the others.
        const emptied = order([[key(1, 0), 0], [key(1, 2), 1]]);
        const merged = stickyOrder(before, emptied);
        expect(ranked(merged, 1)).toEqual([key(1, 0), key(1, 1), key(1, 2)]);
    });
    it("takes the new layout's order for the nodes it has", () => {
        const before = order([[key(1, 0), 0], [key(1, 1), 1], [key(1, 2), 2]]);
        const swapped = order([[key(1, 2), 0], [key(1, 1), 1]]);
        // State 0 is absent and keeps the first slot; the present two are re-sequenced.
        expect(ranked(stickyOrder(before, swapped), 1)).toEqual([key(1, 0), key(1, 2), key(1, 1)]);
    });
    it("puts nodes never seen before last, and leaves other columns alone", () => {
        const before = order([[key(0, 3), 0], [key(1, 0), 0], [key(1, 1), 1]]);
        const next = order([[key(0, 3), 0], [key(1, 1), 0], [key(1, 5), 1]]);
        const merged = stickyOrder(before, next);
        expect(ranked(merged, 0)).toEqual([key(0, 3)]);
        expect(ranked(merged, 1)).toEqual([key(1, 0), key(1, 1), key(1, 5)]);
    });
    it("puts a returning node back between its neighbours under Untangle", () => {
        const store = cohort();
        const typologies = buildTypologies(store);
        const all = new Uint8Array(store.patientCount).fill(1);
        const stateCount = store.stateNames.length;
        const options = optionsFor(store, { order: "flow" });
        const full = buildSankey(typologies, filteredSizes(typologies, all), stateCount);
        const first = layoutSankey(full, options);
        // Empty the middle node of step 1 (state b: the a-b-c, a-b-d and e-b-c rows).
        const b = store.stateNames.indexOf("b");
        const without = new Uint8Array(all);
        for (const typology of typologies) {
            if (typology.states[1] === b)
                for (const p of typology.patients)
                    without[p] = 0;
        }
        const emptied = buildSankey(typologies, filteredSizes(typologies, without), stateCount);
        const second = layoutSankey(emptied, { ...options, keepOrder: first.order });
        const kept = stickyOrder(first.order, second.order);
        const third = layoutSankey(full, { ...options, keepOrder: kept });
        expect(ranked(third.order, 1)).toEqual(ranked(first.order, 1));
    });
});
describe("sankey layout, degenerate", () => {
    it("lays out an empty graph with finite fields", () => {
        const store = buildStore([patient("p1", ["a"])]);
        const empty = buildSankey([], new Uint32Array(), 0);
        for (const order of ["state", "flow"]) {
            const layout = layoutSankey(empty, optionsFor(store, { order }));
            expect(layout.nodes).toEqual([]);
            expect(layout.links).toEqual([]);
            expect(layout.columns).toEqual([]);
            expect(numbersOf(layout).every(Number.isFinite)).toBe(true);
        }
    });
    it("centres a single column", () => {
        const store = buildStore([...many("a", 3, ["a"]), ...many("b", 2, ["b"])]);
        const graph = graphOf(store);
        for (const order of ["state", "flow"]) {
            const options = optionsFor(store, { order });
            const layout = layoutSankey(graph, options);
            expect(numbersOf(layout).every(Number.isFinite)).toBe(true);
            expect(layout.links).toEqual([]);
            expect(layout.columns).toHaveLength(1);
            for (const box of layout.nodes)
                expect(box.x0).toBeCloseTo((800 - 12) / 2);
            expectSound(graph, layout, options, options.nodePadding);
        }
    });
    it("survives a box too small for anything", () => {
        const store = cohort();
        const graph = graphOf(store);
        const layout = layoutSankey(graph, optionsFor(store, { width: 0, height: 0 }));
        expect(numbersOf(layout).every(Number.isFinite)).toBe(true);
    });
});
describe("ribbons", () => {
    const band = { x0: 10, x1: 110, sy0: 20, ty0: 60, width: 8 };
    it("draws a closed shape between the two edges", () => {
        expect(ribbonPath(band)).toBe("M10,20C60,20 60,60 110,60L110,68C60,68 60,28 10,28Z");
    });
    it("takes the top share of a band, never more than the band", () => {
        for (const fraction of [0.001, 0.1, 0.5, 0.999, 1, 2]) {
            const sub = subBand(band, fraction);
            expect(sub.width).toBeLessThanOrEqual(band.width);
            expect(sub.sy0).toBe(band.sy0);
            expect(sub.ty0).toBe(band.ty0);
        }
        expect(subBand(band, 0.5).width).toBe(4);
        expect(subBand(band, 1)).toEqual(band);
    });
    it("keeps any trace visible, and no trace invisible", () => {
        expect(subBand(band, 0.001).width).toBe(1);
        expect(subBand(band, 0).width).toBe(0);
        expect(subBand(band, Number.NaN).width).toBe(0);
        // A band thinner than the floor is covered, not overdrawn.
        const thin = { ...band, width: 0.75 };
        expect(subBand(thin, 0.01).width).toBe(0.75);
    });
});
