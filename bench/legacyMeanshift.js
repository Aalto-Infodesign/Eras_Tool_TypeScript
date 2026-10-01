/**
 * Faithful port of the original `newClustering.worker.js` convergence pipeline,
 * kept **only** as a benchmark baseline so the rewrite's speedup is measured
 * rather than asserted.
 *
 * Nothing here is imported by the app. The shapes are deliberately unchanged:
 * `number[][]` matrices, `filter` for the neighbourhood, and the
 * `reduce((acc, el) => acc.map(...))` mean that allocates an array per row.
 */
const squED = (a, b) => a.reduce((acc, v, n) => acc + (v - b[n]) ** 2, 0);
const euclidean = (a, b) => Math.sqrt(squED(a, b));
function strideSample(arr, limit) {
    if (arr.length <= limit)
        return arr;
    const step = arr.length / limit;
    const out = [];
    for (let i = 0; i < limit; i++)
        out.push(arr[Math.floor(i * step)]);
    return out;
}
function uniqueRows(matrix) {
    const seen = new Map();
    matrix.forEach((row, index) => {
        const key = JSON.stringify(row);
        if (!seen.has(key))
            seen.set(key, { row, index });
    });
    return [...seen.values()];
}
function estimateBandwidth(matrix, factor = 0.3, sampleLimit = 300) {
    const sample = strideSample(matrix, sampleLimit);
    let sum = 0;
    let count = 0;
    for (let i = 0; i < sample.length; i++) {
        for (let j = i + 1; j < sample.length; j++) {
            sum += euclidean(sample[i], sample[j]);
            count++;
        }
    }
    return Math.max(factor * (count > 0 ? sum / count : 0), 1e-9);
}
function pointwiseMeanshift(data, bandwidth, kernelCenter, maxIteration = 100, epsilon = 1e-4) {
    const sqBandwidth = bandwidth * bandwidth;
    let center = kernelCenter;
    let nn = data.filter((row) => squED(center, row) <= sqBandwidth);
    while (maxIteration-- > 0 && nn.length > 0) {
        const newCenter = nn
            .reduce((acc, el) => acc.map((dim, n) => el[n] + dim))
            .map((e) => e / nn.length);
        if (euclidean(center, newCenter) <= epsilon)
            break;
        const newNN = data.filter((row) => squED(newCenter, row) <= sqBandwidth);
        if (newNN.length === 0)
            break;
        center = newCenter;
        nn = newNN;
    }
    return center;
}
function mergeCenters(centers, threshold) {
    const merged = [];
    for (const center of centers) {
        const near = merged.find((m) => euclidean(m.center, center) < threshold);
        if (near) {
            near.center = near.center.map((v, n) => (v * near.count + center[n]) / (near.count + 1));
            near.count++;
        }
        else {
            merged.push({ center: [...center], count: 1 });
        }
    }
    return merged.map((m) => m.center);
}
/** Converge → merge → hard-assign, i.e. everything the rewrite replaced. */
export function legacyCluster(matrix, params) {
    let seeds = uniqueRows(matrix);
    const bandwidth = estimateBandwidth(matrix);
    if (seeds.length > params.maxSeeds)
        seeds = strideSample(seeds, params.maxSeeds);
    const converged = seeds.map((seed) => pointwiseMeanshift(matrix, bandwidth, seed.row, params.maxIteration, params.epsilon));
    const centers = mergeCenters(converged, bandwidth * params.mergeFactor);
    const assignments = matrix.map((row) => {
        let best = 0;
        let bestDist = Infinity;
        for (let k = 0; k < centers.length; k++) {
            const dist = squED(row, centers[k]);
            if (dist < bestDist) {
                bestDist = dist;
                best = k;
            }
        }
        return best;
    });
    return { k: centers.length, assignments };
}
