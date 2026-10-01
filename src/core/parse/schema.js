/**
 * Column-role detection for long-format event tables.
 *
 * The original hard-coded `FINNGENID` (with a single `personSourceValue`
 * rename), `stage`, `age`, `date` and `disease_duration`. Any other header —
 * which is what real exports look like — silently produced an empty dataset.
 * Here the header is *mapped* to roles, and the mapping is an explicit value the
 * UI can show and the user can override.
 */
export const COLUMN_ROLES = ["patientId", "state", "age", "date", "diseaseDuration"];
const ALIASES = {
    patientId: ["finngenid", "personsourcevalue", "person_id", "patientid", "subjectid", "id", "eid"],
    state: ["stage", "state", "event", "status", "phase", "condition", "diagnosis", "node"],
    age: ["age", "ageatevent", "switcheventage", "age_at_event", "ageyears"],
    date: ["date", "year", "years", "eventdate", "event_date", "startdate", "timestamp"],
    diseaseDuration: ["disease_duration", "diseaseduration", "duration", "followup", "totalduration"],
};
const normalize = (h) => h.trim().toLowerCase().replace(/[\s_-]+/g, "");
function aliasScore(header, role) {
    const h = normalize(header);
    const aliases = ALIASES[role];
    for (let i = 0; i < aliases.length; i++) {
        const alias = aliases[i];
        // Earlier aliases are stronger signals, so decay down the list.
        if (h === alias)
            return 1 - i * 0.02;
        if (h.includes(alias))
            return 0.6 - i * 0.02;
    }
    return 0;
}
/** Fraction of sampled cells in a column that parse as finite numbers. */
function numericRatio(sample, columnIndex) {
    let seen = 0;
    let numeric = 0;
    for (const row of sample.rows) {
        const cell = row[columnIndex];
        if (cell === undefined || cell === "")
            continue;
        seen += 1;
        if (Number.isFinite(Number(cell)))
            numeric += 1;
    }
    return seen === 0 ? 0 : numeric / seen;
}
/** Fraction of distinct values — an id column is ~1, a state column is low. */
function distinctRatio(sample, columnIndex) {
    const seen = new Set();
    let count = 0;
    for (const row of sample.rows) {
        const cell = row[columnIndex];
        if (cell === undefined || cell === "")
            continue;
        seen.add(cell);
        count += 1;
    }
    return count === 0 ? 0 : seen.size / count;
}
function roleScore(sample, columnIndex, role) {
    const header = sample.headers[columnIndex];
    if (header === undefined)
        return 0;
    let score = aliasScore(header, role);
    if (score === 0)
        return 0;
    const numeric = numericRatio(sample, columnIndex);
    const distinct = distinctRatio(sample, columnIndex);
    // Value shape either corroborates the name or argues against it.
    switch (role) {
        case "age":
        case "diseaseDuration":
            score *= numeric > 0.8 ? 1 : 0.3;
            break;
        case "date":
            score *= numeric > 0.8 || /[-/]/.test(sample.rows[0]?.[columnIndex] ?? "") ? 1 : 0.4;
            break;
        case "state":
            // Many repeated values across rows: exactly what a state column looks like.
            score *= distinct < 0.6 ? 1 : 0.5;
            break;
        case "patientId":
            score *= distinct > 0.05 ? 1 : 0.5;
            break;
    }
    return score;
}
/**
 * Offline, deterministic mapping. This is the default path: no network, no
 * latency, and it covers every file shape the tool ships with.
 */
export function detectMapping(sample) {
    const notes = [];
    const taken = new Set();
    const pick = (role) => {
        let best = -1;
        let bestScore = 0;
        for (let i = 0; i < sample.headers.length; i++) {
            if (taken.has(i))
                continue;
            const score = roleScore(sample, i, role);
            if (score > bestScore) {
                bestScore = score;
                best = i;
            }
        }
        if (best === -1)
            return null;
        taken.add(best);
        return { header: sample.headers[best], score: bestScore };
    };
    // Required roles first so they win contested headers.
    const patientId = pick("patientId");
    const state = pick("state");
    if (!patientId || !state) {
        return null;
    }
    const age = pick("age");
    const date = pick("date");
    const diseaseDuration = pick("diseaseDuration");
    if (!age && !date)
        notes.push("No age or date column found — the time axis will be empty.");
    if (!diseaseDuration)
        notes.push("No disease-duration column; it will be derived from the dates.");
    const scores = [patientId.score, state.score, age?.score ?? 0.5, date?.score ?? 0.5];
    const confidence = scores.reduce((a, b) => a + b, 0) / scores.length;
    return {
        mapping: {
            patientId: patientId.header,
            state: state.header,
            age: age?.header ?? null,
            date: date?.header ?? null,
            diseaseDuration: diseaseDuration?.header ?? null,
        },
        confidence,
        source: "heuristic",
        notes,
    };
}
