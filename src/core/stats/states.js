import { asState } from "../types.ts";
/**
 * Per-state population and position-frequency matrix, in one pass.
 *
 * Replaces `useStates`, which walked every patient's trajectory once per state
 * to build `otherStates` (O(patients × states × length)) and materialised a
 * `population` array holding a *reference to every patient object* per state —
 * so a 5-state dataset kept five full copies of the patient list alive.
 */
export function summariseStates(store) {
    const stateCount = store.stateNames.length;
    const slots = Math.max(1, store.extents.maxTrajectoryLength);
    const population = new Uint32Array(stateCount);
    // Flat [state][slot] matrix; one allocation instead of one array per state.
    const frequencies = new Uint32Array(stateCount * slots);
    // Guards against double-counting a state a patient visits more than once.
    const seenAt = new Int32Array(stateCount).fill(-1);
    for (let p = 0; p < store.patientCount; p++) {
        const start = store.offsets[p];
        const end = store.offsets[p + 1];
        for (let e = start; e < end; e++) {
            const s = store.stateIds[e];
            const slot = e - start;
            if (slot < slots) {
                const cell = s * slots + slot;
                frequencies[cell] = frequencies[cell] + 1;
            }
            if (seenAt[s] !== p) {
                seenAt[s] = p;
                population[s] = population[s] + 1;
            }
        }
    }
    const summaries = new Array(stateCount);
    for (let s = 0; s < stateCount; s++) {
        summaries[s] = {
            id: asState(s),
            name: store.stateNames[s],
            population: population[s],
            frequencies: frequencies.subarray(s * slots, (s + 1) * slots),
        };
    }
    return summaries;
}
/**
 * The vertical ordering of the chart: states sorted by how often they appear at
 * position 0, ties broken by position 1, and so on. Same result as the original
 * `dynamicSortLC`, but comparing typed-array slots instead of object lookups.
 */
export function orderStates(summaries) {
    return summaries
        .slice()
        .sort((a, b) => {
        const slots = Math.min(a.frequencies.length, b.frequencies.length);
        for (let i = 0; i < slots; i++) {
            const diff = b.frequencies[i] - a.frequencies[i];
            if (diff !== 0)
                return diff;
        }
        return a.name.localeCompare(b.name);
    })
        .map((s) => s.id);
}
