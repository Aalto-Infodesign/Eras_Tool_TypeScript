/**
 * Removes states from the dataset itself, rather than from the drawing of it.
 *
 * Removing a state in the original is not a filter — `DerivedDataContext`
 * splices the state out of every record and then re-derives *everything* from
 * the result: trajectories, silhouettes, analytics, the filter ranges. A state
 * removed there is a state that was never in the data, so typologies merge,
 * populations drop and the axes rescale. Masking it at the render layer would
 * have left all of those answering the old question.
 *
 * So this returns a whole new store, and the caller re-runs the aggregate passes
 * over it exactly as the ingest worker does.
 *
 * Two invariants make that affordable and safe:
 *
 * **Patient indices never move.** A patient left with no events keeps its row,
 * with `offsets[p] === offsets[p + 1]`. Everything in the app addresses patients
 * by index — the selection mask, hover, the typology membership lists — and
 * compacting the rows would invalidate all of it at once. `buildStore` drops
 * empty trajectories because nothing points at them yet; here things do.
 *
 * **The state vocabulary never moves either.** `stateNames` is carried over
 * whole, including the removed states, so palette colours stay put and the ids
 * held in `removedStates` keep meaning the same thing when a state is restored.
 * A removed state is simply one with no events left.
 */
/**
 * Patients that still have a trajectory.
 *
 * `patientCount` is the number of *rows*, which a splice deliberately never
 * changes so that indices stay valid. It is therefore the wrong number to show
 * anyone: after removing a state it still counts people whose whole path was
 * made of it. This is the cohort as the user would count it, and it is what the
 * original arrived at by dropping emptied records outright.
 */
export function countLivePatients(store) {
    let live = 0;
    for (let p = 0; p < store.patientCount; p++) {
        if (store.offsets[p + 1] > store.offsets[p])
            live += 1;
    }
    return live;
}
export function spliceStates(store, removed) {
    // Pass 1 — size the output.
    const offsets = new Uint32Array(store.patientCount + 1);
    let kept = 0;
    for (let p = 0; p < store.patientCount; p++) {
        offsets[p] = kept;
        const start = store.offsets[p];
        const end = store.offsets[p + 1];
        for (let e = start; e < end; e++) {
            if (removed[store.stateIds[e]] !== 1)
                kept += 1;
        }
    }
    offsets[store.patientCount] = kept;
    const stateIds = new Uint16Array(kept);
    const ages = new Float32Array(kept);
    const years = new Float32Array(kept);
    const durations = new Float32Array(kept);
    const eventPatient = new Uint32Array(kept);
    let minAge = Infinity;
    let maxAge = -Infinity;
    let minYear = Infinity;
    let maxYear = -Infinity;
    let minDuration = Infinity;
    let maxDuration = -Infinity;
    let minDisease = Infinity;
    let maxDisease = -Infinity;
    let maxTrajectoryLength = 0;
    // Pass 2 — copy the survivors and re-derive everything that depended on them.
    for (let p = 0; p < store.patientCount; p++) {
        const start = store.offsets[p];
        const end = store.offsets[p + 1];
        const outStart = offsets[p];
        let out = outStart;
        for (let e = start; e < end; e++) {
            const state = store.stateIds[e];
            if (removed[state] === 1)
                continue;
            const age = store.ages[e];
            const year = store.years[e];
            stateIds[out] = state;
            ages[out] = age;
            years[out] = year;
            eventPatient[out] = p;
            out += 1;
            if (age < minAge)
                minAge = age;
            if (age > maxAge)
                maxAge = age;
            if (year < minYear)
                minYear = year;
            if (year > maxYear)
                maxYear = year;
        }
        const length = out - outStart;
        if (length > maxTrajectoryLength)
            maxTrajectoryLength = length;
        // A patient with nothing left is invisible, so it should not hold the
        // disease-duration axis open either.
        if (length > 0) {
            const dd = store.diseaseDuration[p];
            if (dd < minDisease)
                minDisease = dd;
            if (dd > maxDisease)
                maxDisease = dd;
        }
        /*
         * Durations are recomputed, not copied: the gap between two events that are
         * now adjacent is the gap across whatever was removed between them. This is
         * what makes the duration filter judge the trajectory that exists rather
         * than the one that used to.
         */
        for (let i = outStart; i < out - 1; i++) {
            const a = years[i];
            const b = years[i + 1];
            const d = b > a ? b - a : a - b;
            durations[i] = d;
            if (d < minDuration)
                minDuration = d;
            if (d > maxDuration)
                maxDuration = d;
        }
        if (length > 0)
            durations[out - 1] = 0;
    }
    if (minDuration > 0)
        minDuration = 0;
    const extents = {
        age: kept > 0 ? [minAge, maxAge] : [0, 0],
        year: kept > 0 ? [minYear, maxYear] : [0, 0],
        duration: kept > 0 ? [Math.min(0, minDuration), Math.max(0, maxDuration)] : [0, 0],
        diseaseDuration: Number.isFinite(minDisease) ? [minDisease, maxDisease] : [0, 0],
        maxTrajectoryLength,
    };
    return {
        patientCount: store.patientCount,
        eventCount: kept,
        // Patient-level columns are untouched: same rows, same order, so they are
        // shared rather than copied.
        ids: store.ids,
        diseaseDuration: store.diseaseDuration,
        offsets,
        stateIds,
        ages,
        years,
        durations,
        eventPatient,
        stateNames: store.stateNames,
        extents,
    };
}
