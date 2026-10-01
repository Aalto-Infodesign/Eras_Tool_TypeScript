/**
 * The x extent of the patients currently in view.
 *
 * `store.extents` describes the whole dataset and is what the chart scales to by
 * default, so filtering down to a decade leaves that decade squeezed into a
 * sliver of the axis. This is the extent of what is actually drawn, for zooming
 * the axis onto it.
 *
 * Returns `null` when nothing is in view, so the caller can leave the current
 * scale alone rather than collapse it to a point.
 */
export function visibleExtent(store, patients, axis) {
    const xs = axis === "age" ? store.ages : store.years;
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < patients.length; i++) {
        const p = patients[i];
        const start = store.offsets[p];
        const end = store.offsets[p + 1];
        for (let e = start; e < end; e++) {
            const value = xs[e];
            if (value < lo)
                lo = value;
            if (value > hi)
                hi = value;
        }
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi))
        return null;
    // A single point has no span; widen it so the scale stays invertible.
    if (hi === lo)
        return [lo - 0.5, hi + 0.5];
    return [lo, hi];
}
/**
 * The x domain the chart draws against: the user's zoom if there is one, else
 * the whole dataset on the chosen axis.
 *
 * Shared by the chart and the View panel's mini of it, so the thumbnail is
 * scaled exactly as the view it opens — the mini cannot ask the chart, because
 * the chart is not mounted while the mini is showing it.
 */
export function xDomainOf(store, axis, override) {
    if (override !== null)
        return override;
    if (store === null)
        return [0, 1];
    return axis === "age" ? store.extents.age : store.extents.year;
}
