import { describe, expect, it } from "vitest";
import { buildStore } from "../model/build.ts";
import { buildPathTree, collectTypologies, effectiveSteps, findPath, matchesSteps, normalizeSteps, pathOf, toggleStep, walkSteps, } from "../stats/pathTree.ts";
import { buildTypologies } from "../stats/typologies.ts";
const patient = (id, trajectory) => ({
    id,
    trajectory,
    switchEventAge: trajectory.map((_, i) => 20 + i * 10),
    years: trajectory.map((_, i) => 2000 + i * 10),
    diseaseDuration: trajectory.length * 10,
});
/** a-b-c ×3, a-b-d ×2, a-e ×4, f ×1 */
const cohort = () => buildStore([
    patient("p1", ["a", "b", "c"]),
    patient("p2", ["a", "b", "c"]),
    patient("p3", ["a", "b", "c"]),
    patient("p4", ["a", "b", "d"]),
    patient("p5", ["a", "b", "d"]),
    patient("p6", ["a", "e"]),
    patient("p7", ["a", "e"]),
    patient("p8", ["a", "e"]),
    patient("p9", ["a", "e"]),
    patient("p10", ["f"]),
]);
const build = () => {
    const store = cohort();
    const tree = buildPathTree(buildTypologies(store));
    return { tree, id: (name) => store.stateNames.indexOf(name) };
};
describe("path tree", () => {
    it("counts everyone who starts with a prefix, not just who ends there", () => {
        const { tree, id } = build();
        const a = tree.nodes[findPath(tree, [id("a")])];
        expect(a.size).toBe(9); // 3 + 2 + 4
        expect(a.ends).toBe(0); // nobody's trajectory is just "a"
        const ab = tree.nodes[findPath(tree, [id("a"), id("b")])];
        expect(ab.size).toBe(5);
        expect(tree.total).toBe(10);
    });
    it("records where a trajectory stops", () => {
        const { tree, id } = build();
        const ae = tree.nodes[findPath(tree, [id("a"), id("e")])];
        expect(ae.ends).toBe(4);
        expect(ae.terminal).toBe("a-e");
        expect(ae.children).toEqual([]);
    });
    it("offers the biggest branch first", () => {
        const { tree, id } = build();
        const a = tree.nodes[findPath(tree, [id("a")])];
        // a-e (4) outranks a-b (5's subtree splits, but a-b itself is 5)… a-b wins.
        expect(a.children.map((c) => tree.nodes[c].size)).toEqual([5, 4]);
    });
    it("scopes to every typology under a node", () => {
        const { tree, id } = build();
        expect(collectTypologies(tree, findPath(tree, [id("a"), id("b")])).sort()).toEqual([
            "a-b-c",
            "a-b-d",
        ]);
        expect(collectTypologies(tree, findPath(tree, [id("a")])).sort()).toEqual([
            "a-b-c",
            "a-b-d",
            "a-e",
        ]);
        expect(collectTypologies(tree, 0)).toHaveLength(4);
    });
    it("reports a path that does not exist", () => {
        const { tree, id } = build();
        expect(findPath(tree, [id("a"), id("f")])).toBe(-1);
    });
    it("reads a node's path back", () => {
        const { tree, id } = build();
        const node = findPath(tree, [id("a"), id("b"), id("c")]);
        expect(pathOf(tree, node)).toEqual([id("a"), id("b"), id("c")]);
        expect(pathOf(tree, 0)).toEqual([]);
    });
    it("keeps an emptied branch in the tree at size zero", () => {
        // A filter that removes every a-e patient must not delete the branch: the
        // path still exists in the data, and a silently missing option reads as
        // "nobody ever did this" rather than "nobody here did this".
        const store = cohort();
        const typologies = buildTypologies(store);
        const tree = buildPathTree(typologies, (i) => (typologies[i].key === "a-e" ? 0 : typologies[i].size));
        const ae = findPath(tree, [store.stateNames.indexOf("a"), store.stateNames.indexOf("e")]);
        expect(ae).not.toBe(-1);
        expect(tree.nodes[ae].size).toBe(0);
        expect(tree.total).toBe(6);
    });
    it("matches sequences by prefix", () => {
        expect(matchesSteps(Uint16Array.of(1, 2, 3), [1, 2])).toBe(true);
        expect(matchesSteps(Uint16Array.of(1, 2, 3), [1, 2, 3])).toBe(true);
        expect(matchesSteps(Uint16Array.of(1, 2), [1, 2, 3])).toBe(false);
        expect(matchesSteps(Uint16Array.of(1, 2, 3), [2])).toBe(false);
        expect(matchesSteps(Uint16Array.of(1, 2, 3), [])).toBe(true);
    });
});
describe("walking a path", () => {
    it("reaches one node per step, root first", () => {
        const { tree, id } = build();
        const nodes = walkSteps(tree, [id("a"), id("b")]);
        expect(nodes).toHaveLength(3);
        expect(nodes[0]).toBe(0);
        expect(nodes.at(-1)).toBe(findPath(tree, [id("a"), id("b")]));
        expect(collectTypologies(tree, nodes.at(-1)).sort()).toEqual(["a-b-c", "a-b-d"]);
    });
    it("stops short at a step the tree does not have", () => {
        const { tree, id } = build();
        expect(walkSteps(tree, [id("f"), id("e")])).toEqual([0, findPath(tree, [id("f")])]);
    });
    it("takes a step, and steps back when the pick is clicked again", () => {
        expect(toggleStep([1], 1, 3)).toEqual([1, 3]);
        expect(toggleStep([1, 3], 1, 3)).toEqual([1]);
        // Dropping an earlier pick drops everything after it.
        expect(toggleStep([1, 2, 3], 0, 1)).toEqual([]);
    });
    it("swaps an earlier step and keeps the later ones", () => {
        expect(toggleStep([1, 2, 3], 1, 5)).toEqual([1, 5, 3]);
    });
    it("cuts the walk where a swapped step strands what followed", () => {
        const { tree, id } = build();
        // e only ever follows a; f leads nowhere, so after f the walk ends.
        expect(normalizeSteps(tree, [id("f"), id("e")])).toEqual([id("f")]);
        // Already valid: handed back as-is, so callers can compare by reference.
        const valid = [id("a"), id("e")];
        expect(normalizeSteps(tree, valid)).toBe(valid);
    });
    it("reads a saved path through the removed states", () => {
        const steps = [1, 2, 3];
        expect(effectiveSteps(steps, new Set([2]))).toEqual([1, 3]);
        // Untouched by the removal: the same array back.
        expect(effectiveSteps(steps, new Set([7]))).toBe(steps);
    });
});
