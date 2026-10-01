import { dateToFractionalYear } from "./dates.ts";
/**
 * Long-format rows (one per event) → one record per patient.
 *
 * The original did `groupBy` → `Object.entries` → `.map` → `.sort(new Date(...))`,
 * which allocates an intermediate object per row, re-parses each date inside the
 * comparator, and sorts every group even when the file is already ordered.
 *
 * This version does a single pass into per-patient bucket arrays keyed by a Map,
 * parses each date exactly once, and only sorts groups that are actually out of
 * order — which, for exports that come out of a database ORDER BY, is none.
 */
export function rowsToRecords(rows, headers, mapping) {
    const col = (name) => (name === null ? -1 : headers.indexOf(name));
    const idCol = col(mapping.patientId);
    const stateCol = col(mapping.state);
    const ageCol = col(mapping.age);
    const dateCol = col(mapping.date);
    const durationCol = col(mapping.diseaseDuration);
    if (idCol === -1 || stateCol === -1) {
        throw new Error(`Mapped columns not found in header: ` +
            `${mapping.patientId} → ${idCol}, ${mapping.state} → ${stateCol}`);
    }
    const buckets = new Map();
    for (const row of rows) {
        const id = row[idCol];
        if (id === undefined || id === "")
            continue;
        const state = row[stateCol];
        if (state === undefined || state === "")
            continue;
        const ageCell = ageCol === -1 ? "" : (row[ageCol] ?? "");
        const dateCell = dateCol === -1 ? "" : (row[dateCol] ?? "");
        const age = ageCell === "" ? Number.NaN : Number(ageCell);
        const year = dateCell === "" ? null : dateToFractionalYear(dateCell);
        // Fall back in both directions so a file with only one of the two still works.
        const resolvedAge = Number.isFinite(age) ? age : (year ?? 0);
        const resolvedYear = year ?? resolvedAge;
        let bucket = buckets.get(id);
        if (bucket === undefined) {
            bucket = { id, states: [], ages: [], years: [], declaredDuration: null, sorted: true };
            buckets.set(id, bucket);
            if (durationCol !== -1) {
                const raw = row[durationCol];
                const parsed = raw === undefined || raw === "" ? Number.NaN : Number(raw);
                bucket.declaredDuration = Number.isFinite(parsed) ? parsed : null;
            }
        }
        const previous = bucket.years[bucket.years.length - 1];
        if (previous !== undefined && resolvedYear < previous)
            bucket.sorted = false;
        bucket.states.push(state);
        bucket.ages.push(resolvedAge);
        bucket.years.push(resolvedYear);
    }
    const records = [];
    for (const bucket of buckets.values()) {
        if (bucket.states.length === 0)
            continue;
        let { states, ages, years } = bucket;
        if (!bucket.sorted) {
            // Sort an index permutation so the three parallel arrays stay aligned.
            const order = Array.from({ length: years.length }, (_, i) => i);
            order.sort((a, b) => years[a] - years[b]);
            states = order.map((i) => states[i]);
            ages = order.map((i) => ages[i]);
            years = order.map((i) => years[i]);
        }
        const first = years[0];
        const last = years[years.length - 1];
        records.push({
            id: bucket.id,
            trajectory: states,
            switchEventAge: ages,
            years,
            diseaseDuration: bucket.declaredDuration ?? last - first,
        });
    }
    return records;
}
