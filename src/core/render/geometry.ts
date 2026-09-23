import type { TrajectoryStore } from "../types.ts"
import type { Palette } from "./palette.ts"

/**
 * Vertex buffers for a trajectory layer, in **data space**.
 *
 * Positions are `(x = age|year, y = state row index)`, not pixels. The viewport
 * transform lives in the vertex shader (or in the Canvas2D transform), so
 * resizing, panning and zooming change a uniform instead of rebuilding a
 * million-element buffer. Only a change of *which* patients are shown, of the
 * vertical state ordering, or of the colour source forces a rebuild.
 *
 * Two vertices per segment, drawn as `gl.LINES`. Per-vertex colour gives the
 * source→target gradient for free — the effect the SVG version paid for with a
 * `<linearGradient>` def per state pair.
 */
export interface Geometry {
  /**
   * `[x0, s0, x1, s1, …]`, 4 floats per segment: an x in data units and the
   * **state id** of that end — not its row.
   *
   * Rows are a property of the *view*: the user reorders them, and the ordering
   * says nothing about the data. Baking a row into a million vertices meant that
   * dragging one state past another rebuilt and re-uploaded the whole buffer,
   * and made the move impossible to animate. Resolving the row from the id at
   * draw time turns a reorder into a lookup upload of a few dozen floats, and an
   * animated reorder into interpolating those same few dozen.
   */
  readonly positions: Float32Array
  /** RGBA per vertex, 8 bytes per segment. */
  readonly colors: Uint8Array
  /** Owning patient of each segment; used for picking and highlight lookup. */
  readonly segmentPatient: Uint32Array
  /** Source event of each segment, for tooltips. */
  readonly segmentEvent: Uint32Array
  readonly segmentCount: number
}

export type XAxis = "age" | "year"

/**
 * Where each segment's colour comes from.
 *
 * `state` gives the source→target gradient of the original chart. `cluster`
 * paints a patient's whole path in its cluster's colour, which turns the density
 * field itself into the cluster map — the cheapest possible way to show
 * clustering over hundreds of thousands of individuals, since it changes only
 * the colour buffer and leaves positions untouched.
 */
export type ColorSource =
  | { readonly kind: "state"; readonly palette: Palette }
  | {
      readonly kind: "cluster"
      readonly palette: Palette
      /** Patient → global cluster index, `-1` when not yet clustered. */
      readonly clusterOfPatient: Int32Array
      /** Colour for patients no cluster has claimed yet. */
      readonly unclustered: readonly [number, number, number]
    }

export interface GeometryOptions {
  readonly axis: XAxis
  readonly color: ColorSource
  /** Drop segments whose duration falls outside this. */
  readonly durationRange?: { min: number; max: number } | null
}

/**
 * Builds geometry for an explicit list of patients.
 *
 * Taking the patient list rather than a `Selection` is what lets the same
 * builder produce both the bulk layer (`selection.indices()`) and the medoid
 * spine layer (a handful of representative patients) with no special casing.
 */
