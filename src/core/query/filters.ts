import type { TrajectoryStore } from "../types.ts"
import { Selection } from "./Selection.ts"

export interface Range {
  readonly min: number
  readonly max: number
}

/** The four range filters, each with its own extent, slider and distribution. */
export type NumericFilter = "age" | "year" | "diseaseDuration" | "duration"

export interface FilterState {
  readonly age: Range | null
  readonly year: Range | null
  readonly diseaseDuration: Range | null
  readonly duration: Range | null
  /** Typology keys; empty means "all typologies". */
  readonly typologies: readonly string[]
  /**
   * Interned state ids the user has removed. This is *not* applied here — it is
   * applied to the store itself by `model/reshape.ts`, which is what the
   * original did too. It lives on the filter state because that is where the
   * original kept it and because it is what the UI toggles.
   */
  readonly removedStates: readonly number[]
  /**
   * Which ranges read as "outside this" rather than "inside it". Inverting is a
   * one-click way to ask the opposite question of a range you have already
   * placed, which is the whole reason the original put it next to the handles.
   */
  readonly inverted: Readonly<Partial<Record<NumericFilter, boolean>>>
}

export const emptyFilters: FilterState = {
  age: null,
  year: null,
  diseaseDuration: null,
  duration: null,
  typologies: [],
  removedStates: [],
  inverted: {},
}

const within = (value: number, range: Range | null): boolean =>
  range === null || (value >= range.min && value <= range.max)

const apply = (passes: boolean, inverted: boolean | undefined): boolean =>
  inverted === true ? !passes : passes

/**
 * Rewrites `into.mask` in place. Allocation-free on the hot path, so a slider
 * drag costs one linear scan rather than a full pipeline re-derivation.
 */
export function applyFilters(
  store: TrajectoryStore,
  filters: FilterState,
  into: Selection = new Selection(store.patientCount),
): Selection {
  const { mask } = into
  const { offsets, ages, years, diseaseDuration, durations } = store

  // Typology membership is resolved to a patient-level allow list by the caller
  // (`selectTypologies`), so this loop only ever tests numeric ranges.
  let visible = 0

  for (let p = 0; p < store.patientCount; p++) {
    const start = offsets[p] as number
    const end = offsets[p + 1] as number

    // Removing a state splices it out of the store, which can leave a patient
    // with nothing at all. They would otherwise count as visible while drawing
    // nothing. See `model/reshape.ts`.
    let keep = end > start

    keep = keep && apply(
      within(diseaseDuration[p] as number, filters.diseaseDuration),
      filters.inverted.diseaseDuration,
    )

    if (keep && filters.year !== null) {
      // A patient passes the date filter when their whole span sits inside it,
      // matching the original's `min(years) >= lo && max(years) <= hi`.
      let lo = Infinity
      let hi = -Infinity
      for (let e = start; e < end; e++) {
        const y = years[e] as number
        if (y < lo) lo = y
        if (y > hi) hi = y
      }
      keep = apply(lo >= filters.year.min && hi <= filters.year.max, filters.inverted.year)
    }

    if (keep && filters.age !== null) {
      let lo = Infinity
      let hi = -Infinity
      for (let e = start; e < end; e++) {
        const a = ages[e] as number
        if (a < lo) lo = a
        if (a > hi) hi = a
      }
      keep = apply(lo >= filters.age.min && hi <= filters.age.max, filters.inverted.age)
    }

    if (keep && filters.duration !== null) {
      // Segment-level: keep the patient if any transition falls in range.
      let any = false
      for (let e = start; e < end - 1; e++) {
        if (within(durations[e] as number, filters.duration)) {
          any = true
          break
        }
      }
      keep = apply(any, filters.inverted.duration)
    }

    mask[p] = keep ? 1 : 0
    if (keep) visible += 1
  }

  into.invalidate(visible)
  return into
}

/** Intersects the current mask with the patients of the named typologies. */
export function intersectTypologies(
  selection: Selection,
  typologyPatients: readonly Uint32Array[],
): Selection {
  if (typologyPatients.length === 0) return selection

  const allowed = new Uint8Array(selection.patientCount)
  for (const patients of typologyPatients) {
    for (let i = 0; i < patients.length; i++) allowed[patients[i] as number] = 1
  }

  let visible = 0
  for (let p = 0; p < selection.patientCount; p++) {
    const keep = selection.mask[p] === 1 && allowed[p] === 1
    selection.mask[p] = keep ? 1 : 0
    if (keep) visible += 1
  }

  selection.invalidate(visible)
  return selection
}
