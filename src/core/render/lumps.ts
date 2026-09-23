import type { TrajectoryStore } from "../types.ts"
import type { Range } from "../query/filters.ts"
import type { XAxis } from "./geometry.ts"

/**
 * Lumps — the original's aggregate reading, and the alternative to the hairlines.
 *
 * A lump is every transition between one ordered pair of states, collapsed into
 * the *extent* it covers: where the earliest and latest departure from the source
 * sit, and where the earliest and latest arrival at the target sit. Four numbers,
 * drawn as a four-cornered quad with its top edge flat on the source row and its
 * bottom edge flat on the target row.
 *
 * The property that makes this cheap is that there are at most `states²` lumps
 * however many patients there are, so the whole layer is bounded by the
 * vocabulary rather than by the data. Building it is a single pass.
 *
 * A link follows the store's convention exactly as `buildGeometry` reads it:
 * link `e` is the pair (event `e`, event `e + 1`) within a patient, and a
 * patient's last event is a self-link onto its own state — which surfaces here
 * as a lump whose source and target states are equal, lying flat on one row.
 */
export interface Lump {
  readonly sourceState: number
  readonly targetState: number
  /** Links collapsed into this lump. */
  readonly count: number
  /** Earliest and latest departure from the source state. */
  readonly sourceMin: number
  readonly sourceMax: number
  /** Earliest and latest arrival at the target state. */
  readonly targetMin: number
  readonly targetMax: number
}

export interface LumpOptions {
  readonly axis: XAxis
  /** Drop links whose duration falls outside this, as the hairline layer does. */
  readonly durationRange?: Range | null
}

export function buildLumps(
  store: TrajectoryStore,
  patients: Uint32Array,
  options: LumpOptions,
): Lump[] {
  const stateCount = store.stateNames.length
  if (stateCount === 0) return []

  const xs = options.axis === "age" ? store.ages : store.years
  const durationRange = options.durationRange ?? null

  // One slot per ordered state pair. Bounded by the vocabulary, so this is a
  // fixed, small allocation no matter how many patients are in view.
  const slots = stateCount * stateCount
  const counts = new Uint32Array(slots)
  const sourceMin = new Float64Array(slots).fill(Infinity)
  const sourceMax = new Float64Array(slots).fill(-Infinity)
  const targetMin = new Float64Array(slots).fill(Infinity)
  const targetMax = new Float64Array(slots).fill(-Infinity)

  for (let i = 0; i < patients.length; i++) {
    const p = patients[i] as number
    const start = store.offsets[p] as number
    const end = store.offsets[p + 1] as number

    const add = (from: number, to: number): void => {
      // Measured between the events actually linked, so a link spanning a
      // spliced-out state is judged on the gap it really covers.
      if (durationRange !== null && from !== to) {
        const d = Math.abs((store.years[to] as number) - (store.years[from] as number))
        if (d < durationRange.min || d > durationRange.max) return
      }

      const slot = (store.stateIds[from] as number) * stateCount + (store.stateIds[to] as number)

      const sx = xs[from] as number
      const tx = xs[to] as number

      counts[slot] = (counts[slot] as number) + 1
      if (sx < (sourceMin[slot] as number)) sourceMin[slot] = sx
      if (sx > (sourceMax[slot] as number)) sourceMax[slot] = sx
      if (tx < (targetMin[slot] as number)) targetMin[slot] = tx
      if (tx > (targetMax[slot] as number)) targetMax[slot] = tx
    }

    // Each event links to the next; the last links to itself.
    let prev = -1
    for (let e = start; e < end; e++) {
      if (prev !== -1) add(prev, e)
      prev = e
    }
    if (prev !== -1) add(prev, prev)
  }

  const lumps: Lump[] = []
  for (let slot = 0; slot < slots; slot++) {
    const count = counts[slot] as number
    if (count === 0) continue

    lumps.push({
      sourceState: Math.floor(slot / stateCount),
      targetState: slot % stateCount,
      count,
      sourceMin: sourceMin[slot] as number,
      sourceMax: sourceMax[slot] as number,
      targetMin: targetMin[slot] as number,
      targetMax: targetMax[slot] as number,
    })
  }

  // Biggest first: the heaviest transitions draw underneath, so a small lump is
  // never hidden by a large one painted over it.
  lumps.sort((a, b) => b.count - a.count)
  return lumps
}
