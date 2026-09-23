import type { TrajectoryStore, Typology } from "../types.ts"

/**
 * Duration matrix for one typology: rows = patients, columns = the duration of
 * each transition.
 *
 * Every patient in a typology shares the same state sequence, so every row has
 * the same width and the matrix is rectangular by construction. Because the
 * store is CSR, a patient's durations are already contiguous — building the
 * matrix is a straight copy loop into one `Float32Array`, not the
 * `trajectories.map(t => t.map(tt => tt.speed))` nested-array construction the
 * original fed the worker (which allocated one array per patient, per run).
 */
export interface DurationMatrix {
  readonly typologyKey: string
  readonly n: number
  readonly d: number
  readonly rows: Float32Array
  readonly patients: Uint32Array
}

export function buildDurationMatrix(
  store: TrajectoryStore,
  typology: Typology,
): DurationMatrix | null {
  const n = typology.patients.length
  if (n === 0) return null

  // The last event of a trajectory has no transition after it, so a sequence of
  // `length` states yields `length - 1` durations.
  const d = typology.states.length - 1
  if (d <= 0) return null

  const rows = new Float32Array(n * d)
  const patients = typology.patients

  for (let i = 0; i < n; i++) {
    const p = patients[i] as number
    const start = store.offsets[p] as number
    const base = i * d
    for (let k = 0; k < d; k++) {
      rows[base + k] = store.durations[start + k] as number
    }
  }

  return { typologyKey: typology.key, n, d, rows, patients }
}

/** Matrices for every typology, largest first — the order results stream in. */
export function buildDurationMatrices(
  store: TrajectoryStore,
  typologies: readonly Typology[],
): DurationMatrix[] {
  const matrices: DurationMatrix[] = []
  for (const typology of typologies) {
    const matrix = buildDurationMatrix(store, typology)
    if (matrix !== null) matrices.push(matrix)
  }
  return matrices.sort((a, b) => b.n - a.n)
}

export function matrixTransferables(matrix: DurationMatrix): Transferable[] {
  return [matrix.rows.buffer, matrix.patients.buffer] as Transferable[]
}
