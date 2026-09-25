import type { StorePayload } from "../core/model/transfer.ts"
import type { SourceFormat } from "../core/parse/ingest.ts"
import type { ColumnMapping, MappingCandidate } from "../core/parse/schema.ts"
import type { StateSummary } from "../core/types.ts"
import type { Timing } from "../core/util/time.ts"

export interface IngestRequest {
  readonly type: "ingest"
  readonly requestId: number
  readonly text: string
  readonly fileName: string
  readonly mapping?: ColumnMapping
}

/** Plain-object mirror of `StateSummary`, whose typed arrays survive cloning. */
export interface StateSummaryPayload {
  readonly id: number
  readonly name: string
  readonly population: number
  readonly frequencies: Uint32Array
}

export interface IngestSuccess {
  readonly type: "ingest:ok"
  readonly requestId: number
  readonly store: StorePayload
  readonly mapping: MappingCandidate | null
  readonly format: SourceFormat
  readonly states: readonly StateSummaryPayload[]
  readonly stateOrder: readonly number[]
  readonly timings: readonly Timing[]
}

export interface IngestFailure {
  readonly type: "ingest:error"
  readonly requestId: number
  readonly message: string
}

export type WorkerRequest = IngestRequest
export type WorkerResponse = IngestSuccess | IngestFailure

export const toStatePayload = (s: StateSummary): StateSummaryPayload => ({
  id: s.id,
  name: s.name,
  population: s.population,
  // `subarray` views share the matrix buffer; slice so each one transfers cleanly.
  frequencies: s.frequencies.slice(),
})
