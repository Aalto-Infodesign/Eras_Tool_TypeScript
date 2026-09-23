import type { PatientRecord } from "../types.ts"

/**
 * Wide-format JSON: one object per patient with parallel arrays.
 *
 * The original normalised `personSourceValue` by running
 * `raw.replace(/\bpersonSourceValue\b/, "FINNGENID")` over the *whole file text*
 * before `JSON.parse` — a scan of every byte, and without the `g` flag it only
 * ever fixed the first record. Renaming is done here per object instead.
 */

const ID_KEYS = ["FINNGENID", "personSourceValue", "person_id", "patientId", "id"] as const
const TRAJECTORY_KEYS = ["trajectory", "states", "stages"] as const
const AGE_KEYS = ["SwitchEventAge", "switchEventAge", "ages", "age"] as const
const YEAR_KEYS = ["years", "dates", "year"] as const
const DURATION_KEYS = ["diseaseDuration", "disease_duration", "duration"] as const

type Row = Record<string, unknown>

function firstKey(row: Row, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    if (key in row) return key
  }
  return undefined
}

function toNumbers(value: unknown, length: number, fallback: readonly number[]): number[] {
  if (!Array.isArray(value)) return fallback.slice(0, length)
  const out = new Array<number>(length)
  for (let i = 0; i < length; i++) {
    const n = Number(value[i])
    out[i] = Number.isFinite(n) ? n : (fallback[i] ?? 0)
  }
  return out
}

export function jsonToRecords(parsed: unknown): PatientRecord[] {
  if (!Array.isArray(parsed)) {
    throw new Error("Expected the JSON file to contain an array of patient objects")
  }
  if (parsed.length === 0) return []

  const head = parsed[0] as Row
  const idKey = firstKey(head, ID_KEYS)
  const trajectoryKey = firstKey(head, TRAJECTORY_KEYS)

  if (idKey === undefined || trajectoryKey === undefined) {
    throw new Error(
      `JSON records need an id field (${ID_KEYS.join(", ")}) and a trajectory field ` +
        `(${TRAJECTORY_KEYS.join(", ")}). Found: ${Object.keys(head).join(", ")}`,
    )
  }

  const ageKey = firstKey(head, AGE_KEYS)
  const yearKey = firstKey(head, YEAR_KEYS)
  const durationKey = firstKey(head, DURATION_KEYS)

  const records: PatientRecord[] = new Array<PatientRecord>(parsed.length)
  let written = 0

  for (const raw of parsed as Row[]) {
    const trajectoryValue = raw[trajectoryKey]
    if (!Array.isArray(trajectoryValue) || trajectoryValue.length === 0) continue

    const trajectory = trajectoryValue.map(String)
    const n = trajectory.length

    const zeros = new Array<number>(n).fill(0)
    const ages = ageKey === undefined ? zeros : toNumbers(raw[ageKey], n, zeros)
    const years = yearKey === undefined ? ages : toNumbers(raw[yearKey], n, ages)

    const declared = durationKey === undefined ? Number.NaN : Number(raw[durationKey])
    const diseaseDuration = Number.isFinite(declared)
      ? declared
      : (years[n - 1] ?? 0) - (years[0] ?? 0)

    records[written++] = {
      id: String(raw[idKey] ?? `row_${written}`),
      trajectory,
      switchEventAge: ages,
      years,
      diseaseDuration,
    }
  }

  records.length = written
  return records
}
