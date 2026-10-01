import { buildRibbon as buildGroupRibbon, buildRibbons as buildGroupRibbons, } from "../render/ribbons.ts";
/** Rows of `result` assigned to `ref`'s cluster, as global patient indices. */
function clusterGroup(result, ref) {
    const members = [];
    for (let row = 0; row < result.n; row++) {
        if (result.assignment[row] !== ref.localCluster)
            continue;
        members.push(result.patients[row]);
    }
    return {
        index: ref.globalIndex,
        label: `${ref.typologyKey} · cluster ${ref.localCluster}`,
        patients: Uint32Array.from(members),
    };
}
const withClusterIdentity = (ribbon, ref) => ({
    ...ribbon,
    globalIndex: ref.globalIndex,
    typologyKey: ref.typologyKey,
    localCluster: ref.localCluster,
});
export function buildRibbon(store, result, ref, options) {
    const ribbon = buildGroupRibbon(store, clusterGroup(result, ref), options);
    return ribbon === null ? null : withClusterIdentity(ribbon, ref);
}
/** Ribbons for the largest clusters currently in view, biggest first. */
export function buildRibbons(store, byTypology, clusters, limit, options) {
    const refs = clusters.filter((ref) => byTypology.has(ref.typologyKey));
    const byIndex = new Map(refs.map((ref) => [ref.globalIndex, ref]));
    const groups = refs.map((ref) => clusterGroup(byTypology.get(ref.typologyKey), ref));
    return buildGroupRibbons(store, groups, limit, options).map((ribbon) => withClusterIdentity(ribbon, byIndex.get(ribbon.index)));
}
