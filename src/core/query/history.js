export const emptyHistory = { past: [], future: [] };
/**
 * Steps kept. Snapshots share their arrays with the store rather than copying
 * them, so even a path selection naming thousands of typologies costs a
 * reference per entry.
 */
export const HISTORY_LIMIT = 50;
/** Just the selection fields — pass the store's state straight in. */
export function snapshotOf(state) {
    return {
        selectedTypologies: state.selectedTypologies,
        pathSteps: state.pathSteps,
        activeExpectations: state.activeExpectations,
        selectedClusters: state.selectedClusters,
    };
}
const sameSet = (a, b) => {
    if (a === b)
        return true;
    if (a.length !== b.length)
        return false;
    const set = new Set(a);
    return b.every((value) => set.has(value));
};
/** Step by step: a path is ordered. */
const sameSteps = (a, b) => a === b || (a.length === b.length && a.every((state, i) => state === b[i]));
/**
 * Whether two snapshots select the same thing. Typologies, expectations and
 * clusters compare as sets — the order they were picked in is invisible — and
 * the path steps as a sequence.
 */
export function sameSnapshot(a, b) {
    return (sameSet(a.selectedTypologies, b.selectedTypologies) &&
        sameSteps(a.pathSteps, b.pathSteps) &&
        sameSet(a.activeExpectations, b.activeExpectations) &&
        sameSet(a.selectedClusters, b.selectedClusters));
}
/**
 * Records that the selection went from `previous` to `next`.
 *
 * Returns `history` itself when nothing changed, so a caller can skip the
 * write; otherwise pushes `previous`, drops the oldest entry past
 * `HISTORY_LIMIT`, and clears the redo stack, since a new branch abandons it.
 */
export function pushHistory(history, previous, next) {
    if (sameSnapshot(previous, next))
        return history;
    const past = [...history.past, snapshotOf(previous)];
    return { past: past.length > HISTORY_LIMIT ? past.slice(-HISTORY_LIMIT) : past, future: [] };
}
/** Steps back from `current`, which becomes the first thing redo restores. */
export function undo(history, current) {
    const snapshot = history.past[history.past.length - 1];
    if (snapshot === undefined)
        return null;
    return {
        snapshot,
        history: { past: history.past.slice(0, -1), future: [snapshotOf(current), ...history.future] },
    };
}
/** Steps forward from `current`, which goes back on the undo stack. */
export function redo(history, current) {
    const snapshot = history.future[0];
    if (snapshot === undefined)
        return null;
    const past = [...history.past, snapshotOf(current)];
    return {
        snapshot,
        history: {
            past: past.length > HISTORY_LIMIT ? past.slice(-HISTORY_LIMIT) : past,
            future: history.future.slice(1),
        },
    };
}
