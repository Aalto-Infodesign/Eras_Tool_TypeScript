/**
 * Core domain types.
 *
 * The whole point of the columnar rewrite is that *everything downstream of
 * parsing is an integer index into a typed array*. That makes indices cheap but
 * also dangerously interchangeable — a `PatientIndex` and an `EventIndex` are
 * both `number` at runtime and mixing them is a silent, data-corrupting bug.
 * Branded types make the compiler catch that, at zero runtime cost.
 */

import type { IdColumn } from "./model/IdColumn.ts"

declare const brand: unique symbol
type Brand<T, B> = T & { readonly [brand]: B }

/** Row in the patient-level columns (`ids`, `offsets`, `diseaseDuration`). */
export type PatientIndex = Brand<number, "PatientIndex">
/** Row in the event-level columns (`stateIds`, `ages`, `years`, `durations`). */
export type EventIndex = Brand<number, "EventIndex">
/** Position of a state name in `StateVocabulary`. */
export type StateId = Brand<number, "StateId">

export const asPatient = (n: number): PatientIndex => n as PatientIndex
export const asEvent = (n: number): EventIndex => n as EventIndex
export const asState = (n: number): StateId => n as StateId

/** One patient as it exists between parsing and store construction. */
export interface PatientRecord {
  readonly id: string
  readonly trajectory: readonly string[]
  readonly switchEventAge: readonly number[]
  readonly years: readonly number[]
  readonly diseaseDuration: number
}

/**
 * The dataset in Compressed-Sparse-Row layout.
 *
 * Patient `p` owns events `offsets[p] .. offsets[p + 1] - 1`. Every event-level
 * column is one flat typed array of length `eventCount`, so a full scan is a
 * linear walk over contiguous memory instead of a pointer chase through
 * `{ source: {...}, target: {...} }` objects.
 *
 * A "link" (the old `speed`/lump segment) is not stored: link `i` is the pair
 * (event `i`, event `i + 1`) whenever both belong to the same patient, so
 * `linkCount === eventCount` with the last event of each patient being a
 * self-link. `durations` is precomputed because filters read it on every frame.
 */
export interface TrajectoryStore {
  readonly patientCount: number
  readonly eventCount: number

  /** Patient-level, length `patientCount`. */
  readonly ids: IdColumn
  readonly diseaseDuration: Float32Array
  /** Length `patientCount + 1`; `offsets[patientCount] === eventCount`. */
  readonly offsets: Uint32Array

  /** Event-level, length `eventCount`. */
  readonly stateIds: Uint16Array
  readonly ages: Float32Array
  readonly years: Float32Array
  /**
   * `|years[i+1] - years[i]|` within a patient, `0` on a patient's last event.
   * This is the old `speed` field — which was always a duration, never a speed.
   */
  readonly durations: Float32Array
  /** Owning patient of each event; avoids a binary search over `offsets`. */
  readonly eventPatient: Uint32Array

  readonly stateNames: readonly string[]
  readonly extents: Extents
}

export interface Extents {
  readonly age: readonly [number, number]
  readonly year: readonly [number, number]
  readonly duration: readonly [number, number]
  readonly diseaseDuration: readonly [number, number]
  readonly maxTrajectoryLength: number
}

/** A group of patients sharing an identical ordered state sequence. */
export interface Typology {
  readonly key: string
  readonly states: Uint16Array
  /** Patient indices, ascending. */
  readonly patients: Uint32Array
  readonly size: number
  readonly share: number
}

export interface StateSummary {
  readonly id: StateId
  readonly name: string
  readonly population: number
  /** Count of appearances at each trajectory position; length = maxTrajectoryLength. */
  readonly frequencies: Uint32Array
}
