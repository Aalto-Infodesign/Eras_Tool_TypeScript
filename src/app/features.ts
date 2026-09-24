/**
 * Build-time switches for work that is parked rather than removed.
 */

/**
 * Mean-shift clustering — the engine, the worker, the streaming run and the
 * cluster table.
 *
 * Parked, not deleted. The implementation under `core/cluster` and
 * `workers/cluster*` is intact and still covered by its tests; what is off is
 * the *product*: no run starts on load, the cluster panel is not mounted and the
 * chart offers no cluster-derived layers. The reading it produced (a ribbon per
 * cluster, a spine per medoid) was not worth the jank it cost — a run over
 * thousands of typologies streamed thousands of updates into a side panel that
 * could not hold them.
 *
 * Flip this back on to remount the whole path: a run starts on load, the cluster
 * table returns to the side panel, and the chart offers **Medoids** as a third
 * layer beside Lines and Lumps — one spine per cluster, wired through
 * `useChartLayers` like the other two and scoped by the cluster selection.
 *
 * Still unwired, and still intact: colouring the bulk layer by cluster
 * (`ColorSource` already has the case) and the median-path ribbons in
 * `ui/RibbonLayer.tsx`.
 */
export const CLUSTERING_ENABLED: boolean = false
