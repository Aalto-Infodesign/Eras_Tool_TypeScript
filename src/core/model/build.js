import { IdColumn } from "./IdColumn.ts";
import { StateVocabulary } from "./StateVocabulary.ts";
/**
 * Builds the columnar store from parsed records in two passes:
 *   1. count events and intern state labels, so every buffer is allocated once
 *      at its final size (no `push`, no array growth, no rehashing);
 *   2. fill the buffers.
 *
 * The old pipeline instead allocated one object per link plus two nested
 * `source`/`target` objects, i.e. ~3 allocations per event. At 1M events that is
 * 3M short-lived objects and the GC pauses that come with them.
 */
export function buildStore(records) {
    const vocab = new StateVocabulary();
    // Pass 1 — size everything, drop empty trajectories.
    let patientCount = 0;
    let eventCount = 0;
    let maxTrajectoryLength = 0;
    for (const r of records) {
        const n = r.trajectory.length;
        if (n === 0)
            continue;
        patientCount += 1;
        eventCount += n;
        if (n > maxTrajectoryLength)
            maxTrajectoryLength = n;
    }
    const rawIds = new Array(patientCount);
    const offsets = new Uint32Array(patientCount + 1);
    const diseaseDuration = new Float32Array(patientCount);
    const stateIds = new Uint16Array(eventCount);
    const ages = new Float32Array(eventCount);
    const years = new Float32Array(eventCount);
    const durations = new Float32Array(eventCount);
    const eventPatient = new Uint32Array(eventCount);
    let minAge = Infinity;
    let maxAge = -Infinity;
    let minYear = Infinity;
    let maxYear = -Infinity;
    let minDuration = Infinity;
    let maxDuration = -Infinity;
    let minDisease = Infinity;
    let maxDisease = -Infinity;
    // Pass 2 — fill.
    let p = 0;
    let e = 0;
    for (const r of records) {
        const n = r.trajectory.length;
        if (n === 0)
            continue;
        rawIds[p] = r.id;
        offsets[p] = e;
        const dd = Number.isFinite(r.diseaseDuration) ? r.diseaseDuration : 0;
        diseaseDuration[p] = dd;
        if (dd < minDisease)
            minDisease = dd;
        if (dd > maxDisease)
            maxDisease = dd;
        const start = e;
        for (let k = 0; k < n; k++) {
            // `noUncheckedIndexedAccess` makes these reads `T | undefined`; the ?? is
            // the guard for ragged input (a row missing an age or a date).
            const label = r.trajectory[k] ?? "";
            const age = Number(r.switchEventAge[k] ?? 0);
            // Files without a date column fall back to age, keeping the x-axis usable.
            const year = Number(r.years[k] ?? age);
            stateIds[e] = vocab.intern(label);
            ages[e] = age;
            years[e] = year;
            eventPatient[e] = p;
            if (age < minAge)
                minAge = age;
            if (age > maxAge)
                maxAge = age;
            if (year < minYear)
                minYear = year;
            if (year > maxYear)
                maxYear = year;
            e += 1;
        }
        // Durations need the next event, so they are a second sweep over this
        // patient's slice — still contiguous, still cache-friendly.
        for (let i = start; i < e - 1; i++) {
            const a = years[i];
            const b = years[i + 1];
            const d = b > a ? b - a : a - b;
            durations[i] = d;
            if (d < minDuration)
                minDuration = d;
            if (d > maxDuration)
                maxDuration = d;
        }
        durations[e - 1] = 0;
        if (minDuration > 0)
            minDuration = 0;
        p += 1;
    }
    offsets[patientCount] = eventCount;
    const extents = {
        age: eventCount > 0 ? [minAge, maxAge] : [0, 0],
        year: eventCount > 0 ? [minYear, maxYear] : [0, 0],
        duration: eventCount > 0 ? [Math.min(0, minDuration), Math.max(0, maxDuration)] : [0, 0],
        diseaseDuration: patientCount > 0 ? [minDisease, maxDisease] : [0, 0],
        maxTrajectoryLength,
    };
    return {
        patientCount,
        eventCount,
        ids: IdColumn.encode(rawIds),
        diseaseDuration,
        offsets,
        stateIds,
        ages,
        years,
        durations,
        eventPatient,
        stateNames: vocab.toArray(),
        extents,
    };
}
