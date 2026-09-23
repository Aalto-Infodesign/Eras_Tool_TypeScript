/**
 * Uniform grid over the duration space, cell size = bandwidth.
 *
 * Mean-shift asks the same question on every iteration of every seed: *which
 * points lie within `bandwidth` of this centre?* The original answered it with
 * `data.filter(...)` — a full O(n·d) scan, plus a fresh array, per iteration.
 * With cells the size of the search radius, every answer lies in the 3^d cells
 * around the centre's own cell.
 *
 * Dimensionality here is `trajectoryLength - 1`, typically 2–7, so 3^d ranges
 * from 9 to ~2000. The grid is only worth building when that neighbourhood is
 * meaningfully smaller than the point set, hence `shouldUseGrid`.
 *
 * Cell keys are hashed, so two distinct cells can share a bucket. That is
 * harmless: every candidate still has its true distance tested by the caller.
 */
export class NeighborIndex {
  private readonly coords: Int32Array
  /**
   * Per-slot stamp of the last query that visited it.
   *
   * Cell keys are hashed, so two distinct cells can share a slot — and the same
   * slot can then be reached from several of the 3^d offset combinations in one
   * query. Without this guard those points are appended twice, `collect` writes
   * past the end of the caller's buffer (typed arrays drop out-of-range writes
   * silently), and the caller then reads `undefined` back as `NaN`. Stamping
   * makes each slot contribute at most once, which also bounds `count` by the
   * number of points.
   */
  private readonly visitStamp: Int32Array
  private query = 0

  private constructor(
    private readonly d: number,
    private readonly cellSize: number,
    private readonly slotOf: Map<number, number>,
    private readonly starts: Uint32Array,
    private readonly items: Uint32Array,
    private readonly offsets: Int32Array,
  ) {
    this.coords = new Int32Array(d)
    this.visitStamp = new Int32Array(starts.length).fill(-1)
  }

  /** Number of occupied cells — how much the grid can actually discriminate. */
  get cellCount(): number {
    return this.starts.length - 1
  }

  /** Points covered by one 3^d neighbourhood, assuming even occupancy. */
  get estimatedCandidates(): number {
    const neighbourhood = this.offsets.length / this.d
    const occupied = Math.max(1, this.cellCount)
    return (this.items.length * Math.min(neighbourhood, occupied)) / occupied
  }

  /** Grid pays off once its neighbourhood is a small fraction of the point set. */
  static shouldUseGrid(m: number, d: number): boolean {
    if (d < 1 || d > 8) return false
    return 3 ** d * 4 < m
  }

  static build(points: Float32Array, m: number, d: number, cellSize: number): NeighborIndex {
    const keys = new Float64Array(m)
    const slotOf = new Map<number, number>()
    const counts: number[] = []

    for (let i = 0; i < m; i++) {
      const key = cellKey(points, i * d, d, cellSize)
      keys[i] = key

      const existing = slotOf.get(key)
      if (existing === undefined) {
        slotOf.set(key, counts.length)
        counts.push(1)
      } else {
        counts[existing] = (counts[existing] as number) + 1
      }
    }

    // CSR over cells, same shape as the store itself.
    const starts = new Uint32Array(counts.length + 1)
    for (let c = 0; c < counts.length; c++) {
      starts[c + 1] = (starts[c] as number) + (counts[c] as number)
    }

    const cursor = starts.slice(0, counts.length)
    const items = new Uint32Array(m)
    for (let i = 0; i < m; i++) {
      const slot = slotOf.get(keys[i] as number) as number
      items[cursor[slot] as number] = i
      cursor[slot] = (cursor[slot] as number) + 1
    }

    // Precomputed base-3 offset table: every combination of -1/0/+1 per axis.
    const combinations = 3 ** d
    const offsets = new Int32Array(combinations * d)
    for (let t = 0; t < combinations; t++) {
      let rest = t
      for (let k = 0; k < d; k++) {
        offsets[t * d + k] = (rest % 3) - 1
        rest = (rest / 3) | 0
      }
    }

    return new NeighborIndex(d, cellSize, slotOf, starts, items, offsets)
  }

  /**
   * Writes every point that *may* lie within one cell of `centre` into `out`,
   * returning how many. Candidates are a superset; the caller applies the exact
   * distance test.
   *
   * It fills a caller-owned scratch buffer rather than taking a callback: the
   * inner loop runs tens of millions of times per run, and a megamorphic call
   * per candidate costs more than the distance test it guards.
   */
  collect(centre: Float64Array, out: Uint32Array): number {
    const { d, cellSize, offsets, coords, visitStamp } = this
    const combinations = offsets.length / d
    const query = this.query++

    for (let k = 0; k < d; k++) {
      coords[k] = Math.floor((centre[k] as number) / cellSize)
    }

    let count = 0
    for (let t = 0; t < combinations; t++) {
      let hash = 0x811c9dc5
      for (let k = 0; k < d; k++) {
        hash ^= (coords[k] as number) + (offsets[t * d + k] as number)
        hash = Math.imul(hash, 0x01000193)
      }
      hash >>>= 0

      const slot = this.slotOf.get(hash)
      if (slot === undefined) continue
      if (visitStamp[slot] === query) continue // already contributed to this query
      visitStamp[slot] = query

      const start = this.starts[slot] as number
      const end = this.starts[slot + 1] as number
      for (let i = start; i < end; i++) out[count++] = this.items[i] as number
    }
    return count
  }
}

function cellKey(points: Float32Array, base: number, d: number, cellSize: number): number {
  let hash = 0x811c9dc5
  for (let k = 0; k < d; k++) {
    hash ^= Math.floor((points[base + k] as number) / cellSize)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}
