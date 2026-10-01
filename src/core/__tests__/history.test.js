import { describe, expect, it } from "vitest";
import { emptyHistory, HISTORY_LIMIT, pushHistory, redo, sameSnapshot, snapshotOf, undo, } from "../query/history.ts";
const snap = (selectedTypologies, pathPrefix = [], selectedClusters = []) => ({ selectedTypologies, pathPrefix, selectedClusters });
describe("selection history", () => {
    it("records where the selection came from", () => {
        const history = pushHistory(emptyHistory, snap([]), snap(["a-b"]));
        expect(history.past).toEqual([snap([])]);
        expect(history.future).toEqual([]);
    });
    it("skips an action that changed nothing, returning the same history", () => {
        const history = pushHistory(emptyHistory, snap([]), snap(["a-b"]));
        expect(pushHistory(history, snap(["a-b"]), snap(["a-b"]))).toBe(history);
        // Picking the same typologies in a different order selects the same thing.
        expect(pushHistory(history, snap(["a", "b"]), snap(["b", "a"]))).toBe(history);
    });
    it("treats a different path as a change even over the same typologies", () => {
        // [a, b] and [b, a] are different paths through the tree.
        const history = pushHistory(emptyHistory, snap(["x"], [0, 1]), snap(["x"], [1, 0]));
        expect(history.past).toHaveLength(1);
        expect(sameSnapshot(snap([], [], [1, 2]), snap([], [], [2, 1]))).toBe(true);
        expect(sameSnapshot(snap([], [], [1]), snap([], [], [1, 2]))).toBe(false);
    });
    it("undoes and redoes, round trip", () => {
        let history = pushHistory(emptyHistory, snap([]), snap(["a"]));
        history = pushHistory(history, snap(["a"]), snap(["a", "b"]));
        const back = undo(history, snap(["a", "b"]));
        expect(back.snapshot).toEqual(snap(["a"]));
        const further = undo(back.history, back.snapshot);
        expect(further.snapshot).toEqual(snap([]));
        expect(undo(further.history, further.snapshot)).toBeNull();
        const forward = redo(further.history, further.snapshot);
        expect(forward.snapshot).toEqual(snap(["a"]));
        const again = redo(forward.history, forward.snapshot);
        expect(again.snapshot).toEqual(snap(["a", "b"]));
        expect(redo(again.history, again.snapshot)).toBeNull();
        expect(again.history.past).toEqual([snap([]), snap(["a"])]);
    });
    it("abandons the redo stack when a new change branches off", () => {
        let history = pushHistory(emptyHistory, snap([]), snap(["a"]));
        const back = undo(history, snap(["a"]));
        expect(back.history.future).toHaveLength(1);
        history = pushHistory(back.history, back.snapshot, snap(["c"]));
        expect(history.future).toEqual([]);
        expect(redo(history, snap(["c"]))).toBeNull();
    });
    it("keeps only the last HISTORY_LIMIT steps", () => {
        let history = emptyHistory;
        for (let i = 0; i < HISTORY_LIMIT + 10; i++) {
            history = pushHistory(history, snap([`t${i}`]), snap([`t${i + 1}`]));
        }
        expect(history.past).toHaveLength(HISTORY_LIMIT);
        expect(history.past[0]).toEqual(snap(["t10"]));
        expect(history.past.at(-1)).toEqual(snap([`t${HISTORY_LIMIT + 9}`]));
    });
    it("does nothing on an empty history", () => {
        expect(undo(emptyHistory, snap([]))).toBeNull();
        expect(redo(emptyHistory, snap([]))).toBeNull();
    });
    it("takes only the selection fields from a wider state", () => {
        const state = { ...snap(["a"], [1], [2]), view: "sankey", opacity: 0.5 };
        expect(snapshotOf(state)).toEqual(snap(["a"], [1], [2]));
    });
});
