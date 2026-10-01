export function buildDurationMatrix(store, typology) {
    const n = typology.patients.length;
    if (n === 0)
        return null;
    // The last event of a trajectory has no transition after it, so a sequence of
    // `length` states yields `length - 1` durations.
    const d = typology.states.length - 1;
    if (d <= 0)
        return null;
    const rows = new Float32Array(n * d);
    /*
     * Copied, not aliased.
     *
     * A matrix is a *message payload*: `clusterClient` posts it with
     * `matrixTransferables`, which hands `patients.buffer` to the worker — and a
     * transferred buffer is detached on this side. Aliasing `typology.patients`
     * therefore emptied the membership list of every typology in the store the
     * moment a run started, which is to say immediately after every load.
     *
     * Nothing noticed for a while, because `size` is a plain number that survives
     * and every count in the UI reads that: the cards, the cluster table and the
     * path explorer all showed the right totals. Only *using* the membership
     * failed — `intersectTypologies` built its allow-list from zero indices, so
     * the first typology selection after a load selected nobody and drew nothing.
     * Reordering a state rebuilt the typologies and fixed it for the session,
     * which is what made it look like a rendering bug.
     *
     * A payload that is going to be transferred has to own its buffers.
     */
    const patients = typology.patients.slice();
    for (let i = 0; i < n; i++) {
        const p = patients[i];
        const start = store.offsets[p];
        const base = i * d;
        for (let k = 0; k < d; k++) {
            rows[base + k] = store.durations[start + k];
        }
    }
    return { typologyKey: typology.key, n, d, rows, patients };
}
/** Matrices for every typology, largest first — the order results stream in. */
export function buildDurationMatrices(store, typologies) {
    const matrices = [];
    for (const typology of typologies) {
        const matrix = buildDurationMatrix(store, typology);
        if (matrix !== null)
            matrices.push(matrix);
    }
    return matrices.sort((a, b) => b.n - a.n);
}
export function matrixTransferables(matrix) {
    return [matrix.rows.buffer, matrix.patients.buffer];
}
