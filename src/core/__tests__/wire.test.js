import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { useEras } from "../../app/store.ts";
import { toStatePayload } from "../../workers/protocol.ts";
import { buildDurationMatrices, matrixTransferables } from "../cluster/matrices.ts";
import { fromPayload, payloadTransferables, toPayload } from "../model/transfer.ts";
import { ingest } from "../parse/ingest.ts";
import { emptyFilters } from "../query/filters.ts";
import { Selection } from "../query/Selection.ts";
import { buildGeometry } from "../render/geometry.ts";
import { buildPalette } from "../render/palette.ts";
import { orderStates, summariseStates } from "../stats/states.ts";
import { buildTypologies } from "../stats/typologies.ts";
/**
 * The worker boundary, which unit tests otherwise never cross: they all build a
 * store in one realm and use it there. Here the payload is cloned *with the real
 * transfer list*, which detaches the source buffers exactly as `postMessage`
 * does, and the result is driven through the store.
 */
const overTheWire = () => {
    const text = readFileSync("public/data/data_demo.tsv", "utf8");
    const { store: source } = ingest(text, "data_demo.tsv");
    const states = summariseStates(source);
    const payload = toPayload(source);
    const response = {
        store: payload,
        states: states.map(toStatePayload),
        stateOrder: orderStates(states).map(Number),
    };
    const transfer = [
        ...payloadTransferables(payload),
        ...response.states.map((s) => s.frequencies.buffer),
    ];
    return fromPayload(structuredClone(response, { transfer }).store);
};
describe("the worker boundary", () => {
    it("delivers a store whose columns survived the transfer", () => {
        const store = overTheWire();
        expect(store.patientCount).toBeGreaterThan(0);
        expect(store.offsets.length).toBe(store.patientCount + 1);
        expect(store.stateIds.length).toBe(store.eventCount);
        expect(store.offsets[store.patientCount]).toBe(store.eventCount);
        // A detached buffer reads as length 0, which is the failure this guards.
        expect(store.ages.length).toBe(store.eventCount);
        expect(store.ids.at(0).length).toBeGreaterThan(0);
    });
    it("narrows on the first typology selection after a load", () => {
        const store = overTheWire();
        const typologies = buildTypologies(store);
        // What `receive` sets up.
        useEras.setState({
            store,
            baseStore: store,
            cohortSize: store.patientCount,
            typologies,
            stateOrder: [...store.stateNames.keys()],
            visibleStates: [...store.stateNames.keys()],
            selection: new Selection(store.patientCount),
            population: new Selection(store.patientCount),
            filters: emptyFilters,
            selectedTypologies: [],
            pathSteps: [],
        });
        const target = typologies[0];
        useEras.getState().toggleTypology(target.key);
        const state = useEras.getState();
        expect(state.selection?.count).toBe(target.size);
        expect(state.selection?.indices().length).toBe(target.size);
        // …and that selection has something to draw.
        const geometry = buildGeometry(store, state.selection?.indices(), {
            axis: "age",
            color: { kind: "state", palette: buildPalette(store.stateNames.length) },
            durationRange: null,
        });
        expect(geometry.segmentCount).toBeGreaterThan(0);
    });
});
describe("the clustering boundary", () => {
    it("leaves the typologies usable after a run is dispatched", () => {
        const store = overTheWire();
        const typologies = buildTypologies(store);
        const before = typologies.map((t) => t.patients.length);
        // Exactly what `ClusterClient.run` does with them.
        const matrices = buildDurationMatrices(store, typologies);
        structuredClone({ matrices }, { transfer: matrices.flatMap(matrixTransferables) });
        // A transferred buffer is detached on this side and reads as length 0. The
        // matrices must own theirs, or dispatching a run empties the membership
        // list of every typology in the store — and every selection after it.
        expect(typologies.map((t) => t.patients.length)).toEqual(before);
        for (const typology of typologies) {
            expect(typology.patients.length).toBe(typology.size);
        }
    });
    it("still narrows on the first selection after a run is dispatched", () => {
        const store = overTheWire();
        const typologies = buildTypologies(store);
        useEras.setState({
            store,
            baseStore: store,
            cohortSize: store.patientCount,
            typologies,
            stateOrder: [...store.stateNames.keys()],
            visibleStates: [...store.stateNames.keys()],
            selection: new Selection(store.patientCount),
            population: new Selection(store.patientCount),
            filters: emptyFilters,
            selectedTypologies: [],
            pathSteps: [],
        });
        const matrices = buildDurationMatrices(store, typologies);
        structuredClone({ matrices }, { transfer: matrices.flatMap(matrixTransferables) });
        const target = typologies[0];
        useEras.getState().toggleTypology(target.key);
        expect(useEras.getState().selection?.count).toBe(target.size);
    });
});
