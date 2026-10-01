/**
 * End-to-end: cluster every typology of a whole dataset, the way the worker does.
 *
 *   npx tsx scripts/clusterFullRun.ts public/data/generated/data_250k.json
 */
import { readFileSync } from "node:fs";
import { buildDurationMatrices } from "../src/core/cluster/matrices.ts";
import { singleCluster, TypologyClusterer } from "../src/core/cluster/meanshift.ts";
import { ClusterRunBuilder } from "../src/core/cluster/run.ts";
import { CLUSTER_DEFAULTS } from "../src/core/cluster/types.ts";
import { ingest } from "../src/core/parse/ingest.ts";
import { buildTypologies } from "../src/core/stats/typologies.ts";
const path = process.argv[2] ?? "public/data/generated/data_250k.json";
const text = readFileSync(path, "utf8");
let t = performance.now();
const { store } = ingest(text, path);
const ingestMs = performance.now() - t;
t = performance.now();
const typologies = buildTypologies(store);
const typologyMs = performance.now() - t;
t = performance.now();
const matrices = buildDurationMatrices(store, typologies);
const matrixMs = performance.now() - t;
const builder = new ClusterRunBuilder(store.patientCount, CLUSTER_DEFAULTS);
t = performance.now();
let firstResultMs = 0;
let clustered = 0;
for (const matrix of matrices) {
    let result;
    if (matrix.n < CLUSTER_DEFAULTS.minSize) {
        result = singleCluster(matrix);
    }
    else {
        const clusterer = new TypologyClusterer(matrix, CLUSTER_DEFAULTS);
        while (!clusterer.step(14))
            ;
        result = clusterer.finalize();
    }
    builder.add(result);
    clustered += 1;
    if (clustered === 1)
        firstResultMs = performance.now() - t;
}
const clusterMs = performance.now() - t;
const run = builder.snapshot();
let assigned = 0;
for (let p = 0; p < store.patientCount; p++)
    if (run.clusterOfPatient[p] !== -1)
        assigned += 1;
console.log(`\n${path}`);
console.log("─".repeat(58));
console.log(`patients                 ${store.patientCount.toLocaleString()}`);
console.log(`events                   ${store.eventCount.toLocaleString()}`);
console.log(`typologies               ${typologies.length.toLocaleString()}`);
console.log(`clusters found           ${run.clusters.length.toLocaleString()}`);
console.log(`patients assigned        ${assigned.toLocaleString()} (${((assigned / store.patientCount) * 100).toFixed(1)}%)`);
console.log("─".repeat(58));
console.log(`ingest                   ${ingestMs.toFixed(0)} ms`);
console.log(`typologies               ${typologyMs.toFixed(0)} ms`);
console.log(`duration matrices        ${matrixMs.toFixed(0)} ms`);
console.log(`clustering (all)         ${clusterMs.toFixed(0)} ms`);
console.log(`  first typology done    ${firstResultMs.toFixed(0)} ms  <- chart is useful here`);
console.log("─".repeat(58) + "\n");
