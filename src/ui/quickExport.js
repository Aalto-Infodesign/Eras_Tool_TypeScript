import { clusterRunOf, focusedTypologyOf, useEras } from "../app/store.ts";
import { membershipsTsv } from "../core/cluster/export.ts";
import { clusterMembers } from "../core/cluster/medoids.ts";
import { isolatedClusters, patientIdsCsv, pipelineFailures, STEP_BITS, survivors, } from "../core/query/pipeline.ts";
import { safeFilename } from "../core/util/download.ts";
import { download } from "./download.ts";
/** The id column's name when the file did not say: the original's hardcoded one. */
const DEFAULT_ID_HEADER = "FINNGENID";
/**
 * One-click exports from the charts themselves, without opening a side panel.
 *
 * Read from the store at click time rather than subscribed to: the scan behind
 * the selection is exhaustive, and paying for it on every drag to keep a button
 * up to date would be paying for a file nobody asked for yet.
 */
/**
 * The patients on screen as an id list: the last link of "Build & export",
 * from the same scan, so the two files list the same patients.
 */
export function exportSelection() {
    const state = useEras.getState();
    const { store, filters, typologies, selectedTypologies, selectedClusters, view } = state;
    if (store === null)
        return;
    const clusterRun = clusterRunOf(state);
    const keys = new Set(selectedTypologies);
    const chosen = selectedTypologies.length > 0
        ? typologies.filter((typology) => keys.has(typology.key)).map((t) => t.patients)
        : null;
    const isolated = isolatedClusters(clusterRun, selectedClusters, view === "trajectories" ? focusedTypologyOf(selectedTypologies) : null);
    const members = isolated.length > 0 && clusterRun !== null ? clusterMembers(clusterRun, isolated, null) : null;
    const failures = pipelineFailures(store, filters, chosen, members);
    const rows = [
        ...(filters.removedStates.length > 0 ? ["removedStates"] : []),
        ...state.pipelineOrder,
    ];
    const bits = rows.reduce((acc, row) => acc | STEP_BITS[row], 0);
    const patients = survivors(failures, bits);
    const idHeader = state.mapping?.mapping.patientId ?? DEFAULT_ID_HEADER;
    const base = (state.fileName ?? "eras").replace(/\.[^.]+$/, "");
    download(`${base}-selection-${patients.length}.csv`, patientIdsCsv(store, patients, idHeader), "text/csv");
}
/**
 * One typology's cluster memberships, the cluster table's "Memberships TSV".
 * False when that typology has no clustering to export.
 */
export function exportMemberships(typologyKey) {
    const state = useEras.getState();
    const result = clusterRunOf(state)?.byTypology.get(typologyKey);
    if (state.store === null || result === undefined)
        return false;
    download(`memberships_${safeFilename(typologyKey)}.tsv`, [membershipsTsv(result, state.store.ids)], "text/tab-separated-values");
    return true;
}
