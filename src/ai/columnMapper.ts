import type {
  ColumnMapping,
  HeaderSample,
  MappingCandidate,
} from "../core/parse/schema.ts"
import { COLUMN_ROLES, detectMapping } from "../core/parse/schema.ts"

/**
 * Assisted column mapping (TypeSafe System One).
 *
 * WHERE THIS BELONGS, AND WHERE IT DOES NOT
 *
 * The hot path of this tool is millions of numeric operations per interaction.
 * Nothing on that path should ever call a model: a judgment per patient, per
 * link or per frame is exactly the kind of thing the rewrite exists to remove.
 *
 * Import is the opposite situation. It happens once per file, it is already
 * asynchronous, and it is the one place where the tool has to interpret
 * something genuinely semantic — *what do these column names mean?* The original
 * hard-coded `FINNGENID` / `stage` / `age` / `date`, so a real export with
 * `patient_id`, `dx_code` and `event_date` silently produced an empty chart.
 *
 * So: one request per file, over the header row and a few sample rows. Five
 * independent Choice questions (one per role) in a single `systemOne` call —
 * they share the same state and none depends on another's answer, which is the
 * condition for batching them. The typed `choice` is consumed directly; the
 * `confidence` decides whether the UI can proceed silently or must ask the user
 * to confirm.
 *
 * The deterministic `detectMapping` in `core/parse/schema.ts` stays the default.
 * This is a fallback for files the heuristic cannot read — which keeps the tool
 * working offline, keeps import latency at zero for known formats, and means a
 * model outage degrades to "the old behaviour", not "no import".
 *
 * ── Before enabling ────────────────────────────────────────────────────────
 * The API key must not reach the browser. ERAS is a client-only app served by
 * nginx inside the FinnGen sandbox, so `TYPESAFE_ENDPOINT` has to point at a
 * small proxy that holds the key server-side. Note also that column *names* and
 * sample *values* leave the machine when this runs — inside a sandbox holding
 * patient data that is a governance decision, not a technical one. Hence the
 * explicit opt-in below rather than a silent default.
 */

export interface AssistedMapperConfig {
  /** Server-side proxy that injects the TypeSafe key. No key in the client. */
  readonly endpoint: string
  readonly signal?: AbortSignal
}

/** Mirrors the SDK's Choice answer shape. */
interface ChoiceAnswer {
  readonly type: "choice"
  readonly choice: string
  readonly confidence: number
  readonly probabilities: Readonly<Record<string, number>>
}

interface SystemOneResponse {
  readonly answers: Readonly<Record<string, ChoiceAnswer>>
}

const NONE = "__none__"

const ROLE_INSTRUCTIONS: Record<(typeof COLUMN_ROLES)[number], string> = {
  patientId:
    "Which column holds the identifier of the person the row belongs to? " +
    "The same identifier repeats across the rows that describe one person's history.",
  state:
    "Which column holds the clinical state, stage or event label of the row? " +
    "It is a categorical label that repeats across many people.",
  age: "Which column holds the person's age at the moment of this row's event, as a number of years?",
  date: "Which column holds the calendar date or year of this row's event?",
  diseaseDuration:
    "Which column holds a total duration for the whole person, identical on every row for that person " +
    "— not the gap between two consecutive events?",
}

/**
 * Builds the request body. Kept separate and exported so it is testable without
 * a network call, and so the proxy contract is visible in one place.
 */
export function buildMappingRequest(sample: HeaderSample): unknown {
  // Criteria are the actual column names: the model selects from what exists,
  // rather than generating a name that might not be in the file.
  const criteria: Record<string, string> = {}
  for (const header of sample.headers) {
    const values = sample.rows
      .slice(0, 3)
      .map((row) => row[sample.headers.indexOf(header)] ?? "")
      .filter((v) => v !== "")
    criteria[header] = `Column "${header}". Example values: ${values.join(", ") || "(empty)"}`
  }
  criteria[NONE] = "No column in this file serves this purpose."

  return {
    state: {
      headers: sample.headers,
      sample_rows: sample.rows.slice(0, 8),
      table_description:
        "A long-format clinical event table: one row per event, several rows per person, " +
        "describing how people move through a sequence of states over time.",
    },
    questions: Object.fromEntries(
      COLUMN_ROLES.map((role) => [
        role,
        { type: "choice", instructions: ROLE_INSTRUCTIONS[role], criteria },
      ]),
    ),
  }
}

/**
 * Asks the proxy for a mapping, falling back to the heuristic on any failure.
 * Never throws: a broken assist must not break import.
 */
export async function assistedMapping(
  sample: HeaderSample,
  config: AssistedMapperConfig,
): Promise<MappingCandidate | null> {
  try {
    const init: RequestInit = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(buildMappingRequest(sample)),
    }
    if (config.signal !== undefined) init.signal = config.signal

    const response = await fetch(config.endpoint, init)
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)

    return toCandidate((await response.json()) as SystemOneResponse, sample)
  } catch (error) {
    console.warn("Assisted column mapping unavailable, using heuristic:", error)
    return detectMapping(sample)
  }
}

function toCandidate(response: SystemOneResponse, sample: HeaderSample): MappingCandidate | null {
  const pick = (role: (typeof COLUMN_ROLES)[number]): { column: string | null; score: number } => {
    const answer = response.answers[role]
    if (answer === undefined || answer.choice === NONE) return { column: null, score: 0 }
    // Guard against a hallucinated name: only accept a header that exists.
    if (!sample.headers.includes(answer.choice)) return { column: null, score: 0 }
    return { column: answer.choice, score: answer.confidence }
  }

  const patientId = pick("patientId")
  const state = pick("state")
  if (patientId.column === null || state.column === null) return null

  const age = pick("age")
  const date = pick("date")
  const diseaseDuration = pick("diseaseDuration")

  const mapping: ColumnMapping = {
    patientId: patientId.column,
    state: state.column,
    age: age.column,
    date: date.column,
    diseaseDuration: diseaseDuration.column,
  }

  // The required roles dominate the reported confidence: a low-confidence guess
  // about an optional duration column should not make the whole mapping suspect.
  const confidence = (patientId.score + state.score) / 2

  const notes: string[] = []
  if (age.column === null && date.column === null) {
    notes.push("No age or date column identified — the time axis will be empty.")
  }

  return { mapping, confidence, source: "assisted", notes }
}
