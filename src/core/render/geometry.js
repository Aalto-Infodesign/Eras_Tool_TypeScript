/** Half-width of a single-event patient's mark, as a fraction of the axis extent. */
const SINGLE_EVENT_MARK = 0.002;
/**
 * Builds geometry for an explicit list of patients.
 *
 * Taking the patient list rather than a `Selection` is what lets the same
 * builder produce both the bulk layer (`selection.indices()`) and the medoid
 * spine layer (a handful of representative patients) with no special casing.
 */
export function buildGeometry(store, patients, options) {
    let capacity = 0;
    for (let i = 0; i < patients.length; i++) {
        const p = patients[i];
        const events = store.offsets[p + 1] - store.offsets[p];
        // `events - 1` links, except for a patient with a single event, who gets one
        // mark instead. See the emit loop below.
        capacity += events === 0 ? 0 : events === 1 ? 1 : events - 1;
    }
    const positions = new Float32Array(capacity * 4);
    const colors = new Uint8Array(capacity * 8);
    const segmentPatient = new Uint32Array(capacity);
    const segmentEvent = new Uint32Array(capacity);
    const xs = options.axis === "age" ? store.ages : store.years;
    const { color, durationRange } = options;
    const byPosition = options.rowsFrom === "position";
    const paletteBytes = color.palette.bytes;
    /*
     * Half-width of the single-event mark, in data units.
     *
     * Taken from the dataset's extent rather than from the current view, because
     * geometry is built once and the x domain moves under it (fit-axis, reset).
     * The trade is that zooming in magnifies the mark like any other x measure;
     * keeping it a constant number of pixels would mean a per-vertex flag and a
     * branch in the vertex shader, which is a lot of machinery for a tick.
     */
    const extent = options.axis === "age" ? store.extents.age : store.extents.year;
    const mark = (extent[1] - extent[0]) * SINGLE_EVENT_MARK;
    let s = 0;
    // Per-patient state the emitter reads. Hoisted so the emitter is one closure
    // for the whole call rather than one per patient.
    let patient = 0;
    /** First event of the patient being emitted, for `rowsFrom: "position"`. */
    let patientStart = 0;
    let clusterR = 0;
    let clusterG = 0;
    let clusterB = 0;
    /**
     * Writes one segment from event `from` to event `to`.
     *
     * `spread` widens a segment symmetrically in x. It is zero for a real link,
     * whose endpoints are where the data puts them, and non-zero only for the mark
     * that stands in for a patient with a single event.
     */
    const emit = (from, to, spread = 0) => {
        // Duration is measured between the events actually linked, so a segment that
        // spans a spliced-out state is judged on the gap it really covers.
        if (durationRange !== null && durationRange !== undefined && from !== to) {
            const d = Math.abs(store.years[to] - store.years[from]);
            if (d < durationRange.min || d > durationRange.max)
                return;
        }
        const sourceState = store.stateIds[from];
        const targetState = store.stateIds[to];
        const pos = s * 4;
        positions[pos + 0] = xs[from] - spread;
        positions[pos + 1] = byPosition ? from - patientStart : sourceState;
        positions[pos + 2] = xs[to] + spread;
        positions[pos + 3] = byPosition ? to - patientStart : targetState;
        const col = s * 8;
        if (color.kind === "cluster") {
            colors[col + 0] = clusterR;
            colors[col + 1] = clusterG;
            colors[col + 2] = clusterB;
            colors[col + 3] = 255;
            colors[col + 4] = clusterR;
            colors[col + 5] = clusterG;
            colors[col + 6] = clusterB;
            colors[col + 7] = 255;
        }
        else {
            const src = sourceState * 4;
            const dst = targetState * 4;
            colors[col + 0] = paletteBytes[src + 0];
            colors[col + 1] = paletteBytes[src + 1];
            colors[col + 2] = paletteBytes[src + 2];
            colors[col + 3] = 255;
            colors[col + 4] = paletteBytes[dst + 0];
            colors[col + 5] = paletteBytes[dst + 1];
            colors[col + 6] = paletteBytes[dst + 2];
            colors[col + 7] = 255;
        }
        segmentPatient[s] = patient;
        segmentEvent[s] = from;
        s += 1;
    };
    for (let i = 0; i < patients.length; i++) {
        const p = patients[i];
        patient = p;
        const start = store.offsets[p];
        const end = store.offsets[p + 1];
        patientStart = start;
        // Resolved once per patient: a patient belongs to exactly one cluster, so
        // the lookup does not belong in the per-segment loop.
        if (color.kind === "cluster") {
            const cluster = color.clusterOfPatient[p] ?? -1;
            if (cluster < 0) {
                clusterR = color.unclustered[0];
                clusterG = color.unclustered[1];
                clusterB = color.unclustered[2];
            }
            else {
                const base = (cluster % (paletteBytes.length / 4)) * 4;
                clusterR = paletteBytes[base];
                clusterG = paletteBytes[base + 1];
                clusterB = paletteBytes[base + 2];
            }
        }
        /*
         * Each event links to the next. States removed by the user are already gone
         * from the store (see `model/reshape.ts`), so there is nothing to skip here.
         *
         * The store closes every patient with a self-link onto their last event —
         * its stop convention, which the lump layer reads as "where trajectories
         * come to rest". This layer does **not** emit it. Both ends of a self-link
         * land on the same point, and a zero-length line draws nothing: `gl.LINES`
         * rasterises no fragments for it and Canvas2D's `butt` cap gives it no
         * width. It was invisible, unpickable, and 16% of the vertex buffer on the
         * 25k dataset — a line's own endpoint already shows where it stopped.
         *
         * A patient with a *single* event is the exception: the self-link is all
         * they have, so dropping it would erase them from the chart entirely. They
         * get a short horizontal mark centred on their one event instead, which is
         * both visible and pickable. In the 25k dataset that is 753 people, and the
         * second-largest typology is made of nothing else — selecting it drew an
         * empty chart.
         */
        let prev = -1;
        for (let e = start; e < end; e++) {
            if (prev !== -1)
                emit(prev, e);
            prev = e;
        }
        if (end - start === 1)
            emit(start, start, mark);
    }
    // `subarray` keeps the views pointing at the single allocation above — no copy
    // even when the duration filter dropped a large fraction of segments.
    return {
        positions: positions.subarray(0, s * 4),
        colors: colors.subarray(0, s * 8),
        segmentPatient: segmentPatient.subarray(0, s),
        segmentEvent: segmentEvent.subarray(0, s),
        segmentCount: s,
    };
}
/**
 * Row lookup from a state ordering; states not in the order are parked off-chart.
 *
 * Float rather than integer because this is also what an animated reorder
 * interpolates through: a state half way between rows 2 and 3 is at 2.5, and
 * every layer — the shader, the canvas fallback, the SVG overlays — reads it the
 * same way.
 */
export function rowLookup(stateCount, order) {
    const rowOf = new Float32Array(stateCount).fill(-1);
    for (let row = 0; row < order.length; row++) {
        const state = order[row];
        if (state >= 0 && state < stateCount)
            rowOf[state] = row;
    }
    return rowOf;
}
