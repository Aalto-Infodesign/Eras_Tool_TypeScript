import type { Extents, TrajectoryStore } from "../types.ts"
import { IdColumn } from "./IdColumn.ts"

/**
 * Wire form of the store.
 *
 * `structuredClone` does not preserve class prototypes, so `IdColumn` is flattened
 * to its two buffers and rebuilt on the other side. Everything here is either a
 * typed array (transferable) or a small header, which is what makes the handoff
 * from the ingest worker effectively free regardless of dataset size.
 */
export interface StorePayload {
  readonly patientCount: number
  readonly eventCount: number
  readonly idBytes: Uint8Array
  readonly idOffsets: Uint32Array
  readonly diseaseDuration: Float32Array
  readonly offsets: Uint32Array
  readonly stateIds: Uint16Array
  readonly ages: Float32Array
  readonly years: Float32Array
  readonly durations: Float32Array
  readonly eventPatient: Uint32Array
  readonly stateNames: readonly string[]
  readonly extents: Extents
}

export function toPayload(store: TrajectoryStore): StorePayload {
  return {
    patientCount: store.patientCount,
    eventCount: store.eventCount,
    idBytes: store.ids.bytes,
    idOffsets: store.ids.offsets,
    diseaseDuration: store.diseaseDuration,
    offsets: store.offsets,
    stateIds: store.stateIds,
    ages: store.ages,
    years: store.years,
    durations: store.durations,
    eventPatient: store.eventPatient,
    stateNames: store.stateNames,
    extents: store.extents,
  }
}

export function fromPayload(payload: StorePayload): TrajectoryStore {
  return {
    patientCount: payload.patientCount,
    eventCount: payload.eventCount,
    ids: new IdColumn(payload.idBytes, payload.idOffsets),
    diseaseDuration: payload.diseaseDuration,
    offsets: payload.offsets,
    stateIds: payload.stateIds,
    ages: payload.ages,
    years: payload.years,
    durations: payload.durations,
    eventPatient: payload.eventPatient,
    stateNames: payload.stateNames,
    extents: payload.extents,
  }
}

export function payloadTransferables(payload: StorePayload): Transferable[] {
  return [
    payload.idBytes.buffer,
    payload.idOffsets.buffer,
    payload.diseaseDuration.buffer,
    payload.offsets.buffer,
    payload.stateIds.buffer,
    payload.ages.buffer,
    payload.years.buffer,
    payload.durations.buffer,
    payload.eventPatient.buffer,
  ] as Transferable[]
}
