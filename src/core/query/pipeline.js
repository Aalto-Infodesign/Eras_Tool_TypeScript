import { EMPTY, FAILS, filterFailures, OUTSIDE_CLUSTERS, UNSELECTED, } from "./filters.ts";
/** The order a fresh step is appended in when several arrive at once. */
const CANONICAL = [
    "age",
    "year",
    "diseaseDuration",
    "duration",
    "typologies",
    "clusters",
];
/** The `failures` bits each step cuts on. */
export const STEP_BITS = {
    ...FAILS,
    typologies: UNSELECTED,
    clusters: OUTSIDE_CLUSTERS,
    removedStates: EMPTY,
};
/**
 * The clusters of the typology on screen, out of all the selected ones.
 *
 * A cluster is a group *within* one typology, so one selected from anywhere
 * else has no place on its ladder. With no typology focused this is the whole
 * selection, which is what the cluster table and the ribbons go by.
 */
export function scopeClusters(run, selected, focusedKey) {
    if (focusedKey === null || run === null)
        return selected;
    return selected.filter((index) => run.clusters[index]?.typologyKey === focusedKey);
}
/**
 * The clusters that actually narrow the chart: only the single-typology chart
 * isolates its hairlines to a cluster's members (`useChartLayers`); the grid and
 * the Sankey draw the selection whatever the cluster table says. `focusedKey` is
 * `null` whenever that chart is not the one on screen.
 */
export function isolatedClusters(run, selected, focusedKey) {
    if (focusedKey === null || run === null)
        return [];
    return scopeClusters(run, selected, focusedKey);
}
/** The steps cutting something right now, in canonical order. */
export function activeSteps(filters, selectedTypologies, isolated) {
    return CANONICAL.filter((step) => {
        if (step === "typologies")
            return selectedTypologies.length > 0;
        if (step === "clusters")
            return isolated.length > 0;
        return filters[step] !== null;
    });
}
/**
 * Keeps the steps still active where they were and appends new ones, so a step
 * keeps its place while its range is dragged and goes to the end when it is
 * dropped and placed again. Returns `previous` itself when nothing changed, so
 * a caller can compare by identity.
 */
export function reconcileOrder(previous, active) {
    const kept = previous.filter((step) => active.includes(step));
    const added = active.filter((step) => !kept.includes(step));
    if (added.length === 0 && kept.length === previous.length)
        return previous;
    return [...kept, ...added];
}
/**
 * Every patient's `STEP_BITS`: what each range, the typology choice and the
 * cluster isolation would cut them for, all recorded rather than the first.
 *
 * `chosen` is the chosen typologies' members, `null` for no typology step;
 * `members` the isolated clusters' members (`clusterMembers` with no mask: the
 * filters' bits already say who else is out), `null` for no cluster step.
 */
export function pipelineFailures(store, filters, chosen, members, into = new Uint8Array(store.patientCount)) {
    filterFailures(store, filters, into);
    if (chosen !== null)
        markOutside(into, chosen, UNSELECTED);
    if (members !== null)
        markOutside(into, [members], OUTSIDE_CLUSTERS);
    return into;
}
/** Sets `bit` on everyone, then clears it on the members of `groups`. */
function markOutside(failures, groups, bit) {
    for (let p = 0; p < failures.length; p++)
        failures[p] = failures[p] | bit;
    for (const patients of groups) {
        for (let i = 0; i < patients.length; i++) {
            const p = patients[i];
            failures[p] = failures[p] & ~bit;
        }
    }
}
/**
 * How many patients are left after each step of `bits`, cumulatively: entry
 * `i` counts those who fail none of `bits[0..i]`. One pass, however many steps:
 * each patient is charged to the first step that cuts them.
 */
export function survivorCounts(failures, bits) {
    const cut = new Array(bits.length).fill(0);
    for (let p = 0; p < failures.length; p++) {
        const f = failures[p];
        if (f === 0)
            continue;
        for (let s = 0; s < bits.length; s++) {
            if ((f & bits[s]) !== 0) {
                cut[s] = cut[s] + 1;
                break;
            }
        }
    }
    const out = [];
    let left = failures.length;
    for (let s = 0; s < bits.length; s++) {
        left -= cut[s];
        out.push(left);
    }
    return out;
}
/** The patients failing none of `bits`, ascending. */
export function survivors(failures, bits) {
    let n = 0;
    for (let p = 0; p < failures.length; p++)
        if ((failures[p] & bits) === 0)
            n += 1;
    const out = new Uint32Array(n);
    let i = 0;
    for (let p = 0; p < failures.length; p++)
        if ((failures[p] & bits) === 0)
            out[i++] = p;
    return out;
}
/*
 * Exports, as lists of string chunks for a `Blob` rather than one string: the
 * records of a million patients run to hundreds of megabytes, which is past
 * what one string can comfortably be built into.
 */
const CHUNK = 5000;
/** One id per line under `header` — enough to join back onto the source data. */
export function patientIdsCsv(store, patients, header) {
    const chunks = [`${csvCell(header)}\n`];
    for (let start = 0; start < patients.length; start += CHUNK) {
        const lines = [];
        const end = Math.min(start + CHUNK, patients.length);
        for (let i = start; i < end; i++)
            lines.push(csvCell(store.ids.at(patients[i])));
        chunks.push(`${lines.join("\n")}\n`);
    }
    return chunks;
}
/**
 * The patients as wide-format JSON — the shape `parse/json.ts` reads, so an
 * export loads straight back in as a dataset of its own. Trajectories are as
 * the store has them, which means with any removed state already spliced out.
 */
export function patientRecordsJson(store, patients, idKey) {
    const chunks = ["["];
    for (let start = 0; start < patients.length; start += CHUNK) {
        const records = [];
        const end = Math.min(start + CHUNK, patients.length);
        for (let i = start; i < end; i++) {
            const p = patients[i];
            const from = store.offsets[p];
            const to = store.offsets[p + 1];
            records.push(JSON.stringify({
                [idKey]: store.ids.at(p),
                trajectory: Array.from(store.stateIds.subarray(from, to), (s) => store.stateNames[s]),
                SwitchEventAge: Array.from(store.ages.subarray(from, to), single),
                years: Array.from(store.years.subarray(from, to), single),
                diseaseDuration: single(store.diseaseDuration[p]),
            }));
        }
        chunks.push(`${start === 0 ? "" : ","}\n${records.join(",\n")}`);
    }
    chunks.push("\n]\n");
    return chunks;
}
/**
 * A float32 column's value as the digits it actually holds. Widened as is,
 * `24.885431` prints as `24.885431289672852`, and the extra digits are noise.
 */
const single = (value) => Number(value.toPrecision(7));
function csvCell(value) {
    return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}
