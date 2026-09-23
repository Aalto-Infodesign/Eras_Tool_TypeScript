import { buildStore } from "../model/build.ts"
import type { PatientRecord, TrajectoryStore } from "../types.ts"
import { Stopwatch, type Timing } from "../util/time.ts"
import { readDelimitedRows } from "./delimited.ts"
import { jsonToRecords } from "./json.ts"
import { detectMapping, type ColumnMapping, type MappingCandidate } from "./schema.ts"
import { rowsToRecords } from "./toRecords.ts"

export type SourceFormat = "json" | "delimited"

export interface IngestOptions {
  /** Skips detection when the user has already confirmed or overridden a mapping. */
  readonly mapping?: ColumnMapping
  readonly format?: SourceFormat
}

export interface IngestResult {
  readonly store: TrajectoryStore
  /** `null` for wide JSON, which needs no column mapping. */
  readonly mapping: MappingCandidate | null
  readonly format: SourceFormat
  readonly timings: readonly Timing[]
}

/** Extension is a hint; the first non-whitespace byte is the decider. */
export function detectFormat(text: string, fileName?: string): SourceFormat {
  if (fileName !== undefined && /\.(tsv|csv|txt)$/i.test(fileName)) return "delimited"
  if (fileName !== undefined && /\.json$/i.test(fileName)) return "json"
  const head = text.slice(0, 256).trimStart()
  return head.startsWith("[") || head.startsWith("{") ? "json" : "delimited"
}

const SAMPLE_ROWS = 50

export function ingest(text: string, fileName?: string, options: IngestOptions = {}): IngestResult {
  const clock = new Stopwatch()
  const format = options.format ?? detectFormat(text, fileName)

  let records: PatientRecord[]
  let mapping: MappingCandidate | null = null

  if (format === "json") {
    const parsed = clock.measure("JSON.parse", () => JSON.parse(text) as unknown)
    records = clock.measure("normalise", () => jsonToRecords(parsed))
  } else {
    const rows = clock.measure("tokenise", () => readDelimitedRows(text))
    const [headers = [], ...body] = rows

    const candidate = clock.measure("detect columns", (): MappingCandidate | null => {
      const override = options.mapping
      if (override !== undefined) {
        return { mapping: override, confidence: 1, source: "manual", notes: [] }
      }
      return detectMapping({ headers, rows: body.slice(0, SAMPLE_ROWS) })
    })

    if (candidate === null) {
      throw new Error(
        `Could not identify a patient-id and a state column in: ${headers.join(", ")}`,
      )
    }
    mapping = candidate
    records = clock.measure("group rows", () => rowsToRecords(body, headers, candidate.mapping))
  }

  const store = clock.measure("build store", () => buildStore(records))

  return { store, mapping, format, timings: clock.timings }
}