export function buildGeometry(
  store: TrajectoryStore,
  patients: Uint32Array,
  options: GeometryOptions,
): Geometry {
  let capacity = 0
  for (let i = 0; i < patients.length; i++) {
    const p = patients[i] as number
    capacity += (store.offsets[p + 1] as number) - (store.offsets[p] as number)
  }

  const positions = new Float32Array(capacity * 4)
  const colors = new Uint8Array(capacity * 8)
  const segmentPatient = new Uint32Array(capacity)
  const segmentEvent = new Uint32Array(capacity)

  const xs = options.axis === "age" ? store.ages : store.years
  const { color, durationRange } = options
  const paletteBytes = color.palette.bytes

  let s = 0

  // Per-patient state the emitter reads. Hoisted so the emitter is one closure
  // for the whole call rather than one per patient.
  let patient = 0
  let clusterR = 0
  let clusterG = 0
  let clusterB = 0

  /** Writes one segment from event `from` to event `to` (`from === to` = a stop). */
  const emit = (from: number, to: number): void => {
    // Duration is measured between the events actually linked, so a segment that
    // spans a spliced-out state is judged on the gap it really covers.
    if (durationRange !== null && durationRange !== undefined && from !== to) {
      const d = Math.abs((store.years[to] as number) - (store.years[from] as number))
      if (d < durationRange.min || d > durationRange.max) return
    }

    const sourceState = store.stateIds[from] as number
    const targetState = store.stateIds[to] as number

    const pos = s * 4
    positions[pos + 0] = xs[from] as number
    positions[pos + 1] = sourceState
    positions[pos + 2] = xs[to] as number
    positions[pos + 3] = targetState

    const col = s * 8
    if (color.kind === "cluster") {
      colors[col + 0] = clusterR
      colors[col + 1] = clusterG
      colors[col + 2] = clusterB
      colors[col + 3] = 255
      colors[col + 4] = clusterR
      colors[col + 5] = clusterG
      colors[col + 6] = clusterB
      colors[col + 7] = 255
    } else {
      const src = sourceState * 4
      const dst = targetState * 4
      colors[col + 0] = paletteBytes[src + 0] as number
      colors[col + 1] = paletteBytes[src + 1] as number
      colors[col + 2] = paletteBytes[src + 2] as number
      colors[col + 3] = 255
      colors[col + 4] = paletteBytes[dst + 0] as number
      colors[col + 5] = paletteBytes[dst + 1] as number
      colors[col + 6] = paletteBytes[dst + 2] as number
      colors[col + 7] = 255
    }

    segmentPatient[s] = patient
    segmentEvent[s] = from
    s += 1
  }

  for (let i = 0; i < patients.length; i++) {
    const p = patients[i] as number
    patient = p
    const start = store.offsets[p] as number
    const end = store.offsets[p + 1] as number

    // Resolved once per patient: a patient belongs to exactly one cluster, so
    // the lookup does not belong in the per-segment loop.
    if (color.kind === "cluster") {
      const cluster = color.clusterOfPatient[p] ?? -1
      if (cluster < 0) {
        clusterR = color.unclustered[0]
        clusterG = color.unclustered[1]
        clusterB = color.unclustered[2]
      } else {
        const base = (cluster % (paletteBytes.length / 4)) * 4
        clusterR = paletteBytes[base] as number
        clusterG = paletteBytes[base + 1] as number
        clusterB = paletteBytes[base + 2] as number
      }
    }

    // Each event links to the next; the last links to itself, which is the
    // store's stop convention. States removed by the user are already gone from
    // the store (see `model/reshape.ts`), so there is nothing to skip here.
    let prev = -1
    for (let e = start; e < end; e++) {
      if (prev !== -1) emit(prev, e)
      prev = e
    }
    if (prev !== -1) emit(prev, prev)
  }

  // `subarray` keeps the views pointing at the single allocation above — no copy
  // even when the duration filter dropped a large fraction of segments.
  return {
    positions: positions.subarray(0, s * 4),
    colors: colors.subarray(0, s * 8),
    segmentPatient: segmentPatient.subarray(0, s),
    segmentEvent: segmentEvent.subarray(0, s),
    segmentCount: s,
  }
}

/**
 * Row lookup from a state ordering; states not in the order are parked off-chart.
 *
 * Float rather than integer because this is also what an animated reorder
 * interpolates through: a state half way between rows 2 and 3 is at 2.5, and
 * every layer — the shader, the canvas fallback, the SVG overlays — reads it the
 * same way.
 */
export function rowLookup(stateCount: number, order: readonly number[]): Float32Array {
  const rowOf = new Float32Array(stateCount).fill(-1)
  for (let row = 0; row < order.length; row++) {
    const state = order[row] as number
    if (state >= 0 && state < stateCount) rowOf[state] = row
  }
  return rowOf
}
