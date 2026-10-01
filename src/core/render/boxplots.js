/**
 * Quantile resolution, as buckets across the axis' full extent.
 *
 * The obvious implementation collects each state's arrival times and sorts them,
 * but that is ~75ms for a 250k dataset — and this runs twice per filter change,
 * once for the selection and once for the population behind it, which puts it
 * squarely in the way of a slider drag. Sampling instead of sorting was worse: a
 * stride sample follows the data's own order, and when that order correlates
 * with age (patients loaded oldest-first, say) every quantile comes out biased
 * by half a stride rather than merely noisy.
 *
 * A histogram has neither problem. It is one counting pass with no sort and no
 * buffer proportional to the event count, and its error is bounded by the bucket
 * width rather than by the data's arrangement. At this resolution a bucket is
 * ~1/8000th of the axis — comfortably under a pixel on any real chart.
 */
const BUCKETS = 8192;
export function buildStateStats(store, visible, axis, buckets = BUCKETS) {
    const stateCount = store.stateNames.length;
    if (stateCount === 0)
        return [];
    const xs = axis === "age" ? store.ages : store.years;
    const [lo, hi] = axis === "age" ? store.extents.age : store.extents.year;
    const span = Math.max(hi - lo, 1e-9);
    const { stateIds, eventPatient, eventCount } = store;
    const histogram = new Uint32Array(stateCount * buckets);
    const counts = new Uint32Array(stateCount);
    const mins = new Float64Array(stateCount).fill(Infinity);
    const maxes = new Float64Array(stateCount).fill(-Infinity);
    for (let e = 0; e < eventCount; e++) {
        if (visible !== null && visible[eventPatient[e]] !== 1)
            continue;
        const state = stateIds[e];
        const x = xs[e];
        // Extremes are tracked exactly: they are drawn as the glyph's span, and a
        // bucketed extreme would visibly shorten the bar.
        if (x < mins[state])
            mins[state] = x;
        if (x > maxes[state])
            maxes[state] = x;
        const slot = Math.min(buckets - 1, Math.max(0, Math.floor(((x - lo) / span) * buckets)));
        const at = state * buckets + slot;
        histogram[at] = histogram[at] + 1;
        counts[state] = counts[state] + 1;
    }
    const stats = [];
    for (let s = 0; s < stateCount; s++) {
        const count = counts[s];
        if (count === 0)
            continue;
        const min = mins[s];
        const max = maxes[s];
        const base = s * buckets;
        // Clamped to the true extent so a bucket centre can never fall outside the
        // bar it is drawn inside.
        const at = (q) => Math.min(max, Math.max(min, quantileFromHistogram(histogram, base, buckets, count, q, lo, span)));
        stats.push({
            state: s,
            count,
            min,
            q1: at(0.25),
            median: at(0.5),
            q3: at(0.75),
            max,
        });
    }
    return stats;
}
/**
 * Value at quantile `q`, interpolated between the buckets holding the two ranks
 * that straddle it.
 *
 * `q` addresses position `(count - 1) * q` in the sorted run, and the two
 * neighbouring ranks are blended by the fractional part — the same convention as
 * the ribbons' `quantile`, so the two layers never disagree about where a median
 * is. Taking the nearest rank instead would be cheaper and is a perfectly
 * standard definition, but it reports the median of two visits as the earlier of
 * them, which is not what the tick over a bar between them should mean.
 *
 * Both ranks are found in one walk, since they are adjacent.
 */
function quantileFromHistogram(histogram, base, buckets, count, q, lo, span) {
    const centre = (bucket) => lo + ((bucket + 0.5) / buckets) * span;
    const target = (count - 1) * q;
    const lowerRank = Math.floor(target);
    const fraction = target - lowerRank;
    const upperRank = Math.min(lowerRank + 1, count - 1);
    let cumulative = 0;
    let lower = null;
    for (let b = 0; b < buckets; b++) {
        cumulative += histogram[base + b];
        if (cumulative <= lowerRank)
            continue;
        if (lower === null) {
            lower = centre(b);
            if (fraction === 0)
                return lower;
        }
        if (cumulative > upperRank)
            return lower + fraction * (centre(b) - lower);
    }
    return lower ?? lo + span;
}
/**
 * The same summary, but per *step* of one sequence rather than per state.
 *
 * The focused chart draws a rule per visit, so a typology that returns to `b`
 * has two `b` rows — and the whole reason to separate them is that they happen
 * at different times. `buildStateStats` pools every visit to a state into one
 * datum and would put the identical glyph on both rules, which says the opposite
 * of what the view is for.
 *
 * Indexed by step, so `stats[i]` belongs to row `i`; `null` where no drawn
 * patient reached that far. `state` carries the state at that step, for colour.
 *
 * Patients are assumed to walk the sequence the rows came from — which is what a
 * typology *is* — so event `start + i` is step `i`. A patient with fewer events
 * than there are rows simply contributes to the steps it has.
 */
export function buildStepStats(store, patients, stepCount, axis, buckets = BUCKETS) {
    if (stepCount === 0)
        return [];
    const xs = axis === "age" ? store.ages : store.years;
    const [lo, hi] = axis === "age" ? store.extents.age : store.extents.year;
    const span = Math.max(hi - lo, 1e-9);
    const { offsets, stateIds } = store;
    const histogram = new Uint32Array(stepCount * buckets);
    const counts = new Uint32Array(stepCount);
    const mins = new Float64Array(stepCount).fill(Infinity);
    const maxes = new Float64Array(stepCount).fill(-Infinity);
    const states = new Int32Array(stepCount).fill(-1);
    for (let i = 0; i < patients.length; i++) {
        const patient = patients[i];
        const start = offsets[patient];
        const end = offsets[patient + 1];
        const steps = Math.min(end - start, stepCount);
        for (let step = 0; step < steps; step++) {
            const e = start + step;
            const x = xs[e];
            if (states[step] === -1)
                states[step] = stateIds[e];
            // Extremes exactly, as above: they are the span of the drawn bar.
            if (x < mins[step])
                mins[step] = x;
            if (x > maxes[step])
                maxes[step] = x;
            const slot = Math.min(buckets - 1, Math.max(0, Math.floor(((x - lo) / span) * buckets)));
            const at = step * buckets + slot;
            histogram[at] = histogram[at] + 1;
            counts[step] = counts[step] + 1;
        }
    }
    const out = [];
    for (let step = 0; step < stepCount; step++) {
        const count = counts[step];
        if (count === 0) {
            out.push(null);
            continue;
        }
        const min = mins[step];
        const max = maxes[step];
        const base = step * buckets;
        const at = (q) => Math.min(max, Math.max(min, quantileFromHistogram(histogram, base, buckets, count, q, lo, span)));
        out.push({
            state: states[step],
            count,
            min,
            q1: at(0.25),
            median: at(0.5),
            q3: at(0.75),
            max,
        });
    }
    return out;
}
