import { COLUMN_ROLES, detectMapping } from "../core/parse/schema.ts";
const NONE = "__none__";
const ROLE_INSTRUCTIONS = {
    patientId: "Which column holds the identifier of the person the row belongs to? " +
        "The same identifier repeats across the rows that describe one person's history.",
    state: "Which column holds the clinical state, stage or event label of the row? " +
        "It is a categorical label that repeats across many people.",
    age: "Which column holds the person's age at the moment of this row's event, as a number of years?",
    date: "Which column holds the calendar date or year of this row's event?",
    diseaseDuration: "Which column holds a total duration for the whole person, identical on every row for that person " +
        "— not the gap between two consecutive events?",
};
/**
 * Builds the request body. Kept separate and exported so it is testable without
 * a network call, and so the proxy contract is visible in one place.
 */
export function buildMappingRequest(sample) {
    // Criteria are the actual column names: the model selects from what exists,
    // rather than generating a name that might not be in the file.
    const criteria = {};
    for (const header of sample.headers) {
        const values = sample.rows
            .slice(0, 3)
            .map((row) => row[sample.headers.indexOf(header)] ?? "")
            .filter((v) => v !== "");
        criteria[header] = `Column "${header}". Example values: ${values.join(", ") || "(empty)"}`;
    }
    criteria[NONE] = "No column in this file serves this purpose.";
    return {
        state: {
            headers: sample.headers,
            sample_rows: sample.rows.slice(0, 8),
            table_description: "A long-format clinical event table: one row per event, several rows per person, " +
                "describing how people move through a sequence of states over time.",
        },
        questions: Object.fromEntries(COLUMN_ROLES.map((role) => [
            role,
            { type: "choice", instructions: ROLE_INSTRUCTIONS[role], criteria },
        ])),
    };
}
/**
 * Asks the proxy for a mapping, falling back to the heuristic on any failure.
 * Never throws: a broken assist must not break import.
 */
export async function assistedMapping(sample, config) {
    try {
        const init = {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(buildMappingRequest(sample)),
        };
        if (config.signal !== undefined)
            init.signal = config.signal;
        const response = await fetch(config.endpoint, init);
        if (!response.ok)
            throw new Error(`${response.status} ${response.statusText}`);
        return toCandidate((await response.json()), sample);
    }
    catch (error) {
        console.warn("Assisted column mapping unavailable, using heuristic:", error);
        return detectMapping(sample);
    }
}
function toCandidate(response, sample) {
    const pick = (role) => {
        const answer = response.answers[role];
        if (answer === undefined || answer.choice === NONE)
            return { column: null, score: 0 };
        // Guard against a hallucinated name: only accept a header that exists.
        if (!sample.headers.includes(answer.choice))
            return { column: null, score: 0 };
        return { column: answer.choice, score: answer.confidence };
    };
    const patientId = pick("patientId");
    const state = pick("state");
    if (patientId.column === null || state.column === null)
        return null;
    const age = pick("age");
    const date = pick("date");
    const diseaseDuration = pick("diseaseDuration");
    const mapping = {
        patientId: patientId.column,
        state: state.column,
        age: age.column,
        date: date.column,
        diseaseDuration: diseaseDuration.column,
    };
    // The required roles dominate the reported confidence: a low-confidence guess
    // about an optional duration column should not make the whole mapping suspect.
    const confidence = (patientId.score + state.score) / 2;
    const notes = [];
    if (age.column === null && date.column === null) {
        notes.push("No age or date column identified — the time axis will be empty.");
    }
    return { mapping, confidence, source: "assisted", notes };
}
