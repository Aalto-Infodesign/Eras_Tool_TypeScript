/** Deterministic subsample spanning the whole array, as the original's `strideSample`. */
export function strideIndices(length, limit) {
    if (length <= limit) {
        const all = new Uint32Array(length);
        for (let i = 0; i < length; i++)
            all[i] = i;
        return all;
    }
    const out = new Uint32Array(limit);
    const step = length / limit;
    for (let i = 0; i < limit; i++)
        out[i] = Math.floor(i * step);
    return out;
}
