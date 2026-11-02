import { Selection } from "./Selection.ts";
export const emptyFilters = {
    age: null,
    year: null,
    diseaseDuration: null,
    duration: null,
    typologies: [],
    removedStates: [],
    inverted: {},
};
const within = (value, range) => range === null || (value >= range.min && value <= range.max);
const apply = (passes, inverted) => inverted === true ? !passes : passes;
/**
 * One bit per range a patient falls foul of — what `filterFailures` writes.
 *
 * A mask says *whether* a patient survives; this says *which* filter cut them,
 * which is what a filter's own histogram needs: the patients every *other*
 * filter keeps, so the part the slider lights is exactly the part on screen.
 */
export const FAILS = {
    diseaseDuration: 1,
    year: 2,
    age: 4,
    duration: 8,
};
/** Spliced empty; never visible, whatever the ranges say. See `model/reshape.ts`. */
export const EMPTY = 16;
/** Outside the chosen typologies. Set by the caller, never by the filters here. */
export const UNSELECTED = 32;
/** Outside the isolated clusters. Set by the caller too; see `query/pipeline.ts`. */
export const OUTSIDE_CLUSTERS = 64;
/** Whether a run's whole span sits inside `range`. The run is unsorted, so it is a scan. */
function spanWithin(column, start, end, range) {
    let lo = Infinity;
    let hi = -Infinity;
    for (let e = start; e < end; e++) {
        const value = column[e];
        if (value < lo)
            lo = value;
        if (value > hi)
            hi = value;
    }
    return lo >= range.min && hi <= range.max;
}
/**
 * The `FAILS` bits for patient `p`. Not `exhaustive`, it stops at the first
 * failure, which is all a mask needs and keeps the drag's scan as cheap as it was.
 */
function failuresOf(store, filters, p, exhaustive) {
    const start = store.offsets[p];
    const end = store.offsets[p + 1];
    // Removing a state splices it out of the store, which can leave a patient
    // with nothing at all. They would otherwise count as visible while drawing
    // nothing. See `model/reshape.ts`.
    if (end <= start)
        return EMPTY;
    let failed = 0;
    // Guarded like the others: inverting a range that is not set would otherwise
    // invert "everyone passes" into "nobody does".
    if (filters.diseaseDuration !== null &&
        !apply(within(store.diseaseDuration[p], filters.diseaseDuration), filters.inverted.diseaseDuration)) {
        failed |= FAILS.diseaseDuration;
        if (!exhaustive)
            return failed;
    }
    // A patient passes the date filter when their whole span sits inside it,
    // matching the original's `min(years) >= lo && max(years) <= hi`.
    if (filters.year !== null &&
        !apply(spanWithin(store.years, start, end, filters.year), filters.inverted.year)) {
        failed |= FAILS.year;
        if (!exhaustive)
            return failed;
    }
    if (filters.age !== null &&
        !apply(spanWithin(store.ages, start, end, filters.age), filters.inverted.age)) {
        failed |= FAILS.age;
        if (!exhaustive)
            return failed;
    }
    if (filters.duration !== null) {
        // Segment-level: keep the patient if any transition falls in range.
        let any = false;
        for (let e = start; e < end - 1; e++) {
            if (within(store.durations[e], filters.duration)) {
                any = true;
                break;
            }
        }
        if (!apply(any, filters.inverted.duration))
            failed |= FAILS.duration;
    }
    return failed;
}
/**
 * Rewrites `into.mask` in place. Allocation-free on the hot path, so a slider
 * drag costs one linear scan rather than a full pipeline re-derivation.
 */
export function applyFilters(store, filters, into = new Selection(store.patientCount)) {
    const { mask } = into;
    // Typology membership is resolved to a patient-level allow list by the caller
    // (`selectTypologies`), so this loop only ever tests numeric ranges.
    let visible = 0;
    for (let p = 0; p < store.patientCount; p++) {
        const keep = failuresOf(store, filters, p, false) === 0;
        mask[p] = keep ? 1 : 0;
        if (keep)
            visible += 1;
    }
    into.invalidate(visible);
    return into;
}
/**
 * Writes every patient's `FAILS` bits (and `EMPTY`) into `into`, testing every
 * range rather than stopping at the first miss. Dearer than `applyFilters`, so
 * it is only run when something reads per-filter survivors.
 */
export function filterFailures(store, filters, into) {
    for (let p = 0; p < store.patientCount; p++)
        into[p] = failuresOf(store, filters, p, true);
    return into;
}
/** Intersects the current mask with the patients of the named typologies. */
export function intersectTypologies(selection, typologyPatients) {
    if (typologyPatients.length === 0)
        return selection;
    const allowed = new Uint8Array(selection.patientCount);
    for (const patients of typologyPatients) {
        for (let i = 0; i < patients.length; i++)
            allowed[patients[i]] = 1;
    }
    let visible = 0;
    for (let p = 0; p < selection.patientCount; p++) {
        const keep = selection.mask[p] === 1 && allowed[p] === 1;
        selection.mask[p] = keep ? 1 : 0;
        if (keep)
            visible += 1;
    }
    selection.invalidate(visible);
    return selection;
}
