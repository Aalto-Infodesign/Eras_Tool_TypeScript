import { strideIndices } from "../util/sample.ts"
import type { DurationMatrix } from "./matrices.ts"
import { NeighborIndex } from "./NeighborIndex.ts"
import type { ClusterParams, TypologyClusters } from "./types.ts"
import { collapseDuplicates, type WeightedPoints } from "./weightedPoints.ts"

/**
 * Per-typology mean-shift, chunked so a run stays cancellable.
 *
 * The algorithm is the one the original worker implemented — converge a seed per
 * unique row, merge the converged centres, hard-assign every row to the nearest,
 * then take each cluster's medoid. What changed is the execution:
 *
 *  - the matrix is one flat `Float32Array`, not an array of arrays;
 *  - the shift loop accumulates into two preallocated `Float64Array`s, so it
 *    allocates *nothing* — the original's `nn.reduce((acc, el) => acc.map(...))`
 *    built a fresh array per row, per iteration, per seed;
 *  - neighbour lookup goes through a grid instead of `data.filter(...)`, which
 *    was a full scan per iteration (and another array);
 *  - duplicate rows are collapsed to weighted points, which is exact.
 *
 * Together those remove roughly `seeds × iterations × n` array allocations per
 * typology, which is where the time actually went.
 */
export class TypologyClusterer {
  private readonly unique: WeightedPoints
  private readonly seeds: Uint32Array
  private readonly grid: NeighborIndex | null
  private readonly candidates: Uint32Array

  // Reused across every shift; never reallocated.
  private readonly centre: Float64Array
  private readonly accumulator: Float64Array

  /** Converged centres, `seedCount × d`, filled as seeds complete. */
  private readonly converged: Float64Array
  private convergedCount = 0

  private seedIndex = 0
  private readonly startedAt = performance.now()

  /** Modes discovered so far, as global patient indices — the faded preview. */
  private readonly modeCentres: number[] = []
  private readonly modeMedoidPatients: number[] = []
  private modesDirty = false

  readonly bandwidth: number

  constructor(
    private readonly matrix: DurationMatrix,
    private readonly params: ClusterParams,
  ) {
    this.unique = collapseDuplicates(matrix.rows, matrix.n, matrix.d)

    this.bandwidth =
      params.bandwidth ?? estimateBandwidth(this.unique, params.bandwidthFactor, 300)

    const seedPool = strideIndices(this.unique.m, params.maxSeeds)
    this.seeds = seedPool

    this.grid = this.chooseGrid(matrix.d)

    this.candidates = new Uint32Array(this.unique.m)
    if (this.grid === null) {
      // No grid: the candidate list is simply every point, filled once so the
      // shift loop has a single uniform code path.
      for (let i = 0; i < this.unique.m; i++) this.candidates[i] = i
    }

    this.centre = new Float64Array(matrix.d)
    this.accumulator = new Float64Array(matrix.d)
    this.converged = new Float64Array(this.seeds.length * matrix.d)
  }

  /**
   * Builds the grid, then keeps it only if it actually narrows the search.
   *
   * Duration vectors cluster tightly, so the data often occupies far fewer cells
   * than the 3^d neighbourhood covers — in which case every query returns almost
   * the whole dataset and the grid is pure overhead. Measuring the occupancy is
   * cheap and decides it honestly, rather than trusting the dimensionality alone.
   */
  private chooseGrid(d: number): NeighborIndex | null {
    if (this.bandwidth <= 0) return null
    if (!NeighborIndex.shouldUseGrid(this.unique.m, d)) return null

    const grid = NeighborIndex.build(this.unique.points, this.unique.m, d, this.bandwidth)
    return grid.estimatedCandidates < this.unique.m * 0.75 ? grid : null
  }

  get isDone(): boolean {
    return this.seedIndex >= this.seeds.length
  }

  get progress(): number {
    return this.seeds.length === 0 ? 1 : this.seedIndex / this.seeds.length
  }

  /** Medoid patient indices of the modes found so far, if they changed. */
  takePreview(): Uint32Array | null {
    if (!this.modesDirty) return null
    this.modesDirty = false
    return Uint32Array.from(this.modeMedoidPatients)
  }

  /** Converges seeds for up to `budgetMs`. Returns true once every seed is done. */
  step(budgetMs: number): boolean {
    const started = performance.now()
    const { d } = this.matrix

    do {
      const seed = this.seeds[this.seedIndex] as number
      // Most seeds fall inside a basin already explored: converging them again
      // walks to the same mode and is the single biggest waste in the original.
      if (!this.reuseMode(seed)) this.shift(seed)

      this.converged.set(this.centre, this.convergedCount * d)
      this.convergedCount += 1
      this.trackMode()

      this.seedIndex += 1
    } while (!this.isDone && performance.now() - started < budgetMs)

    return this.isDone
  }

