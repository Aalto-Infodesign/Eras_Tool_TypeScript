import type { ClusterParams, TypologyClusters } from "../core/cluster/types.ts"

/** Matrices cross the boundary as transferred buffers, never as nested arrays. */
export interface SerializedMatrix {
  readonly typologyKey: string
  readonly n: number
  readonly d: number
  readonly rows: Float32Array
  readonly patients: Uint32Array
}

export interface ClusterRunRequest {
  readonly type: "cluster:run"
  readonly runId: number
  readonly matrices: readonly SerializedMatrix[]
  readonly params: ClusterParams
}

export interface ClusterControlRequest {
  readonly type: "cluster:pause" | "cluster:resume" | "cluster:cancel"
}

export type ClusterRequest = ClusterRunRequest | ClusterControlRequest

/** Modes found so far in a typology still converging — the faded preview. */
export interface ClusterPreview {
  readonly type: "cluster:preview"
  readonly runId: number
  readonly typologyKey: string
  readonly medoidPatients: Uint32Array
}

export interface ClusterResult {
  readonly type: "cluster:result"
  readonly runId: number
  readonly index: number
  readonly total: number
  readonly result: TypologyClusters
}

export interface ClusterDone {
  readonly type: "cluster:done"
  readonly runId: number
}

export interface ClusterError {
  readonly type: "cluster:error"
  readonly runId: number
  readonly typologyKey: string | null
  readonly message: string
}

export type ClusterResponse = ClusterPreview | ClusterResult | ClusterDone | ClusterError

export function resultTransferables(result: TypologyClusters): Transferable[] {
  return [
    // `patients` is the buffer the matrix was transferred in on; the worker is
    // finished with that typology by the time this runs, so it moves back out.
    result.patients.buffer,
    result.assignment.buffer,
    result.memberships.buffer,
    result.centers.buffer,
    result.sizes.buffer,
    result.medoidRow.buffer,
    result.medoidPatient.buffer,
  ] as Transferable[]
}
