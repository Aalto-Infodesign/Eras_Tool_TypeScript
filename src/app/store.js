import { create } from "zustand";
import { CLUSTERING_ENABLED } from "./features.ts";
import { buildDurationMatrices } from "../core/cluster/matrices.ts";
import { ClusterRunBuilder } from "../core/cluster/run.ts";
import { CLUSTER_DEFAULTS } from "../core/cluster/types.ts";
import { countLivePatients, spliceStates } from "../core/model/reshape.ts";
import { fromPayload } from "../core/model/transfer.ts";
import { applyFilters, emptyFilters, filterFailures, intersectTypologies, UNSELECTED, } from "../core/query/filters.ts";
import { visibleExtent } from "../core/query/extent.ts";
import { activeSteps, isolatedClusters, reconcileOrder, } from "../core/query/pipeline.ts";
import { emptyHistory, pushHistory, redo, snapshotOf, undo, } from "../core/query/history.ts";
import { Selection } from "../core/query/Selection.ts";
import { effectiveSteps, matchesSteps, } from "../core/stats/pathTree.ts";
import { buildDistributions } from "../core/stats/distributions.ts";
import { samePin } from "../core/stats/sankey.ts";
import { summariseStates } from "../core/stats/states.ts";
import { buildTypologies } from "../core/stats/typologies.ts";
import { Stopwatch } from "../core/util/time.ts";
import { ClusterClient } from "../workers/clusterClient.ts";
import { IngestClient } from "../workers/ingestClient.ts";
/**
 * How many typologies are selected decides how the chart reads, so nothing
 * stores it:
 *
 * - **exactly one** — that typology alone, on *its own steps* (a rule per visit,
 *   so a revisited state does not fold back).
 * - **anything else** — one panel per typology, as small multiples. With none
 *   selected that is the biggest few, which is what the Trajectories view shows
 *   before anything is picked.
 *
 * Overlaying several typologies in a single frame used to be the middle case
 * and was the weakest reading in the app: they shared rows, so the paths
 * crossed and the slope of any one of them — the thing being compared — was
 * lost in the others. The grid answers that question properly, which leaves the
 * single-typology chart to do the one thing it is good at.
 *
 * Derived rather than stored because a stored copy is a second source of truth
 * for something the selection already says, and the two drift.
 */
export function chartModeOf(selected) {
    return selected.length === 1 ? "overlay" : "multiples";
}
/** The typology the chart is drawn along, when exactly one is selected. */
export function focusedTypologyOf(selected) {
    return selected.length === 1 ? selected[0] : null;
}
/**
 * The back target after a selection change: recorded on the way *into* the
 * single chart, kept while it stays on screen — picking a cluster inside it is
 * not a new place to come back from — and dropped once the chart is left.
 */
function nextFocusReturn(state, nextSelected, nextView) {
    if (nextView !== "trajectories" || focusedTypologyOf(nextSelected) === null)
        return null;
    const onSingleChart = state.view === "trajectories" && focusedTypologyOf(state.selectedTypologies) !== null;
    return onSingleChart ? state.focusReturn : { view: state.view, snapshot: snapshotOf(state) };
}
/**
 * The typologies a path selection picks: every one that starts with the walk
 * in progress or with any expectation switched on — the union, so saved routes
 * merge. `[]`, the whole cohort, when there is neither.
 *
 * Saved paths are read through the removed states (see `effectiveSteps`); one
 * that a removal empties picks nobody rather than everybody.
 */
function pathSelection(typologies, steps, expectations, active, removed) {
    const removedSet = new Set(removed);
    const paths = expectations
        .filter((expectation) => active.includes(expectation.id))
        .map((expectation) => effectiveSteps(expectation.steps, removedSet))
        .filter((path) => path.length > 0);
    if (steps.length > 0)
        paths.push(steps);
    if (paths.length === 0)
        return [];
    return typologies
        .filter((typology) => paths.some((path) => matchesSteps(typology.states, path)))
        .map((typology) => typology.key);
}
/** Set equality over state ids, which arrive in click order, not sorted. */
function sameStates(a, b) {
    const left = a ?? [];
    if (left.length !== b.length)
        return false;
    const seen = new Set(left);
    return b.every((state) => seen.has(state));
}
/**
 * Whether the clustering on hand still describes the data on screen.
 *
 * See `clusterRemovedStates`. Derived, never stored: a flag set by whoever
 * remembers to set it is a second source of truth, and this one would go wrong
 * silently — a stale run does not fail, it quietly matches nothing.
 */