  /**
   * If `seed` starts within `seedPruneFactor × bandwidth` of a mode that has
   * already been found, copies that mode's centre into `this.centre` and reports
   * true. Mean-shift is deterministic, so a seed inside a mode's basin converges
   * to that mode — this skips the walk rather than changing where it ends up.
   */
  private reuseMode(seed: number): boolean {
    const factor = this.params.seedPruneFactor
    if (factor <= 0 || this.modeCentres.length === 0) return false

    const { d } = this.matrix
    const { points } = this.unique
    const radius = this.bandwidth * factor
    const squaredRadius = radius * radius
    const base = seed * d

    for (const start of this.modeCentres) {
      let squaredDistance = 0
      for (let k = 0; k < d; k++) {
        const delta = (this.converged[start + k] as number) - (points[base + k] as number)
        squaredDistance += delta * delta
      }
      if (squaredDistance <= squaredRadius) {
        for (let k = 0; k < d; k++) this.centre[k] = this.converged[start + k] as number
        return true
      }
    }
    return false
  }

  /** One seed's convergence. Zero allocation. */
  private shift(seed: number): void {
    const { d } = this.matrix
    const { points, weights, m } = this.unique
    const { centre, accumulator, candidates, grid } = this
    const { maxIteration, epsilon } = this.params

    const squaredBandwidth = this.bandwidth * this.bandwidth

    for (let k = 0; k < d; k++) centre[k] = points[seed * d + k] as number

    for (let iteration = 0; iteration < maxIteration; iteration++) {
      accumulator.fill(0)
      let totalWeight = 0

      const count = grid === null ? m : grid.collect(centre, candidates)

      for (let c = 0; c < count; c++) {
        const i = candidates[c] as number
        const base = i * d

        let squaredDistance = 0
        for (let k = 0; k < d; k++) {
          const delta = (points[base + k] as number) - (centre[k] as number)
          squaredDistance += delta * delta
        }
        if (squaredDistance > squaredBandwidth) continue

        const weight = weights[i] as number
        for (let k = 0; k < d; k++) {
          accumulator[k] = (accumulator[k] as number) + (points[base + k] as number) * weight
        }
        totalWeight += weight
      }

      // A shifted centre can land in an empty region; converge on where we are.
      if (totalWeight === 0) break

      let moved = 0
      for (let k = 0; k < d; k++) {
        const next = (accumulator[k] as number) / totalWeight
        const delta = next - (centre[k] as number)
        moved += delta * delta
        centre[k] = next
      }

      if (Math.sqrt(moved) <= epsilon) break
    }
  }

  /**
   * Online greedy merge of the centre just converged into the running modes, so
   * the preview approximates the final clusters using the same threshold that
   * `finalize` will apply.
   */
  private trackMode(): void {
    const { d } = this.matrix
    const threshold = this.bandwidth * this.params.mergeFactor
    const { centre } = this

    for (const start of this.modeCentres) {
      let squaredDistance = 0
      for (let k = 0; k < d; k++) {
        const delta = (this.converged[start + k] as number) - (centre[k] as number)
        squaredDistance += delta * delta
      }
      if (Math.sqrt(squaredDistance) < threshold) return
    }

    this.modeCentres.push((this.convergedCount - 1) * d)
    this.modeMedoidPatients.push(this.nearestPatient(centre))
    this.modesDirty = true
  }

  /** Global patient index of the original row closest to `target`. */
  private nearestPatient(target: Float64Array): number {
    const { d, n, rows, patients } = this.matrix
    let best = 0
    let bestDistance = Infinity

    for (let i = 0; i < n; i++) {
      const base = i * d
      let squaredDistance = 0
      for (let k = 0; k < d; k++) {
        const delta = (rows[base + k] as number) - (target[k] as number)
        squaredDistance += delta * delta
      }
      if (squaredDistance < bestDistance) {
        bestDistance = squaredDistance
        best = i
      }
    }

    return patients[best] as number
  }

