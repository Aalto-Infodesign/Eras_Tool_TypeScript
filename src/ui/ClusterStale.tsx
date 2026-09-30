import { clusterStale, useEras } from "../app/store.ts"

/**
 * The prompt to redo a clustering that no longer describes the data.
 *
 * Removing a state re-derives the whole dataset — typologies regroup under new
 * keys — so the results on hand stop matching anything. Recomputing them there
 * and then would be both expensive and, usually, wasted: taking states out is an
 * exploratory move made several at a time, and re-clustering after each click
 * would spend a run apiece producing answers to questions nobody asked. So the
 * run is marked rather than thrown away, and redoing it is a decision — make the
 * removals you mean to make, then cluster once against what is left.
 *
 * It says what is out of date and what that costs on screen, because the failure
 * it replaces was silent: the medoid layer stayed lit and drew nothing.
 */
export function ClusterStaleNotice(): React.JSX.Element | null {
  const stale = useEras(clusterStale)
  const status = useEras((s) => s.clusterStatus)
  const typologies = useEras((s) => s.typologies)
  const removedStates = useEras((s) => s.filters.removedStates)
  const clusteredStates = useEras((s) => s.clusterRemovedStates)
  const startClustering = useEras((s) => s.startClustering)

  if (!stale) return null

  const then = new Set(clusteredStates ?? [])
  const now = new Set(removedStates)
  const removed = removedStates.filter((state) => !then.has(state)).length
  const restored = (clusteredStates ?? []).filter((state) => !now.has(state)).length
  const streaming = status === "running" || status === "paused"

  return (
    <div className="stale" role="status">
      <p className="stale__text">
        <b>Clusters are out of date.</b> {describe(removed, restored)} Medoids stay hidden until
        they are recomputed against what is left.
        {/* The old run is not cancelled — it finishes into results this refuses
            to draw, and re-clustering replaces it mid-flight. Saying so beats
            leaving a progress bar advancing under a notice like this one. */}
        {streaming && " The previous run is still finishing; re-clustering replaces it."}
      </p>
      <button
        type="button"
        className="button stale__action"
        disabled={typologies.length === 0}
        title="Cluster the typologies as they stand now"
        onClick={() => startClustering()}
      >
        Re-cluster {typologies.length.toLocaleString()} typologies
      </button>
    </div>
  )
}

/**
 * The same prompt, plus a way back when there is no clustering at all.
 *
 * Clustering only ever started by itself, at load, so every path that ends
 * without a run — nothing large enough to cluster after a splice, an error — was
 * a dead end with no control anywhere to leave it. This is that control, and it
 * lives beside the results rather than in the States panel, which has no
 * business offering to start a run.
 */
export function ClusterRunControl(): React.JSX.Element | null {
  const stale = useEras(clusterStale)
  const run = useEras((s) => s.clusterRun)
  const status = useEras((s) => s.clusterStatus)
  const typologies = useEras((s) => s.typologies)
  const startClustering = useEras((s) => s.startClustering)

  if (stale) return <ClusterStaleNotice />

  const idle = run === null && status !== "running" && status !== "paused"
  if (!idle || typologies.length === 0) return null

  return (
    <button
      type="button"
      className="button stale__action"
      title="Cluster the typologies as they stand now"
      onClick={() => startClustering()}
    >
      Cluster {typologies.length.toLocaleString()} typologies
    </button>
  )
}

function describe(removed: number, restored: number): string {
  if (removed > 0 && restored > 0) return `${removed + restored} states changed since the run.`
  if (restored > 0) return `${plural(restored)} restored since the run.`
  return `${plural(removed)} removed since the run.`
}

const plural = (n: number): string => `${n} state${n === 1 ? "" : "s"}`