export const clusterStale = (state) => state.clusterRun !== null && !sameStates(state.clusterRemovedStates, state.filters.removedStates);
/**
 * The run to draw with and join against — `null` for as long as it is stale.
 *
 * Everything that *uses* results goes through here rather than reading
 * `clusterRun` directly, so a stale run is invisible in exactly one place
 * instead of being something each of five call sites has to remember. The one
 * place that reads the raw field is the control offering to re-run it, which has
 * to know a run exists in order to say it is out of date.
 */
export const clusterRunOf = (state) => clusterStale(state) ? null : state.clusterRun;
const client = new IngestClient();
const clusterClient = new ClusterClient();
/** How often streamed cluster results are pushed into the store. */
const CLUSTER_FLUSH_MS = 120;
/** Probed once at module load; the UI can still override it to compare backends. */
function detectRendererKind() {
    if (typeof document === "undefined")
        return "canvas2d";
    try {
        return document.createElement("canvas").getContext("webgl2") === null ? "canvas2d" : "webgl2";
    }
    catch {
        return "canvas2d";
    }
}
const initial = {
    status: "idle",
    error: null,
    fileName: null,
    store: null,
    baseStore: null,
    cohortSize: 0,
    states: [],
    stateOrder: [],
    visibleStates: [],
    baseStateOrder: [],
    reshapeTimings: [],
    typologies: [],
    mapping: null,
    timings: [],
    selection: null,
    population: null,
    selectionVersion: 0,
    filters: emptyFilters,
    distributions: null,
    selectionDistributions: null,
    pipelineOrder: [],
    selectedTypologies: [],
    pathSteps: [],
    expectations: [],
    activeExpectations: [],
    selectionHistory: emptyHistory,
    focusReturn: null,
    workspaceOpen: false,
    view: "trajectories",
    sankeyOrder: "state",
    sankeyMetric: "duration",
    sankeyPin: null,
    sankeyCompare: null,
    axis: "age",
    xDomainOverride: null,
    rendererKind: detectRendererKind(),
    opacity: 0.35,
    hoveredPatient: null,
    selectedPatients: [],
    hoveredCluster: null,
    hoveredTypology: null,
    clusterStatus: "idle",
    clusterError: null,
    clusterProgress: { done: 0, total: 0 },
    clusterRun: null,
    clusterVersion: 0,
    clusterRemovedStates: null,
    clusterPreviews: new Map(),
    clusterParams: CLUSTER_DEFAULTS,
    selectedClusters: [],
    colorBy: "state",
    layers: { lines: false, lumps: false, medoids: true },
    showMedoids: true,
};
export const useEras = create()((set, get) => {
    /** Per-patient filter failures for `selectionDistributions`, reused across scans. */
    let failures = new Uint8Array(0);
    /**
     * Recomputes the mask in place and bumps the version. Never allocates a new
     * Selection, so this is safe to call from a pointer-move handler.
     */
    const recompute = () => {
        const { store, selection, population, filters, selectedTypologies, typologies } = get();
        if (store === null || selection === null || population === null)
            return;
        /*
         * Two scans, not one. `population` stops at the filters that describe *who
         * is in the study* — age, calendar span, disease duration — while
         * `selection` goes on to apply the narrowing ones: the per-segment duration
         * filter and any chosen typologies. The box plots need both, because their
         * whiskers show exactly what the narrowing left out. A second linear pass
         * over a byte-per-patient mask is a rounding error next to rebuilding the
         * geometry that follows it.
         */
        applyFilters(store, { ...filters, duration: null }, population);
        applyFilters(store, filters, selection);
        let selectionDistributions = null;
        if (selectedTypologies.length > 0) {
            // A Set, not `includes`: a path selection can name hundreds of typologies
            // at once, and the quadratic scan that was fine for a handful of clicked
            // cards is not fine for "everyone who started with this state".
            const keys = new Set(selectedTypologies);
            const chosen = [];
            for (const typology of typologies) {
                if (keys.has(typology.key))
                    chosen.push(typology.patients);
            }
            intersectTypologies(selection, chosen);
            /*
             * The sliders' subplots. A third scan, and an exhaustive one, so it only
             * runs while a selection exists: with nothing chosen the subplots would
             * just be the whole-dataset curves again.
             */
            if (failures.length !== store.patientCount)
                failures = new Uint8Array(store.patientCount);
            filterFailures(store, filters, failures);
            for (let p = 0; p < failures.length; p++)
                failures[p] = failures[p] | UNSELECTED;
            for (const patients of chosen) {
                for (let i = 0; i < patients.length; i++) {
                    const p = patients[i];
                    failures[p] = failures[p] & ~UNSELECTED;
                }
            }
            selectionDistributions = buildDistributions(store, failures);
        }
        set({ selectionVersion: get().selectionVersion + 1, selectionDistributions });
    };
    /**
     * `next` plus the history entry it earns, for the same `set` as the change
     * itself — so no render ever sees the new selection with the old history.
     *
     * Every selection-changing action goes through here, which is what lets undo
     * see a change made anywhere: the original's history lived inside its chart,
     * so it missed every change made outside it and was lost on a view switch. A
     * change that selects the same thing leaves the history as it was.
     */
    const withHistory = (next) => {
        const state = get();
        const previous = snapshotOf(state);
        return {
            ...next,
            selectionHistory: pushHistory(state.selectionHistory, previous, { ...previous, ...next }),
            focusReturn: nextFocusReturn(state, next.selectedTypologies ?? state.selectedTypologies, next.view ?? state.view),
        };
    };
    /** Puts a snapshot from the history back, as one write, and re-derives the masks. */
    const restore = (snapshot, selectionHistory) => {
        const state = get();
        set({
            ...snapshotOf(snapshot),
            selectionHistory,
            focusReturn: nextFocusReturn(state, snapshot.selectedTypologies, state.view),
            // As every other selection change: a hovered cluster belongs to the
            // typology that was drawn, which may no longer be.
            hoveredCluster: null,
        });
        recompute();
    };
    /**
     * Re-derives the dataset and everything downstream of it.
     *
     * Removing a state is not a filter. As in the original, it edits the source:
     * the state is spliced out of every trajectory and then typologies,
     * populations, the row ordering's inputs and every axis extent are rebuilt
     * over what is left. Two patients whose paths differed only by the removed
     * state become the *same* typology; a filter could never do that.
     *
     * The cost is the ingest's aggregate passes, not the ingest — no parse, no
     * store construction from records, just a linear copy and the two summaries.
     * It runs on the main thread because a state toggle is a deliberate, occasional
     * click rather than a drag, and the HUD reports what it cost.
     *
     * `stateOrder` is *not* rederived from the new summaries: it is the user's
     * ordering, and rebuilding it here would yank the rows around on every
     * removal. The original had exactly that bug.
     */
    const syncStates = (nextRemoved) => {
        const { baseStore, stateOrder, filters, selectedTypologies } = get();
        if (baseStore === null)
            return;
        const order = stateOrder;
        const removedStates = nextRemoved ?? filters.removedStates;
        /*
         * A reorder leaves both the state ids and the typology keys alone, so a
         * path selection survives it untouched. A removal does neither: the state
         * the path steps through may be gone, and the typologies it named merge
         * into others. There is no honest way to carry a path across that.
         */
        const reshaped = removedStates.length !== filters.removedStates.length ||
            removedStates.some((state, i) => filters.removedStates[i] !== state);
        const removedSet = new Set(removedStates);
        /*
         * Whether this reshape puts the clustering out of date — see
         * `clusterRemovedStates`. Asked through the same predicate the UI reads, so
         * there is one definition of "stale" rather than one here and one there.
         * Note it is not simply `reshaped`: restoring exactly what was removed
         * splices back to the same store, which makes an existing run valid again.
         */
        const goesStale = clusterStale({
            clusterRun: get().clusterRun,
            clusterRemovedStates: get().clusterRemovedStates,
            filters: { ...filters, removedStates },
        });
        /*
         * A run still streaming is deliberately left alone. Its results are
         * consistent with the matrices it was given — those were transferred and
         * describe the old store — so letting it finish leaves a *complete* run to
         * come back to if the state is restored, and re-clustering supersedes it in
         * the worker anyway. Cancelling here would trade that for a partial run
         * indistinguishable from a whole one.
         */
        const layers = get().layers;
        const clock = new Stopwatch();
        let store = baseStore;
        let states = get().states;
        let typologies = get().typologies;
        if (removedStates.length > 0) {
            const mask = new Uint8Array(baseStore.stateNames.length);
            for (const state of removedStates) {
                if (state >= 0 && state < mask.length)
                    mask[state] = 1;
            }
            store = clock.measure("splice states", () => spliceStates(baseStore, mask));
        }
        // Recomputed either way: restoring a state has to undo the last splice's
        // aggregates just as removing one replaced them.
        const distributions = clock.measure("filter histograms", () => buildDistributions(store));
        const cohortSize = countLivePatients(store);
        const summaries = clock.measure("summarise states", () => summariseStates(store));
        states = summaries.map((summary) => ({
            id: Number(summary.id),
            name: summary.name,
            population: summary.population,
            frequencies: summary.frequencies,
        }));
        typologies = clock.measure("group typologies", () => buildTypologies(store));
        const keys = new Set(typologies.map((typology) => typology.key));
        set({
            store,
            cohortSize,
            states,
            typologies,
            distributions,
            // A splice merges typologies, so a selected key can simply cease to exist.
            // Expectations switched on are the exception: a saved path reads through
            // the removal, so they pick again from the new typologies.
            selectedTypologies: reshaped
                ? pathSelection(typologies, [], get().expectations, get().activeExpectations, removedStates)
                : selectedTypologies.filter((key) => keys.has(key)),
            pathSteps: reshaped ? [] : get().pathSteps,
            // Holds typology keys, as the history does.
            focusReturn: reshaped ? null : get().focusReturn,
            // Both index a run that no longer describes anything on screen: a global
            // cluster index means nothing once the typologies behind it have merged.
            selectedClusters: reshaped ? [] : get().selectedClusters,
            hoveredCluster: reshaped ? null : get().hoveredCluster,
            clusterPreviews: reshaped ? new Map() : get().clusterPreviews,
            // A pin is a (step, state) and history and hover hold typology keys. A
            // splice moves later states to earlier steps and merges keys, so none of
            // them names the same thing afterwards.
            sankeyPin: reshaped ? null : get().sankeyPin,
            sankeyCompare: reshaped ? null : get().sankeyCompare,
            selectionHistory: reshaped ? emptyHistory : get().selectionHistory,
            hoveredTypology: reshaped ? null : get().hoveredTypology,
            /*
             * Medoids alone, over a run that just went stale, is an empty chart — the
             * same failure `toggleLayer` refuses to let anyone click their way into.
             * The hairlines are drawable whatever the clustering says, so they take
             * over until the run is redone. Removing a state should change the shape
             * of the picture, not blank it.
             */
            layers: goesStale && layers.medoids && !layers.lines && !layers.lumps
                ? { ...layers, lines: true }
                : layers,
            stateOrder: order,
            visibleStates: order.filter((state) => !removedSet.has(state)),
            reshapeTimings: removedStates.length > 0 ? clock.timings : [],
            filters: { ...filters, removedStates },
            // Hover and picking address the old geometry; both are rebuilt from here.
            hoveredPatient: null,
            // A splice moves the extents, so a fitted axis no longer fits anything.
            xDomainOverride: null,
        });
        recompute();
    };
    const receive = (fileName, result) => {
        const store = fromPayload(result.store);
        const selection = new Selection(store.patientCount);
        const population = new Selection(store.patientCount);
        /*
         * Typologies are grouped here rather than shipped from the worker.
         *
         * They are pure derivation over the store, and a reshape already has to
         * redo them (`syncStates`). Having the load path get them one way and every
         * later path get them another meant the app ran on a structure only one of
         * those paths ever produced — and the two are impossible to keep honest,
         * because nothing downstream can tell them apart until membership is used.
         * One producer, one code path, exercised on every reorder.
         */
        const clock = new Stopwatch();
        const typologies = clock.measure("group typologies", () => buildTypologies(store));
        set({
            status: "ready",
            error: null,
            fileName,
            store,
            baseStore: store,
            // `buildStore` drops empty trajectories, so at ingest every row is live.
            cohortSize: store.patientCount,
            distributions: buildDistributions(store),
            selectionDistributions: null,
            states: result.states,
            stateOrder: result.stateOrder,
            visibleStates: result.stateOrder,
            baseStateOrder: result.stateOrder,
            typologies,
            mapping: result.mapping,
            timings: [...result.timings, ...clock.timings],
            reshapeTimings: [],
            selection,
            population,
            selectionVersion: get().selectionVersion + 1,
            // A new file is the global reset signal, as it was in the original.
            filters: emptyFilters,
            selectedTypologies: [],
            pathSteps: [],
            expectations: [],
            activeExpectations: [],
            selectedPatients: [],
            hoveredPatient: null,
            xDomainOverride: null,
            // Undoing into another file's typology keys would select nothing. `view`
            // is deliberately not here: it is how the user looks, not what the file is.
            selectionHistory: emptyHistory,
            focusReturn: null,
            sankeyPin: null,
            sankeyCompare: null,
            hoveredTypology: null,
            clusterRun: null,
            clusterRemovedStates: null,
            clusterPreviews: new Map(),
            hoveredCluster: null,
            clusterProgress: { done: 0, total: 0 },
            clusterError: null,
            selectedClusters: [],
            // The medoid layer has nothing to draw until the new run produces one,
            // and an empty chart reads as a bug rather than as "still working".
            layers: { ...get().layers, lines: true, medoids: true },
        });
        /*
         * Derive the masks rather than assume them.
         *
         * A fresh `Selection` is all ones, which happens to be right at ingest
         * because `buildStore` drops empty trajectories — but it is the only place
         * in the app where the two masks are *asserted* instead of computed, and
         * "happens to be right" is how they drift. One linear pass at load time puts
         * this path on the same footing as every other.
         */
        recompute();
        // Clustering ran once here, over the whole dataset. It is parked behind
        // `CLUSTERING_ENABLED`; `startClustering` is a no-op while that is off, so a
        // load now settles straight into the chart.
        get().startClustering();
    };
    const fail = (error) => {
        set({
            status: "error",
            error: error instanceof Error ? error.message : String(error),
        });
    };
    return {
        ...initial,
        async loadFile(file) {
            set({ status: "loading", error: null, fileName: file.name });
            try {
                receive(file.name, await client.ingest(await file.text(), file.name));
            }
            catch (error) {
                fail(error);
            }
        },
        async loadUrl(url) {
            const fileName = url.split("/").pop() ?? url;
            set({ status: "loading", error: null, fileName });
            try {
                const response = await fetch(url);
                if (!response.ok)
                    throw new Error(`${response.status} ${response.statusText}`);
                receive(fileName, await client.ingest(await response.text(), fileName));
            }
            catch (error) {
                fail(error);
            }
        },
        setFilters(next) {
            set({ filters: { ...get().filters, ...next } });
            recompute();
        },
        /** Drops one range *and* its inversion — a reset is back to "not filtering". */
        resetFilter(key) {
            const filters = get().filters;
            set({
                filters: {
                    ...filters,
                    [key]: null,
                    inverted: { ...filters.inverted, [key]: false },
                },
            });
            recompute();
        },
        toggleInverted(key) {
            const filters = get().filters;
            set({
                filters: {
                    ...filters,
                    inverted: {
                        ...filters.inverted,
                        [key]: filters.inverted[key] !== true,
                    },
                },
            });
            recompute();
        },
        toggleTypology(key) {
            const current = get().selectedTypologies;
            set(withHistory({
                selectedTypologies: current.includes(key)
                    ? current.filter((k) => k !== key)
                    : [...current, key],
                // Picking a card by hand makes the selection something no prefix
                // describes, and a breadcrumb that no longer matches the selection is
                // worse than no breadcrumb.
                pathSteps: [],
                activeExpectations: [],
                // A cluster belongs to one typology's ladder; changing which typology
                // is drawn abandons it rather than plotting it against another.
                selectedClusters: [],
                hoveredCluster: null,
            }));
            recompute();
        },
        /** Replaces the selection outright — what opening one small multiple does. */
        selectTypologies(keys) {
            set(withHistory({
                selectedTypologies: [...keys],
                pathSteps: [],
                activeExpectations: [],
                selectedClusters: [],
                hoveredCluster: null,
            }));
            recompute();
        },
        /*
         * The Sankey's "Open in Trajectories": narrow to the typologies through a
         * flow and show them. One action for the same reason as `focusCluster` —
         * selecting and then switching as two calls would mount the Trajectories
         * view on the old selection first and build its geometry for nothing.
         */
        drillDown(keys) {
            set(withHistory({
                selectedTypologies: [...keys],
                pathSteps: [],
                activeExpectations: [],
                selectedClusters: [],
                hoveredCluster: null,
                view: "trajectories",
            }));
            recompute();
        },
        /*
         * The grid's drill-down: clicking a spine in a small multiple opens that
         * typology and isolates the cluster it represents.
         *
         * One action rather than two calls, because the order is a trap —
         * `selectTypologies` clears the cluster selection, so isolating first and
         * focusing second would silently undo half of it.
         *
         * It also opens the Trajectories view. The sidebar's cluster lines call this
         * too, and they are on screen over the Sankey, which cannot show a cluster:
         * isolating one there would be a change nobody could see.
         */
        focusCluster(typologyKey, cluster) {
            set(withHistory({
                selectedTypologies: [typologyKey],
                pathSteps: [],
                activeExpectations: [],
                selectedClusters: [cluster],
                hoveredCluster: null,
                view: "trajectories",
            }));
            recompute();
        },
        leaveFocus() {
            const { focusReturn } = get();
            if (focusReturn === null) {
                get().clearTypologies();
                return;
            }
            set({
                ...withHistory({
                    ...snapshotOf(focusReturn.snapshot),
                    view: focusReturn.view,
                    hoveredPatient: null,
                    hoveredCluster: null,
                }),
                // Spent. A Sankey returned to with one typology still selected would
                // otherwise record *this* chart as the way back from itself.
                focusReturn: null,
            });
            recompute();
        },
        clearTypologies() {
            // Same rule as `toggleTypology`: a cluster belongs to one typology's
            // ladder, so leaving that ladder abandons it. Without this, going back to
            // the grid left an isolation the grid does not honour and cannot show.
            set(withHistory({
                selectedTypologies: [],
                pathSteps: [],
                activeExpectations: [],
                selectedClusters: [],
                hoveredCluster: null,
            }));
            recompute();
        },
        selectPath(steps) {
            const { typologies, expectations, activeExpectations, filters } = get();
            set(withHistory({
                pathSteps: steps,
                selectedTypologies: pathSelection(typologies, steps, expectations, activeExpectations, filters.removedStates),
            }));
            recompute();
        },
        saveExpectation() {
            const { pathSteps, expectations, activeExpectations } = get();
            if (pathSteps.length === 0)
                return;
            const id = expectations.reduce((max, expectation) => Math.max(max, expectation.id), 0) + 1;
            // Through `withHistory` for the walk and the switch, which do change; the
            // list is not history, so undoing this switches it off and keeps it.
            set({
                ...withHistory({ pathSteps: [], activeExpectations: [...activeExpectations, id] }),
                expectations: [...expectations, { id, name: `Expectation ${id}`, steps: pathSteps }],
            });
        },
        toggleExpectation(id) {
            const { typologies, pathSteps, expectations, activeExpectations, filters } = get();
            const active = activeExpectations.includes(id)
                ? activeExpectations.filter((other) => other !== id)
                : [...activeExpectations, id];
            set(withHistory({
                activeExpectations: active,
                selectedTypologies: pathSelection(typologies, pathSteps, expectations, active, filters.removedStates),
                // As any other selection change: a cluster belongs to a typology
                // that may no longer be drawn.
                selectedClusters: [],
                hoveredCluster: null,
            }));
            recompute();
        },
        renameExpectation(id, name) {
            set({
                expectations: get().expectations.map((expectation) => expectation.id === id ? { ...expectation, name } : expectation),
            });
        },
        removeExpectation(id) {
            const { expectations, activeExpectations } = get();
            // Switched off first, so the selection drops it the same way a toggle does.
            if (activeExpectations.includes(id))
                get().toggleExpectation(id);
            set({ expectations: expectations.filter((expectation) => expectation.id !== id) });
        },
        undoSelection() {
            const step = undo(get().selectionHistory, snapshotOf(get()));
            if (step !== null)
                restore(step.snapshot, step.history);
        },
        redoSelection() {
            const step = redo(get().selectionHistory, snapshotOf(get()));
            if (step !== null)
                restore(step.snapshot, step.history);
        },
        toggleRemovedState(state) {
            const current = get().filters.removedStates;
            syncStates(current.includes(state) ? current.filter((s) => s !== state) : [...current, state]);
        },
        resetStates() {
            syncStates([]);
        },
        setAxis(axis) {
            // An override is in the old axis' units — ages on a calendar scale would
            // put the whole dataset off screen — so switching axes drops it.
            set({ axis, xDomainOverride: null });
        },
        fitXDomain() {
            const { store, selection, axis } = get();
            if (store === null || selection === null)
                return;
            const extent = visibleExtent(store, selection.indices(), axis);
            if (extent !== null)
                set({ xDomainOverride: extent });
        },
        resetXDomain() {
            set({ xDomainOverride: null });
        },
        setRendererKind(rendererKind) {
            set({ rendererKind });
        },
        setOpacity(opacity) {
            set({ opacity });
        },
        setHoveredPatient(hoveredPatient) {
            set({ hoveredPatient });
        },
        setHoveredCluster(hoveredCluster) {
            // Compared before setting: the pointer settles on the same spine many
            // times over, and each redundant set would rebuild the member geometry.
            if (get().hoveredCluster !== hoveredCluster)
                set({ hoveredCluster });
        },
        togglePatient(patient) {
            const current = get().selectedPatients;
            set({
                selectedPatients: current.includes(patient)
                    ? current.filter((p) => p !== patient)
                    : [...current, patient],
            });
        },
        openWorkspace() {
            if (!get().workspaceOpen)
                set({ workspaceOpen: true });
        },
        setView(view) {
            if (get().view === view)
                return;
            // Swapping unmounts the chart under the pointer, and a swap by keyboard
            // does it without the pointerleave that clears its hover — the sidebar
            // would go on highlighting a patient and a cluster nobody is pointing at.
            set({ view, hoveredPatient: null, hoveredCluster: null });
        },
        setSankeyOrder(sankeyOrder) {
            set({ sankeyOrder });
        },
        setSankeyMetric(sankeyMetric) {
            set({ sankeyMetric });
        },
        setSankeyPin(sankeyPin) {
            const { sankeyPin: current, sankeyCompare } = get();
            // Compared by value: every click builds a fresh pin, and a redundant set
            // would re-render the detail for nothing.
            if (samePin(current, sankeyPin))
                return;
            /*
             * Unpinning with a comparison held promotes the comparison. Left as it
             * was, it compared against nothing: the strip showed a lone accent curve
             * under the idle hint, and the next hover drew a second one that could not
             * be told from it.
             */
            if (sankeyPin === null) {
                set({ sankeyPin: sankeyCompare, sankeyCompare: null });
                return;
            }
            set({
                sankeyPin,
                // Pinning the compared item promotes it rather than drawing one curve
                // twice.
                sankeyCompare: samePin(sankeyCompare, sankeyPin) ? null : sankeyCompare,
            });
        },
        setSankeyCompare(sankeyCompare) {
            const { sankeyPin, sankeyCompare: current } = get();
            // The same rule from the other side: comparing the pinned item with
            // itself compares nothing.
            const next = samePin(sankeyCompare, sankeyPin) ? null : sankeyCompare;
            if (!samePin(current, next))
                set({ sankeyCompare: next });
        },
        setHoveredTypology(hoveredTypology) {
            // Compared before setting, as `setHoveredCluster`: the pointer re-enters
            // the same card, and each redundant set would re-trace the Sankey.
            if (get().hoveredTypology !== hoveredTypology)
                set({ hoveredTypology });
        },
        clearHoveredTypology(key) {
            if (get().hoveredTypology === key)
                set({ hoveredTypology: null });
        },
        startClustering(params) {
            if (!CLUSTERING_ENABLED)
                return;
            const { store, typologies, clusterParams } = get();
            if (store === null || typologies.length === 0)
                return;
            const effective = params ?? clusterParams;
            const matrices = buildDurationMatrices(store, typologies);
            if (matrices.length === 0) {
                // Nothing clusterable in the reshaped data. Anything left over describes
                // the old shape, so it goes rather than sitting there looking current.
                set({
                    clusterStatus: "done",
                    clusterProgress: { done: 0, total: 0 },
                    clusterRun: null,
                    clusterRemovedStates: null,
                    clusterPreviews: new Map(),
                    selectedClusters: [],
                });
                return;
            }
            const builder = new ClusterRunBuilder(store.patientCount, effective);
            /**
             * Results stream one typology at a time, and a real dataset has thousands
             * of them. Pushing each one straight into the store would mean thousands
             * of React updates and thousands of re-sorts of the cluster list, which
             * costs far more than the clustering itself. Updates are coalesced instead:
             * the run still streams, the UI just samples it.
             */
            let flushHandle = null;
            let pendingProgress = { done: 0, total: matrices.length };
            const flush = () => {
                if (flushHandle !== null) {
                    clearTimeout(flushHandle);
                    flushHandle = null;
                }
                set({
                    clusterRun: builder.snapshot(),
                    clusterVersion: get().clusterVersion + 1,
                    clusterProgress: pendingProgress,
                });
            };
            const scheduleFlush = () => {
                if (flushHandle !== null)
                    return;
                flushHandle = setTimeout(flush, CLUSTER_FLUSH_MS);
            };
            set({
                clusterParams: effective,
                clusterStatus: "running",
                clusterError: null,
                clusterProgress: { done: 0, total: matrices.length },
                clusterRun: builder.snapshot(),
                // Stamped here, not on completion: the run streams, and every partial
                // snapshot of it is already valid for this shape of the data.
                clusterRemovedStates: get().filters.removedStates,
                clusterPreviews: new Map(),
                selectedClusters: [],
                hoveredCluster: null,
            });
            clusterClient.run(matrices, effective, {
                onPreview(typologyKey, medoidPatients) {
                    const previews = new Map(get().clusterPreviews);
                    previews.set(typologyKey, medoidPatients);
                    set({ clusterPreviews: previews });
                },
                onResult(result, index, total) {
                    builder.add(result);
                    pendingProgress = { done: index + 1, total };
                    const previews = get().clusterPreviews;
                    if (previews.has(result.typologyKey)) {
                        const next = new Map(previews);
                        next.delete(result.typologyKey); // the final result supersedes it
                        set({ clusterPreviews: next });
                    }
                    scheduleFlush();
                },
                onDone() {
                    flush(); // never leave the last typologies sitting in the buffer
                    set({ clusterStatus: "done" });
                },
                onError(message) {
                    flush();
                    set({ clusterStatus: "error", clusterError: message });
                },
            });
        },
        pauseClustering() {
            clusterClient.pause();
            set({
                clusterStatus: get().clusterStatus === "running" ? "paused" : get().clusterStatus,
            });
        },
        resumeClustering() {
            clusterClient.resume();
            set({
                clusterStatus: get().clusterStatus === "paused" ? "running" : get().clusterStatus,
            });
        },
        cancelClustering() {
            clusterClient.cancel();
            set({ clusterStatus: "idle" });
        },
        toggleCluster(globalIndex) {
            const current = get().selectedClusters;
            set({
                selectedClusters: current.includes(globalIndex)
                    ? current.filter((c) => c !== globalIndex)
                    : [...current, globalIndex],
            });
        },
        clearClusters() {
            set({ selectedClusters: [] });
        },
        setColorBy(colorBy) {
            set({ colorBy });
        },
        toggleLayer(layer) {
            const layers = get().layers;
            const next = layers[layer] !== true;
            // Medoids need a run behind them. Nothing else in the app can put the
            // chart into a layer whose data has gone, so the guard lives here rather
            // than as a fallback in the render path.
            if (next && layer === "medoids" && (!CLUSTERING_ENABLED || clusterRunOf(get()) === null))
                return;
            // Turning the last one off leaves a chart with rules and box plots and no
            // data in it, which reads as a failure rather than as a choice.
            if (!next && Object.values({ ...layers, [layer]: false }).every((on) => !on))
                return;
            set({ layers: { ...layers, [layer]: next } });
        },
        setShowMedoids(showMedoids) {
            set({ showMedoids });
        },
        reset() {
            clusterClient.cancel();
            set({ ...initial, rendererKind: get().rendererKind });
        },
    };
});
/**
 * The clusters isolating the chart on screen: only the single-typology
 * Trajectories chart narrows to them. See `isolatedClusters`.
 */
export function isolatedClustersOf(state) {
    const focusedKey = state.view === "trajectories" ? focusedTypologyOf(state.selectedTypologies) : null;
    return isolatedClusters(clusterRunOf(state), state.selectedClusters, focusedKey);
}
useEras.subscribe((state) => {
    const next = reconcileOrder(state.pipelineOrder, activeSteps(state.filters, state.selectedTypologies, isolatedClustersOf(state)));
    // Identity when nothing changed, so this settles after one write.
    if (next !== state.pipelineOrder)
        useEras.setState({ pipelineOrder: next });
});