  /** Merge → assign → memberships → medoids. Only valid once `isDone`. */
  finalize(): TypologyClusters {
    const { d, n, rows, patients, typologyKey } = this.matrix
    const centers = mergeCentres(
      this.converged,
      this.convergedCount,
      d,
      this.bandwidth * this.params.mergeFactor,
    )
    const k = centers.length / d

    // Nearest-centre assignment, keeping the full distance row for the kernel
    // memberships below so the data is walked once, not twice.
    const assignment = new Uint16Array(n)
    const distances = new Float64Array(k)
    const rawMemberships = new Float32Array(n * k)
    const sigmaSquared = 2 * this.bandwidth * this.bandwidth
    const used = new Uint8Array(k)

    for (let i = 0; i < n; i++) {
      const base = i * d
      let best = 0
      let bestDistance = Infinity

      for (let c = 0; c < k; c++) {
        let squaredDistance = 0
        for (let dim = 0; dim < d; dim++) {
          const delta = (rows[base + dim] as number) - (centers[c * d + dim] as number)
          squaredDistance += delta * delta
        }
        distances[c] = squaredDistance
        if (squaredDistance < bestDistance) {
          bestDistance = squaredDistance
          best = c
        }
      }

      assignment[i] = best
      used[best] = 1

      // Gaussian kernel weights, shifted by the minimum so the exponential
      // cannot underflow. Weights, not calibrated probabilities.
      let total = 0
      for (let c = 0; c < k; c++) {
        const weight =
          sigmaSquared === 0
            ? (distances[c] as number) === bestDistance
              ? 1
              : 0
            : Math.exp(-((distances[c] as number) - bestDistance) / sigmaSquared)
        rawMemberships[i * k + c] = weight
        total += weight
      }
      if (total > 0) {
        for (let c = 0; c < k; c++) {
          rawMemberships[i * k + c] = (rawMemberships[i * k + c] as number) / total
        }
      }
    }

    // Drop centres nothing landed on, then compact assignments and memberships.
    const remap = new Int32Array(k).fill(-1)
    let kept = 0
    for (let c = 0; c < k; c++) {
      if (used[c] === 1) remap[c] = kept++
    }

    const finalCenters = new Float32Array(kept * d)
    for (let c = 0; c < k; c++) {
      const target = remap[c] as number
      if (target === -1) continue
      for (let dim = 0; dim < d; dim++) {
        finalCenters[target * d + dim] = centers[c * d + dim] as number
      }
    }

    const finalAssignment = new Uint16Array(n)
    const memberships = new Float32Array(n * kept)
    const sizes = new Uint32Array(kept)

    for (let i = 0; i < n; i++) {
      const target = remap[assignment[i] as number] as number
      finalAssignment[i] = target
      sizes[target] = (sizes[target] as number) + 1

      for (let c = 0; c < k; c++) {
        const mapped = remap[c] as number
        if (mapped === -1) continue
        memberships[i * kept + mapped] = rawMemberships[i * k + c] as number
      }
    }

    // Medoid: the row closest to its own cluster's centre.
    const medoidRow = new Uint32Array(kept)
    const medoidDistance = new Float64Array(kept).fill(Infinity)

    for (let i = 0; i < n; i++) {
      const c = finalAssignment[i] as number
      const base = i * d
      let squaredDistance = 0
      for (let dim = 0; dim < d; dim++) {
        const delta = (rows[base + dim] as number) - (finalCenters[c * d + dim] as number)
        squaredDistance += delta * delta
      }
      if (squaredDistance < (medoidDistance[c] as number)) {
        medoidDistance[c] = squaredDistance
        medoidRow[c] = i
      }
    }

    const medoidPatient = new Uint32Array(kept)
    for (let c = 0; c < kept; c++) {
      medoidPatient[c] = patients[medoidRow[c] as number] as number
    }

    return {
      typologyKey,
      n,
      d,
      k: kept,
      bandwidth: this.bandwidth,
      patients,
      assignment: finalAssignment,
      memberships,
      centers: finalCenters,
      sizes,
      medoidRow,
      medoidPatient,
      meanSilhouette: meanSilhouetteScore(
        rows,
        n,
        d,
        finalAssignment,
        kept,
        this.params.scoreSampleLimit,
      ),
      medianCluster: medianByDuration(rows, d, medoidRow, kept),
      durationMs: performance.now() - this.startedAt,
    }
  }
}

/** A typology too small or too uniform to cluster collapses to one group. */
export function singleCluster(matrix: DurationMatrix): TypologyClusters {
  const { n, d, rows, patients, typologyKey } = matrix
  const centers = new Float32Array(d)
  for (let k = 0; k < d; k++) centers[k] = rows[k] as number

  const memberships = new Float32Array(n).fill(1)
  const sizes = new Uint32Array(1)
  sizes[0] = n

  return {
    typologyKey,
    n,
    d,
    k: 1,
    bandwidth: 0,
    patients,
    assignment: new Uint16Array(n),
    memberships,
    centers,
    sizes,
    medoidRow: new Uint32Array(1),
    medoidPatient: Uint32Array.of(patients[0] as number),
    meanSilhouette: 0,
    medianCluster: 0,
    durationMs: 0,
  }
}

/**
 * `bandwidthFactor × mean pairwise distance` over a deterministic subsample —
 * the original's heuristic, kept so results stay comparable.
 */
