import { clusterRunOf, useEras } from "../app/store.ts";
/**
 * The clustering, as anything that draws or joins should see it.
 *
 * `null` while the run is stale — see `clusterRemovedStates`. Reading the store
 * field directly is the mistake this exists to prevent: results filed under
 * typology keys that no longer exist do not error, they match nothing, so every
 * lookup quietly returns empty and the chart looks broken rather than out of
 * date.
 */
export function useClusterRun() {
    return useEras(clusterRunOf);
}
