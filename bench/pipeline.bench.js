import { bench, describe } from "vitest";
import { buildStore } from "../src/core/model/build.ts";
import { spliceStates } from "../src/core/model/reshape.ts";
import { readDelimitedRows } from "../src/core/parse/delimited.ts";
import { ingest } from "../src/core/parse/ingest.ts";
import { applyFilters, emptyFilters } from "../src/core/query/filters.ts";
import { Selection } from "../src/core/query/Selection.ts";
import { buildGeometry, rowLookup } from "../src/core/render/geometry.ts";
import { buildPalette } from "../src/core/render/palette.ts";
import { SegmentIndex } from "../src/core/render/picking.ts";
import { orderStates, summariseStates } from "../src/core/stats/states.ts";
import { buildTypologies } from "../src/core/stats/typologies.ts";
import { makeRecords, makeTsv } from "./fixtures.ts";
/**
 * The numbers that decide whether the rewrite was worth it.
 *
 * Every stage is benchmarked independently so a regression points at one file.
 * `applyFilters` and `buildGeometry` are the two on the interactive path — they
 * run while the user drags a slider, so they are the ones with a frame budget.
 */
const SIZES = [25_000, 250_000];
for (const patients of SIZES) {
    describe(`${patients.toLocaleString()} patients`, () => {
        const records = makeRecords(patients);
        const store = buildStore(records);
        const tsv = makeTsv(records);
        const json = JSON.stringify(records.map((r) => ({
            FINNGENID: r.id,
            trajectory: r.trajectory,
            SwitchEventAge: r.switchEventAge,
            years: r.years,
            diseaseDuration: r.diseaseDuration,
        })));
        const summaries = summariseStates(store);
        const order = orderStates(summaries);
        const palette = buildPalette(store.stateNames.length);
        const rowOf = rowLookup(store.stateNames.length, order.map(Number));
        const selection = new Selection(store.patientCount);
        const COLOR_OPTIONS = {
            axis: "age",
            color: { kind: "state", palette },
            durationRange: null,
        };
        /*
         * Removing a state re-derives the dataset, so this is the cost of one click
         * in the states panel: the splice plus the two aggregate passes over the
         * result. It runs on the main thread, so these three together are the number
         * that decides whether that stays acceptable.
         */
        const removedMask = new Uint8Array(store.stateNames.length);
        removedMask[0] = 1;
        bench("reshape · splice one state", () => {
            spliceStates(store, removedMask);
        });
        bench("reshape · whole re-derive", () => {
            const spliced = spliceStates(store, removedMask);
            orderStates(summariseStates(spliced));
            buildTypologies(spliced);
        });
        bench("ingest · json", () => {
            ingest(json, "bench.json");
        });
        bench("ingest · tsv", () => {
            ingest(tsv, "bench.tsv");
        });
        bench("tokenise · tsv", () => {
            readDelimitedRows(tsv);
        });
        bench("build store", () => {
            buildStore(records);
        });
        bench("summarise states", () => {
            summariseStates(store);
        });
        bench("group typologies", () => {
            buildTypologies(store);
        });
        // --- interactive path: these must fit in a frame ---
        bench("filter (in place)", () => {
            applyFilters(store, { ...emptyFilters, diseaseDuration: { min: 10, max: 60 } }, selection);
        });
        bench("build geometry", () => {
            buildGeometry(store, selection.indices(), COLOR_OPTIONS);
        });
        const geometry = buildGeometry(store, selection.indices(), COLOR_OPTIONS);
        bench("build pick index", () => {
            SegmentIndex.build(geometry, order.length, store.extents.age, rowOf);
        });
        const index = SegmentIndex.build(geometry, order.length, store.extents.age, rowOf);
        bench("pick (1000 queries)", () => {
            for (let i = 0; i < 1000; i++) {
                index.pick(store.extents.age[0] + (i / 1000) * 40, i % order.length, 0.35);
            }
        });
    });
}
