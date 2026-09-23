import {
  buildRibbon as buildGroupRibbon,
  buildRibbons as buildGroupRibbons,
  type Ribbon as GroupRibbon,
  type RibbonGroup,
  type RibbonOptions,
} from "../render/ribbons.ts"
import type { TrajectoryStore } from "../types.ts"
import type { ClusterRef, TypologyClusters } from "./types.ts"

/**
 * Cluster ribbons — the clustered grouping of the generic ribbon layer.
 *
 * All the geometry lives in `render/ribbons.ts`, which knows only "a set of
 * patients walking the same states". This file is the adapter that turns a
 * cluster into such a set, and is parked along with the rest of the clustering
 * path (see `app/features.ts`). It stays because the reading it produces is
 * worth having back once the run itself is trustworthy.
 */
export type { RibbonOptions } from "../render/ribbons.ts"

export interface Ribbon extends GroupRibbon {
  readonly globalIndex: number
  readonly typologyKey: string
  readonly localCluster: number
}

/** Rows of `result` assigned to `ref`'s cluster, as global patient indices. */
function clusterGroup(result: TypologyClusters, ref: ClusterRef): RibbonGroup {
  const members: number[] = []
  for (let row = 0; row < result.n; row++) {
    if (result.assignment[row] !== ref.localCluster) continue
    members.push(result.patients[row] as number)
  }

  return {
    index: ref.globalIndex,
    label: `${ref.typologyKey} · cluster ${ref.localCluster}`,
    patients: Uint32Array.from(members),
  }
}

const withClusterIdentity = (ribbon: GroupRibbon, ref: ClusterRef): Ribbon => ({
  ...ribbon,
  globalIndex: ref.globalIndex,
  typologyKey: ref.typologyKey,
  localCluster: ref.localCluster,
})

export function buildRibbon(
  store: TrajectoryStore,
  result: TypologyClusters,
  ref: ClusterRef,
  options: RibbonOptions,
): Ribbon | null {
  const ribbon = buildGroupRibbon(store, clusterGroup(result, ref), options)
  return ribbon === null ? null : withClusterIdentity(ribbon, ref)
}

/** Ribbons for the largest clusters currently in view, biggest first. */
export function buildRibbons(
  store: TrajectoryStore,
  byTypology: ReadonlyMap<string, TypologyClusters>,
  clusters: readonly ClusterRef[],
  limit: number,
  options: Omit<RibbonOptions, "maxSize">,
): Ribbon[] {
  const refs = clusters.filter((ref) => byTypology.has(ref.typologyKey))
  const byIndex = new Map(refs.map((ref) => [ref.globalIndex, ref]))

  const groups = refs.map((ref) =>
    clusterGroup(byTypology.get(ref.typologyKey) as TypologyClusters, ref),
  )

  return buildGroupRibbons(store, groups, limit, options).map((ribbon) =>
    withClusterIdentity(ribbon, byIndex.get(ribbon.index) as ClusterRef),
  )
}
