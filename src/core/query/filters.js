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
 * Rewrites `into.mask` in place. Allocation-free on the hot path, so a slider
 * drag costs one linear scan rather than a full pipeline re-derivation.
 */
export function applyFilters(store, filters, into = new Selection(store.patientCount)) {
    const { mask } = into;
    const { offsets, ages, years, diseaseDuration, durations } = store;
    // Typology membership is resolved to a patient-level allow list by the caller
    // (`selectTypologies`), so this loop only ever tests numeric ranges.
    let visible = 0;
    for (let p = 0; p < store.patientCount; p++) {
        const start = offsets[p];
        const end = offsets[p + 1];
        // Removing a state splices it out of the store, which can leave a patient
        // with nothing at all. They would otherwise count as visible while drawing
        // nothing. See `model/reshape.ts`.
        let keep = end > start;
        keep = keep && apply(within(diseaseDuration[p], filters.diseaseDuration), filters.inverted.diseaseDuration);
        if (keep && filters.year !== null) {
            // A patient passes the date filter when their whole span sits inside it,
            // matching the original's `min(years) >= lo && max(years) <= hi`.
            let lo = Infinity;
            let hi = -Infinity;
            for (let e = start; e < end; e++) {
                const y = years[e];
                if (y < lo)
                    lo = y;
                if (y > hi)
                    hi = y;
            }
            keep = apply(lo >= filters.year.min && hi <= filters.year.max, filters.inverted.year);
        }
        if (keep && filters.age !== null) {
            let lo = Infinity;
            let hi = -Infinity;
            for (let e = start; e < end; e++) {
                const a = ages[e];
                if (a < lo)
                    lo = a;
                if (a > hi)
                    hi = a;
            }
            keep = apply(lo >= filters.age.min && hi <= filters.age.max, filters.inverted.age);
        }
        if (keep && filters.duration !== null) {
            // Segment-level: keep the patient if any transition falls in range.
            let any = false;
            for (let e = start; e < end - 1; e++) {
                if (within(durations[e], filters.duration)) {
                    any = true;
                    break;
                }
            }
            keep = apply(any, filters.inverted.duration);
        }
        mask[p] = keep ? 1 : 0;
        if (keep)
            visible += 1;
    }
    into.invalidate(visible);
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
