/**
 * Old vs new clustering, same data, same parameters.
 *
 *   npx tsx scripts/clusterBenchmark.ts
 *
 * The legacy implementation is the original worker's pipeline, ported verbatim
 * into `bench/legacyMeanshift.ts`. Sizes stop where the legacy path stops being
 * measurable in reasonable time — which is itself the finding.
 */
import { legacyCluster } from "../bench/legacyMeanshift.ts";
import { buildDurationMatrices } from "../src/core/cluster/matrices.ts";
import { TypologyClusterer } from "../src/core/cluster/meanshift.ts";
import { CLUSTER_DEFAULTS } from "../src/core/cluster/types.ts";
import { buildStore } from "../src/core/model/build.ts";
import { buildTypologies } from "../src/core/stats/typologies.ts";
function mulberry32(seed) {
    let a = seed;
    return () => {
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
/** One typology, `n` patients, three latent speed groups. */
function makeRecords(n, states, seed = 7) {
    const random = mulberry32(seed);
    const trajectory = Array.from({ length: states }, (_, i) => `s${i}`);
    const gaps = [1, 6, 14];
    return Array.from({ length: n }, (_, i) => {
        const gap = gaps[i % gaps.length];
        let age = 20;
        let year = 1990;
        const ages = [];
        const years = [];
        for (let k = 0; k < states; k++) {
            ages.push(age);
            years.push(year);
            const step = gap * (0.85 + random() * 0.3);
            age += step;
            year += step;
        }
        return {
            id: `P${i}`,
            trajectory,
            switchEventAge: ages,
            years,
            diseaseDuration: years.at(-1) - years[0],
        };
    });
}
function toNested(rows, n, d) {
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
        const row = new Array(d);
        for (let k = 0; k < d; k++)
            row[k] = rows[i * d + k];
        out[i] = row;
    }
    return out;
}
const time = (label, fn) => {
    const t0 = performance.now();
    fn();
    const ms = performance.now() - t0;
    void label;
    return ms;
};
const SIZES = [500, 2_000, 8_000, 25_000];
const STATES = 5;
/** Above this the legacy path takes minutes; measuring it once is enough. */
const LEGACY_LIMIT = 8_000;
console.log(`\nMean-shift: original vs rewrite — ${STATES} states (d=${STATES - 1}), 3 latent groups`);
console.log("─".repeat(74));
console.log([
    "patients".padStart(9),
    "original".padStart(11),
    "layout".padStart(10),
    "+pruning".padStart(10),
    "speedup".padStart(9),
    "clusters".padStart(14),
].join(""));
console.log("─".repeat(74));
for (const n of SIZES) {
    const store = buildStore(makeRecords(n, STATES));
    const matrix = buildDurationMatrices(store, buildTypologies(store))[0];
    if (matrix === undefined)
        continue;
    // Warm the JIT so the first size is not penalised.
    const warm = new TypologyClusterer(matrix, CLUSTER_DEFAULTS);
    while (!warm.step(1000))
        ;
    warm.finalize();
    // Pruning off: the same work the original did, only with the new data layout.
    let strictK = 0;
    const strictMs = time("strict", () => {
        const clusterer = new TypologyClusterer(matrix, { ...CLUSTER_DEFAULTS, seedPruneFactor: 0 });
        while (!clusterer.step(1000))
            ;
        strictK = clusterer.finalize().k;
    });
    let newK = 0;
    const newMs = time("new", () => {
        const clusterer = new TypologyClusterer(matrix, CLUSTER_DEFAULTS);
        while (!clusterer.step(1000))
            ;
        newK = clusterer.finalize().k;
    });
    let legacyMs = Number.NaN;
    let legacyK = 0;
    if (n <= LEGACY_LIMIT) {
        const nested = toNested(matrix.rows, matrix.n, matrix.d);
        legacyMs = time("legacy", () => {
            legacyK = legacyCluster(nested, {
                maxSeeds: CLUSTER_DEFAULTS.maxSeeds,
                maxIteration: CLUSTER_DEFAULTS.maxIteration,
                epsilon: CLUSTER_DEFAULTS.epsilon,
                mergeFactor: CLUSTER_DEFAULTS.mergeFactor,
            }).k;
        });
    }
    const speedup = Number.isNaN(legacyMs) ? "—" : `${(legacyMs / newMs).toFixed(0)}x`;
    const legacyLabel = Number.isNaN(legacyMs) ? "not run" : `${legacyMs.toFixed(0)} ms`;
    const clusters = Number.isNaN(legacyMs)
        ? `${strictK} / ${newK}`
        : `${legacyK} / ${strictK} / ${newK}`;
    console.log([
        n.toLocaleString().padStart(9),
        legacyLabel.padStart(11),
        `${strictMs.toFixed(1)} ms`.padStart(10),
        `${newMs.toFixed(1)} ms`.padStart(10),
        speedup.padStart(9),
        clusters.padStart(14),
    ].join(""));
}
console.log("─".repeat(74));
console.log("layout   = columnar + fused loop + grid, every seed converged (seedPruneFactor 0)");
console.log("+pruning = also skips seeds already inside a known basin (the default)");
console.log("clusters = original / layout / +pruning — all three should agree\n");
