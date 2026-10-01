import { useMemo } from "react";
import { useEras } from "../app/store.ts";
import { rowLookup } from "../core/render/geometry.ts";
import { buildPalette } from "../core/render/palette.ts";
import { buildSankey } from "../core/stats/sankey.ts";
import { filteredSizes } from "../core/stats/silhouettes.ts";
/**
 * The Sankey's graph, shared by the main view and the View panel's mini of it.
 *
 * Built over typologies rather than patients (see `buildSankey`): the live
 * members of each typology under the selection, then one pass over the live
 * sequences. The selection is already narrowed to the selected typologies by
 * `recompute`, so "the shape of the selected silhouettes, else all of them" —
 * which the original's `PartialOrderChart` wrote out as a branch — falls out of
 * the mask with no branch here.
 *
 * Each memo lists everything it reads. `typologies` and `store` arrive in one
 * `set` and `selectionVersion` in the next (`syncStates` then `recompute`), so a
 * graph keyed on the version alone could pair new typologies with sizes counted
 * for the old ones — `(sizes[t] as number)` reading past the end, and every
 * node's size NaN.
 */
export function useSankey() {
    const store = useEras((s) => s.store);
    const typologies = useEras((s) => s.typologies);
    const selection = useEras((s) => s.selection);
    const selectionVersion = useEras((s) => s.selectionVersion);
    const visibleStates = useEras((s) => s.visibleStates);
    const stateCount = store?.stateNames.length ?? 0;
    const counted = useMemo(() => {
        const t0 = performance.now();
        let sizes;
        if (selection === null) {
            sizes = new Uint32Array(typologies.length);
        }
        else if (selection.isEverything) {
            // Nothing filtered: every member is live, and a 250k-read pass says so.
            sizes = Uint32Array.from(typologies, (typology) => typology.size);
        }
        else {
            sizes = filteredSizes(typologies, selection.mask);
        }
        return { sizes, ms: performance.now() - t0 };
    }, 
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [typologies, selection, selectionVersion]);
    const sizes = counted.sizes;
    const built = useMemo(() => {
        const t0 = performance.now();
        const graph = buildSankey(typologies, sizes, stateCount);
        return { graph, ms: performance.now() - t0 };
    }, [typologies, sizes, stateCount]);
    const stateRank = useMemo(() => rowLookup(stateCount, visibleStates), [visibleStates, stateCount]);
    const palette = useMemo(() => buildPalette(stateCount), [stateCount]);
    return {
        graph: built.graph,
        sizes,
        palette,
        stateRank,
        buildMs: counted.ms + built.ms,
    };
}
