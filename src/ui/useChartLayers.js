import { useMemo } from "react";
import { chartModeOf, focusedTypologyOf, useEras } from "../app/store.ts";
import { clusterMembers, medoidPatients } from "../core/cluster/medoids.ts";
import { TOP_CLUSTER_LIMIT } from "../core/cluster/types.ts";
import { xDomainOf } from "../core/query/extent.ts";
import { sequenceLabels } from "../core/stats/silhouettes.ts";
import { buildStateStats, buildStepStats } from "../core/render/boxplots.ts";
import { buildGeometry, rowLookup, } from "../core/render/geometry.ts";
import { buildPalette } from "../core/render/palette.ts";
import { buildLumps } from "../core/render/lumps.ts";
import { useClusterRun } from "./useClusterRun.ts";
/** Shared empty list, so the layers below a disabled mode keep their identity. */
const NO_PATIENTS = new Uint32Array();
/**
 * Derives every drawable layer from the store.
 *
 * Both layers are rebuilt only when *what is shown* changes — never on a resize,
 * a pan or a hover, which the shader and the overlay handle on their own.
 *
 * The three layers stack, and each is built only when it is on — switching one
 * off stops paying for it immediately.
 *
 * The hairlines and the medoid spines are the same buffers from the same
 * builder handed different patient lists, so the renderer, the picking and the
 * animation need no branch between them. What differs is only *which slot* they
 * land in: the renderer keeps a separate overlay buffer so the spines can be
 * toggled without touching the megabytes underneath them.
 *
 * Only the medoid layer needs a run behind it, and it is unreachable without one
 * (`toggleLayer` refuses); the other two never wait on clustering.
 */
