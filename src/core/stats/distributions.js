/**
 * Bins across the extent rather than the original's `Math.floor` on the raw
 * value. Integer bins read well on whole years, which is what that data was, but
 * collapse to a single bar as soon as a span is narrower than one unit — which
 * segment durations, in fractional years, routinely are.
 */
const BINS = 64;
function emptyDistribution(domain) {
    return { counts: new Uint32Array(1), max: 0, domain, binWidth: 1 };
}
/**
 * Bins `values` over `domain`; values outside it are clamped into the end bins.
 *
 * Exported for the Sankey's distribution, which bins a pinned item's values
 * over a domain from `niceBins` so that bin edges land on round numbers.
 */
export function histogram(values, count, domain, bins = BINS) {
    const [lo, hi] = domain;
    const span = hi - lo;
    if (count === 0 || !Number.isFinite(span) || span <= 0)
        return emptyDistribution(domain);
    const counts = new Uint32Array(bins);
    for (let i = 0; i < count; i++) {
        const value = values[i];
        const slot = Math.min(bins - 1, Math.max(0, Math.floor(((value - lo) / span) * bins)));
        counts[slot] = counts[slot] + 1;
    }
    let max = 0;
    for (let b = 0; b < bins; b++) {
        const c = counts[b];
        if (c > max)
            max = c;
    }
    return { counts, max, domain, binWidth: span / bins };
}
/** First and last value of each patient's run, which is what a span filter cuts. */
function spanOf(store, column, domain) {
    const starts = new Float64Array(store.patientCount);
    const ends = new Float64Array(store.patientCount);
    let n = 0;
    for (let p = 0; p < store.patientCount; p++) {
        const start = store.offsets[p];
        const end = store.offsets[p + 1];
        if (end === start)
            continue; // spliced empty; see model/reshape.ts
        // The run is not sorted by value, so the span is a scan, not the endpoints.
        let lo = Infinity;
        let hi = -Infinity;
        for (let e = start; e < end; e++) {
            const value = column[e];
            if (value < lo)
                lo = value;
            if (value > hi)
                hi = value;
        }
        starts[n] = lo;
        ends[n] = hi;
        n += 1;
    }
    return { start: histogram(starts, n, domain), end: histogram(ends, n, domain) };
}
export function buildDistributions(store) {
    const { extents } = store;
    // Patient-level: one value each, empty patients excluded.
    const diseaseDurations = new Float64Array(store.patientCount);
    let patients = 0;
    for (let p = 0; p < store.patientCount; p++) {
        if (store.offsets[p + 1] === store.offsets[p])
            continue;
        diseaseDurations[patients] = store.diseaseDuration[p];
        patients += 1;
    }
    // Link-level: every transition, excluding each patient's closing self-link,
    // which carries a zero that is a convention rather than a measurement.
    const durations = new Float64Array(store.eventCount);
    let links = 0;
    for (let p = 0; p < store.patientCount; p++) {
        const start = store.offsets[p];
        const end = store.offsets[p + 1];
        for (let e = start; e < end - 1; e++) {
            durations[links] = store.durations[e];
            links += 1;
        }
    }
    return {
        age: spanOf(store, store.ages, extents.age),
        year: spanOf(store, store.years, extents.year),
        diseaseDuration: histogram(diseaseDurations, patients, extents.diseaseDuration),
        duration: histogram(durations, links, extents.duration),
    };
}
