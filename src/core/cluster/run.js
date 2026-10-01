import { TOP_CLUSTER_LIMIT, } from "./types.ts";
/**
 * Accumulates streamed per-typology results into a run.
 *
 * Results arrive largest typology first, so the chart is useful long before the
 * run finishes. The builder keeps the two lookups the UI needs — patient →
 * cluster, and a flat cluster list — updated incrementally rather than rederived
 * from the whole map on every message.
 */
export class ClusterRunBuilder {
    params;
    byTypology = new Map();
    refs = [];
    /** Kept sorted by size, capped — see `ClusterRun.topBySize`. */
    top = [];
    clusterOfPatient;
    constructor(patientCount, params) {
        this.params = params;
        this.clusterOfPatient = new Int32Array(patientCount).fill(-1);
    }
    add(result) {
        // A re-delivered typology (a resumed run replaying a message) must not
        // duplicate its clusters in the flat list.
        if (this.byTypology.has(result.typologyKey))
            return;
        this.byTypology.set(result.typologyKey, result);
        const base = this.refs.length;
        for (let c = 0; c < result.k; c++) {
            const ref = {
                globalIndex: base + c,
                typologyKey: result.typologyKey,
                localCluster: c,
                size: result.sizes[c],
                medoidPatient: result.medoidPatient[c],
            };
            this.refs.push(ref);
            this.offerToTop(ref);
        }
        for (let row = 0; row < result.n; row++) {
            const patient = result.patients[row];
            this.clusterOfPatient[patient] = base + result.assignment[row];
        }
    }
    /**
     * Inserts `ref` into the ranked top list if it earns a place.
     *
     * Results arrive largest typology first, so the list fills early and later
     * candidates are usually rejected by the single size comparison below — which
     * is why this stays cheap across thousands of streamed typologies.
     */
    offerToTop(ref) {
        const { top } = this;
        const smallest = top[top.length - 1];
        if (top.length >= TOP_CLUSTER_LIMIT && smallest !== undefined && ref.size <= smallest.size) {
            return;
        }
        let low = 0;
        let high = top.length;
        while (low < high) {
            const mid = (low + high) >>> 1;
            if (top[mid].size > ref.size)
                low = mid + 1;
            else
                high = mid;
        }
        top.splice(low, 0, ref);
        if (top.length > TOP_CLUSTER_LIMIT)
            top.length = TOP_CLUSTER_LIMIT;
    }
    snapshot() {
        return {
            byTypology: this.byTypology,
            // Shared, not copied: the chart reads it every time it rebuilds colours,
            // and copying 250k entries per streamed typology would undo the point.
            clusterOfPatient: this.clusterOfPatient,
            clusters: this.refs.slice(),
            topBySize: this.top.slice(),
            params: this.params,
        };
    }
    get size() {
        return this.byTypology.size;
    }
}
/** Membership weight of a patient in one of its typology's clusters. */
export function membershipOf(result, row, cluster) {
    return result.memberships[row * result.k + cluster] ?? 0;
}
/** Row index of a patient inside its typology result, or -1. */
export function rowOfPatient(result, patient) {
    for (let row = 0; row < result.n; row++) {
        if (result.patients[row] === patient)
            return row;
    }
    return -1;
}
