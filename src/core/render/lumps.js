export function buildLumps(store, patients, options) {
    const stateCount = store.stateNames.length;
    if (stateCount === 0)
        return [];
    const xs = options.axis === "age" ? store.ages : store.years;
    const durationRange = options.durationRange ?? null;
    // One slot per ordered state pair. Bounded by the vocabulary, so this is a
    // fixed, small allocation no matter how many patients are in view.
    const slots = stateCount * stateCount;
    const counts = new Uint32Array(slots);
    const sourceMin = new Float64Array(slots).fill(Infinity);
    const sourceMax = new Float64Array(slots).fill(-Infinity);
    const targetMin = new Float64Array(slots).fill(Infinity);
    const targetMax = new Float64Array(slots).fill(-Infinity);
    for (let i = 0; i < patients.length; i++) {
        const p = patients[i];
        const start = store.offsets[p];
        const end = store.offsets[p + 1];
        const add = (from, to) => {
            // Measured between the events actually linked, so a link spanning a
            // spliced-out state is judged on the gap it really covers.
            if (durationRange !== null && from !== to) {
                const d = Math.abs(store.years[to] - store.years[from]);
                if (d < durationRange.min || d > durationRange.max)
                    return;
            }
            const slot = store.stateIds[from] * stateCount + store.stateIds[to];
            const sx = xs[from];
            const tx = xs[to];
            counts[slot] = counts[slot] + 1;
            if (sx < sourceMin[slot])
                sourceMin[slot] = sx;
            if (sx > sourceMax[slot])
                sourceMax[slot] = sx;
            if (tx < targetMin[slot])
                targetMin[slot] = tx;
            if (tx > targetMax[slot])
                targetMax[slot] = tx;
        };
        // Each event links to the next; the last links to itself.
        let prev = -1;
        for (let e = start; e < end; e++) {
            if (prev !== -1)
                add(prev, e);
            prev = e;
        }
        if (prev !== -1)
            add(prev, prev);
    }
    const lumps = [];
    for (let slot = 0; slot < slots; slot++) {
        const count = counts[slot];
        if (count === 0)
            continue;
        lumps.push({
            sourceState: Math.floor(slot / stateCount),
            targetState: slot % stateCount,
            count,
            sourceMin: sourceMin[slot],
            sourceMax: sourceMax[slot],
            targetMin: targetMin[slot],
            targetMax: targetMax[slot],
        });
    }
    // Biggest first: the heaviest transitions draw underneath, so a small lump is
    // never hidden by a large one painted over it.
    lumps.sort((a, b) => b.count - a.count);
    return lumps;
}
