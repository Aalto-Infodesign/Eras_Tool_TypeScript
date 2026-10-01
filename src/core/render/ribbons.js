import { strideIndices } from "../util/sample.ts";
export function buildRibbon(store, group, options) {
    // Members of this group that survive the current filter.
    const members = [];
    for (let i = 0; i < group.patients.length; i++) {
        const patient = group.patients[i];
        if (options.visible !== null && options.visible[patient] !== 1)
            continue;
        members.push(patient);
    }
    if (members.length === 0)
        return null;
    const first = members[0];
    const length = store.offsets[first + 1] - store.offsets[first];
    if (length === 0)
        return null;
    const xs = options.axis === "age" ? store.ages : store.years;
    const sample = strideIndices(members.length, options.sampleLimit);
    const x = new Float32Array(length);
    const row = new Float32Array(length);
    const spreadLow = new Float32Array(length);
    const spreadHigh = new Float32Array(length);
    const halfWidth = new Float32Array(length);
    // Quantiles are per position, so one scratch buffer is reused down the path.
    const values = new Float64Array(sample.length);
    // Thickness is scaled by the square root of size: a group ten times larger
    // reads as clearly bigger without a hundred-fold ribbon that swallows the chart.
    const scale = options.maxSize === 0 ? 0 : Math.sqrt(members.length / options.maxSize);
    const width = options.maxHalfWidth * scale;
    for (let k = 0; k < length; k++) {
        for (let i = 0; i < sample.length; i++) {
            const patient = members[sample[i]];
            values[i] = xs[store.offsets[patient] + k];
        }
        values.sort();
        x[k] = quantile(values, 0.5);
        spreadLow[k] = quantile(values, 0.25);
        spreadHigh[k] = quantile(values, 0.75);
        const state = store.stateIds[store.offsets[first] + k];
        row[k] = options.rowOf[state];
        halfWidth[k] = width;
    }
    return {
        index: group.index,
        label: group.label,
        size: members.length,
        x,
        row,
        halfWidth,
        spreadLow,
        spreadHigh,
    };
}
/** Ribbons for the largest groups currently in view, biggest first. */
export function buildRibbons(store, groups, limit, options) {
    const ranked = groups.slice().sort((a, b) => b.patients.length - a.patients.length);
    const maxSize = ranked[0]?.patients.length ?? 0;
    const ribbons = [];
    for (const group of ranked) {
        if (ribbons.length >= limit)
            break;
        const ribbon = buildRibbon(store, group, { ...options, maxSize });
        if (ribbon !== null)
            ribbons.push(ribbon);
    }
    return ribbons;
}
/** Linear-interpolated quantile over a pre-sorted buffer. */
export function quantile(sorted, q) {
    const n = sorted.length;
    if (n === 0)
        return 0;
    if (n === 1)
        return sorted[0];
    const position = (n - 1) * q;
    const lower = Math.floor(position);
    const upper = Math.ceil(position);
    const weight = position - lower;
    return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}