export function estimateBandwidth(
  unique: WeightedPoints,
  factor: number,
  sampleLimit: number,
): number {
  const { points, d, m } = unique
  const sample = strideIndices(m, sampleLimit)

  let sum = 0
  let count = 0
  for (let a = 0; a < sample.length; a++) {
    for (let b = a + 1; b < sample.length; b++) {
      const baseA = (sample[a] as number) * d
      const baseB = (sample[b] as number) * d
      let squaredDistance = 0
      for (let k = 0; k < d; k++) {
        const delta = (points[baseA + k] as number) - (points[baseB + k] as number)
        squaredDistance += delta * delta
      }
      sum += Math.sqrt(squaredDistance)
      count += 1
    }
  }

  return Math.max(factor * (count > 0 ? sum / count : 0), 1e-9)
}

/** Greedy merge of converged centres within `threshold`, as a weighted running mean. */
function mergeCentres(
  converged: Float64Array,
  count: number,
  d: number,
  threshold: number,
): Float64Array {
  const merged = new Float64Array(count * d)
  const counts = new Uint32Array(count)
  let mergedCount = 0

  for (let c = 0; c < count; c++) {
    const base = c * d
    let target = -1

    for (let existing = 0; existing < mergedCount; existing++) {
      let squaredDistance = 0
      for (let k = 0; k < d; k++) {
        const delta = (merged[existing * d + k] as number) - (converged[base + k] as number)
        squaredDistance += delta * delta
      }
      if (Math.sqrt(squaredDistance) < threshold) {
        target = existing
        break
      }
    }

    if (target === -1) {
      for (let k = 0; k < d; k++) merged[mergedCount * d + k] = converged[base + k] as number
      counts[mergedCount] = 1
      mergedCount += 1
    } else {
      const weight = counts[target] as number
      for (let k = 0; k < d; k++) {
        merged[target * d + k] =
          ((merged[target * d + k] as number) * weight + (converged[base + k] as number)) /
          (weight + 1)
      }
      counts[target] = weight + 1
    }
  }

  return merged.slice(0, mergedCount * d)
}

/** Sampled mean silhouette coefficient. Same sampling strategy as the original. */
function meanSilhouetteScore(
  rows: Float32Array,
  n: number,
  d: number,
  assignment: Uint16Array,
  k: number,
  sampleLimit: number,
): number {
  if (k < 2) return 0

  // Both sides are sampled. The original compared each sampled point against
  // *every* point, making the score O(sample x n) — at 250k patients that single
  // metric cost more than the clustering it was describing. Sampling the
  // reference side too makes it O(sample^2) and leaves the value statistically
  // equivalent, since it was already an estimate.
  const sample = strideIndices(n, sampleLimit)
  const reference = sample
  const sums = new Float64Array(k)
  const counts = new Uint32Array(k)

  let total = 0

  for (let s = 0; s < sample.length; s++) {
    const i = sample[s] as number
    const own = assignment[i] as number
    sums.fill(0)
    counts.fill(0)

    const base = i * d
    for (let r = 0; r < reference.length; r++) {
      const j = reference[r] as number
      if (j === i) continue
      const other = assignment[j] as number
      const otherBase = j * d

      let squaredDistance = 0
      for (let dim = 0; dim < d; dim++) {
        const delta = (rows[base + dim] as number) - (rows[otherBase + dim] as number)
        squaredDistance += delta * delta
      }

      sums[other] = (sums[other] as number) + Math.sqrt(squaredDistance)
      counts[other] = (counts[other] as number) + 1
    }

    const a = (counts[own] as number) > 0 ? (sums[own] as number) / (counts[own] as number) : 0

    let b = Infinity
    for (let c = 0; c < k; c++) {
      if (c === own || (counts[c] as number) === 0) continue
      const mean = (sums[c] as number) / (counts[c] as number)
      if (mean < b) b = mean
    }

    if (b === Infinity) continue
    const denominator = Math.max(a, b)
    total += denominator === 0 ? 0 : (b - a) / denominator
  }

  return sample.length === 0 ? 0 : total / sample.length
}

/** The cluster whose medoid has the median total duration — the reveal highlight. */
function medianByDuration(
  rows: Float32Array,
  d: number,
  medoidRow: Uint32Array,
  k: number,
): number {
  if (k === 0) return 0

  const order = Array.from({ length: k }, (_, c) => c)
  const totalOf = (c: number): number => {
    const base = (medoidRow[c] as number) * d
    let sum = 0
    for (let dim = 0; dim < d; dim++) sum += rows[base + dim] as number
    return sum
  }

  order.sort((a, b) => totalOf(a) - totalOf(b))
  return order[Math.floor(order.length / 2)] as number
}
