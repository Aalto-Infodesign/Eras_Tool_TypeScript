import { describe, expect, it } from "vitest";
import { buildStore } from "../model/build.ts";
import { rowLookup } from "../render/geometry.ts";
import { buildRibbon, buildRibbons } from "../render/ribbons.ts";
import { orderStates, summariseStates } from "../stats/states.ts";
import { buildTypologies } from "../stats/typologies.ts";
/**
 * Two typologies. `abc` patients walk a→b→c and arrive later and later as `i`
 * grows; `ac` patients skip b entirely. Sizes differ so thickness is testable.
 */
function records(abc, ac) {
    const out = [];
    for (let i = 0; i < abc; i++) {
        out.push({
            id: `abc_${i}`,
            trajectory: ["a", "b", "c"],
            switchEventAge: [20 + i, 30 + i, 40 + i],
            years: [2000 + i, 2010 + i, 2020 + i],
            diseaseDuration: 20,
        });
    }
    for (let i = 0; i < ac; i++) {
        out.push({
            id: `ac_${i}`,
            trajectory: ["a", "c"],
            switchEventAge: [20 + i, 60 + i],
            years: [2000 + i, 2040 + i],
            diseaseDuration: 40,
        });
    }
    return out;
}
function fixture(abc, ac) {
    const store = buildStore(records(abc, ac));
    const typologies = buildTypologies(store);
    const order = orderStates(summariseStates(store)).map(Number);
    return {
        store,
        groups: typologies.map((typology, index) => ({
            index,
            label: typology.key,
            patients: typology.patients,
        })),
        rowOf: rowLookup(store.stateNames.length, order),
    };
}
const options = (rowOf, visible = null) => ({
    axis: "age",
    rowOf,
    maxHalfWidth: 0.4,
    sampleLimit: 500,
    visible,
});
describe("typology ribbons", () => {
    it("summarises a typology as a median path through its own states", () => {
        const { store, groups, rowOf } = fixture(9, 5);
        const abc = groups.find((group) => group.label === "a-b-c");
        const ribbon = buildRibbon(store, abc, { ...options(rowOf), maxSize: 9 });
        // One position per state in the typology's sequence, not per state in the data.
        expect(ribbon.x).toHaveLength(3);
        // Ages run 20..28, 30..38, 40..48 — the medians are the middle patient's.
        expect(ribbon.x[0]).toBeCloseTo(24);
        expect(ribbon.x[1]).toBeCloseTo(34);
        expect(ribbon.x[2]).toBeCloseTo(44);
        // The interquartile band straddles the median.
        expect(ribbon.spreadLow[2]).toBeLessThan(ribbon.x[2]);
        expect(ribbon.spreadHigh[2]).toBeGreaterThan(ribbon.x[2]);
        // Rows come from the shared vertical ordering, so the layers stay registered.
        expect(new Set(Array.from(ribbon.row)).size).toBe(3);
    });
    it("ranks by size and scales thickness with it", () => {
        const { store, groups, rowOf } = fixture(40, 10);
        const ribbons = buildRibbons(store, groups, 10, options(rowOf));
        expect(ribbons.map((ribbon) => ribbon.label)).toEqual(["a-b-c", "a-c"]);
        expect(ribbons[0].size).toBe(40);
        expect(ribbons[0].halfWidth[0]).toBeGreaterThan(ribbons[1].halfWidth[0]);
        // sqrt scaling, not linear: four times the patients is twice the thickness.
        expect(ribbons[0].halfWidth[0] / ribbons[1].halfWidth[0]).toBeCloseTo(2);
    });
    it("caps how many shapes it returns, keeping the largest", () => {
        const { store, groups, rowOf } = fixture(40, 10);
        const ribbons = buildRibbons(store, groups, 1, options(rowOf));
        expect(ribbons).toHaveLength(1);
        expect(ribbons[0].label).toBe("a-b-c");
    });
    it("aggregates only the patients the filter leaves visible", () => {
        const { store, groups, rowOf } = fixture(40, 10);
        const visible = new Uint8Array(store.patientCount);
        for (let p = 0; p < 10; p++)
            visible[p] = 1; // the first ten `abc` patients
        const ribbons = buildRibbons(store, groups, 10, options(rowOf, visible));
        // The `ac` typology has no visible member left, so it gets no shape at all.
        expect(ribbons).toHaveLength(1);
        expect(ribbons[0].size).toBe(10);
        // And the median follows the survivors (ages 20..29), not the whole group.
        expect(ribbons[0].x[0]).toBeCloseTo(24.5);
    });
    it("keeps the group's identity index, which is what selection and colour use", () => {
        const { store, groups, rowOf } = fixture(5, 40);
        const ribbons = buildRibbons(store, groups, 10, options(rowOf));
        // Ranked by size, but each ribbon still reports the index of its own group.
        for (const ribbon of ribbons) {
            const group = groups.find((candidate) => candidate.index === ribbon.index);
            expect(group.label).toBe(ribbon.label);
        }
    });
});