export function useChartLayers() {
    const store = useEras((s) => s.store);
    const selection = useEras((s) => s.selection);
    const population = useEras((s) => s.population);
    const selectionVersion = useEras((s) => s.selectionVersion);
    const stateOrder = useEras((s) => s.visibleStates);
    const axis = useEras((s) => s.axis);
    const xDomainOverride = useEras((s) => s.xDomainOverride);
    const filters = useEras((s) => s.filters);
    const layers = useEras((s) => s.layers);
    const typologies = useEras((s) => s.typologies);
    const clusterRun = useClusterRun();
    const clusterVersion = useEras((s) => s.clusterVersion);
    const selectedClusters = useEras((s) => s.selectedClusters);
    const hoveredCluster = useEras((s) => s.hoveredCluster);
    const selectedTypologies = useEras((s) => s.selectedTypologies);
    /*
     * Both derived from the selection. One typology means "draw it along its own
     * steps"; two or more means the grid, where that projection is per panel. See
     * `chartModeOf`.
     */
    const focusedKey = focusedTypologyOf(selectedTypologies);
    const mode = chartModeOf(selectedTypologies);
    const stateCount = store?.stateNames.length ?? 0;
    const statePalette = useMemo(() => buildPalette(stateCount), [stateCount]);
    const focused = useMemo(() => (focusedKey === null ? null : (typologies.find((t) => t.key === focusedKey) ?? null)), [typologies, focusedKey]);
    const byPosition = focused !== null;
    /**
     * The rows, and the lookup that puts geometry on them.
     *
     * Focused, both come from the typology's own sequence: row `i` *is* step `i`,
     * so the lookup is the identity and `positions.y` carries the step. That is
     * the whole trick — nothing else in the pipeline has to know, because every
     * layer already resolves a row through this one array.
     */
    const rowStates = useMemo(() => (focused === null ? stateOrder : Array.from(focused.states)), [focused, stateOrder]);
    const rowLabels = useMemo(() => {
        if (store === null)
            return [];
        if (focused === null)
            return stateOrder.map((state) => store.stateNames[state] ?? String(state));
        return sequenceLabels(focused.states, store.stateNames);
    }, [store, focused, stateOrder]);
    const rowOf = useMemo(() => {
        if (focused === null)
            return rowLookup(stateCount, stateOrder);
        const identity = new Float32Array(focused.states.length);
        for (let i = 0; i < identity.length; i++)
            identity[i] = i;
        return identity;
    }, [focused, stateCount, stateOrder]);
    // One rule with the View panel's mini, which has to scale itself the same way
    // while this chart is not mounted to ask.
    const xDomain = useMemo(() => xDomainOf(store, axis, xDomainOverride), [store, axis, xDomainOverride]);
    const color = useMemo(() => ({ kind: "state", palette: statePalette }), [statePalette]);
    const geometryOptions = useMemo(
    // Rows are resolved at draw time now, so reordering never rebuilds this.
    () => ({
        axis,
        color,
        durationRange: filters.duration,
        ...(byPosition ? { rowsFrom: "position" } : {}),
    }), [axis, color, filters.duration, byPosition]);
    const visiblePatients = useMemo(() => selection?.indices() ?? new Uint32Array(), 
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selection, selectionVersion]);
    /*
     * Only clusters of the typology on screen.
     *
     * A cluster is a group *within* one typology, so one from anywhere else has
     * no place on this ladder — its members walk a different sequence, and step 3
     * of theirs is a different state from step 3 of this one. The store clears the
     * selection when the typology changes; this makes the render path independent
     * of whether it did, because the failure is silent: `medoidPatients` filters
     * to the focused typology and to the chosen clusters, and when those two
     * disagree it returns nothing and the spines simply never appear.
     */
    const scopedClusters = useMemo(() => {
        if (focusedKey === null || clusterRun === null)
            return selectedClusters;
        return selectedClusters.filter((index) => clusterRun.clusters[index]?.typologyKey === focusedKey);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [focusedKey, clusterRun, clusterVersion, selectedClusters]);
    /**
     * The cluster representatives, in medoid mode.
     *
     * Keyed on `clusterVersion` as well as the run, because results stream in and
     * mutate the run in place — the object identity does not change when the
     * hundredth typology lands, but the ranked top list does.
     */
    const medoids = useMemo(() => {
        if (!layers.medoids || clusterRun === null)
            return NO_PATIENTS;
        /*
         * Focused, the spines are that typology's own clusters — which is the
         * natural pairing, since a typology is exactly the unit the clusterer works
         * on. They land on the same per-step ladder as the hairlines, so a spine is
         * a cluster's path through this sequence rather than through the global rows.
         */
        return medoidPatients(clusterRun, scopedClusters, selection?.mask ?? null, TOP_CLUSTER_LIMIT, focusedKey);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [
        layers.medoids,
        clusterRun,
        clusterVersion,
        scopedClusters,
        selection,
        selectionVersion,
        focusedKey,
    ]);
    /*
     * Isolating a cluster narrows the hairlines to its members.
     *
     * This is what makes a medoid readable as a representative rather than as one
     * more line drawn thicker: the spine and the people it stands for are on
     * screen together, and the density under it is that cluster's own. Selecting
     * clusters already scoped the spines; it now scopes what is underneath them
     * too, so the cluster table's selection finally means something in the chart.
     */
    const isIsolated = clusterRun !== null && scopedClusters.length > 0;
    const linePatients = useMemo(() => {
        if (focused !== null && !isIsolated) {
            // The projection is only meaningful over the sequence it came from.
            const mask = selection?.mask ?? null;
            const members = [];
            for (let i = 0; i < focused.patients.length; i++) {
                const patient = focused.patients[i];
                if (mask === null || mask[patient] === 1)
                    members.push(patient);
            }
            return Uint32Array.from(members);
        }
        if (!isIsolated || clusterRun === null)
            return visiblePatients;
        return clusterMembers(clusterRun, scopedClusters, selection?.mask ?? null);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [
        focused,
        isIsolated,
        clusterRun,
        clusterVersion,
        scopedClusters,
        visiblePatients,
        selection,
        selectionVersion,
    ]);
    /**
     * The people the spine under the cursor stands for.
     *
     * The same `clusterMembers` an isolating click uses, drawn as its own layer
     * instead of replacing the bulk — hovering should *answer* a question about
     * what is on screen, not change what is on screen. Scoped to the ladder being
     * drawn for the reason `scopedClusters` exists: a cluster from another
     * typology walks a different sequence, so its step 3 is not this one's.
     */
    const highlightPatients = useMemo(() => {
        if (hoveredCluster === null || clusterRun === null || !layers.medoids)
            return NO_PATIENTS;
        const ref = clusterRun.clusters[hoveredCluster];
        if (ref === undefined)
            return NO_PATIENTS;
        if (focusedKey !== null && ref.typologyKey !== focusedKey)
            return NO_PATIENTS;
        return clusterMembers(clusterRun, [hoveredCluster], selection?.mask ?? null);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [
        hoveredCluster,
        clusterRun,
        clusterVersion,
        layers.medoids,
        focusedKey,
        selection,
        selectionVersion,
    ]);
    // One builder, two readings: the difference between the density field and the
    // summary is only *which patients* are handed to it.
    const lineGeometry = useMemo(() => {
        // Focused, the hairlines are the whole reading — the spines and the lumps
        // are grouped by state, which is not what the rows mean here.
        if (store === null || mode === "multiples" || rowStates.length === 0)
            return null;
        /*
         * The toggle means the same thing here as anywhere else. The floor is only
         * for the case where it would otherwise leave nothing: lumps are grouped by
         * state pair and have no reading on a ladder of steps, so with lumps as the
         * only layer a focused chart would be empty.
         */
        if (!(layers.lines || (byPosition && !layers.medoids)))
            return null;
        const t0 = performance.now();
        return {
            geometry: buildGeometry(store, linePatients, geometryOptions),
            ms: performance.now() - t0,
        };
    }, [store, mode, rowStates.length, layers.lines, byPosition, linePatients, geometryOptions]);
    const medoidGeometry = useMemo(() => {
        if (store === null || mode === "multiples" || rowStates.length === 0 || medoids.length === 0) {
            return null;
        }
        const t0 = performance.now();
        return {
            geometry: buildGeometry(store, medoids, geometryOptions),
            ms: performance.now() - t0,
        };
    }, [store, mode, rowStates.length, medoids, geometryOptions]);
    const highlightGeometry = useMemo(() => {
        if (store === null || mode === "multiples" || rowStates.length === 0)
            return null;
        if (highlightPatients.length === 0 || hoveredCluster === null || clusterRun === null)
            return null;
        const ref = clusterRun.clusters[hoveredCluster];
        if (ref === undefined)
            return null;
        return {
            members: buildGeometry(store, highlightPatients, geometryOptions),
            // One trajectory. Cheap enough to rebuild on every settled hover, which is
            // what lets the spine layer behind it fade as a whole.
            spine: buildGeometry(store, Uint32Array.of(ref.medoidPatient), geometryOptions),
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [
        store,
        mode,
        rowStates.length,
        highlightPatients,
        geometryOptions,
        hoveredCluster,
        clusterRun,
        clusterVersion,
    ]);
    /*
     * Which slot each one lands in. The spines go on top when the hairlines are
     * there to go on top *of*; alone, they are the bulk — which also makes them
     * the layer hover picks from, since picking reads the bulk buffer.
     */
    const bulk = (lineGeometry ?? medoidGeometry)?.geometry ?? null;
    const overlay = lineGeometry === null ? null : (medoidGeometry?.geometry ?? null);
    const buildMs = (lineGeometry?.ms ?? 0) + (medoidGeometry?.ms ?? 0);
    /**
     * One quad per ordered state pair, over the visible links.
     *
     * Built only in lump mode — it is the alternative to the hairlines, so the two
     * are never derived at the same time.
     */
    const lumps = useMemo(() => {
        if (store === null || byPosition || !layers.lumps)
            return [];
        return buildLumps(store, visiblePatients, {
            axis,
            durationRange: filters.duration,
        });
    }, [store, byPosition, layers.lumps, visiblePatients, axis, filters.duration]);
    /**
     * Box plot stats. Both sides are one counting pass over the events, and they
     * are keyed on the selection version rather than on the compacted index list,
     * so a filter drag recomputes them once per change and not once per frame.
     *
     * The bars are built from the patients the chart is actually drawing — so
     * isolating a cluster narrows them with everything else — while the reference
     * behind them is the *whole cohort*, which is what makes a typology's timing
     * legible as early or late rather than merely as itself.
     */
    const rowStats = useMemo(() => {
        if (store === null || mode === "multiples" || rowStates.length === 0)
            return [];
        return buildStepStats(store, linePatients, rowStates.length, axis);
    }, [store, mode, linePatients, rowStates.length, axis]);
    const populationStats = useMemo(() => {
        if (store === null)
            return [];
        return buildStateStats(store, population?.mask ?? null, axis);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [store, population, selectionVersion, axis]);
    const rowReference = useMemo(() => {
        if (rowStats.length === 0)
            return [];
        const byState = new Map(populationStats.map((entry) => [entry.state, entry]));
        return rowStates.map((state) => byState.get(state) ?? null);
    }, [rowStats.length, populationStats, rowStates]);
    return {
        bulk,
        overlay,
        highlight: highlightGeometry,
        highlightCount: highlightPatients.length,
        linePatients,
        isIsolated,
        lumps,
        medoidCount: medoids.length,
        rowStats,
        rowReference,
        rowOf,
        rowStates,
        rowLabels,
        byPosition,
        mode,
        linesDrawn: lineGeometry !== null,
        geometryOptions,
        statePalette,
        buildMs,
        xDomain,
    };
}
