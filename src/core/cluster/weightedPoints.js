export function collapseDuplicates(rows, n, d) {
    const buckets = new Map();
    const points = new Float32Array(n * d);
    const weights = new Float64Array(n);
    const firstRow = new Uint32Array(n);
    const asInt = new Int32Array(rows.buffer, rows.byteOffset, n * d);
    let m = 0;
    for (let i = 0; i < n; i++) {
        const base = i * d;
        // FNV-1a over the row's raw bits: exact, and no string in sight.
        let hash = 0x811c9dc5;
        for (let k = 0; k < d; k++) {
            hash ^= asInt[base + k];
            hash = Math.imul(hash, 0x01000193);
        }
        hash >>>= 0;
        let bucket = buckets.get(hash);
        if (bucket === undefined) {
            bucket = [];
            buckets.set(hash, bucket);
        }
        let found = -1;
        for (const candidate of bucket) {
            if (sameRow(rows, base, candidate * d, d)) {
                found = candidate;
                break;
            }
        }
        if (found === -1) {
            const slot = m++;
            points.set(rows.subarray(base, base + d), slot * d);
            weights[slot] = 1;
            firstRow[slot] = i;
            bucket.push(slot);
        }
        else {
            weights[found] = weights[found] + 1;
        }
    }
    return {
        m,
        d,
        points: points.subarray(0, m * d),
        weights: weights.subarray(0, m),
        firstRow: firstRow.subarray(0, m),
    };
}
function sameRow(a, aBase, bBase, d) {
    for (let k = 0; k < d; k++) {
        if (a[aBase + k] !== a[bBase + k])
            return false;
    }
    return true;
}
