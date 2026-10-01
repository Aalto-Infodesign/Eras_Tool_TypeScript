import { buildStore } from "../model/build.ts";
import { Stopwatch } from "../util/time.ts";
import { readDelimitedRows } from "./delimited.ts";
import { jsonToRecords } from "./json.ts";
import { detectMapping } from "./schema.ts";
import { rowsToRecords } from "./toRecords.ts";
/** Extension is a hint; the first non-whitespace byte is the decider. */
export function detectFormat(text, fileName) {
    if (fileName !== undefined && /\.(tsv|csv|txt)$/i.test(fileName))
        return "delimited";
    if (fileName !== undefined && /\.json$/i.test(fileName))
        return "json";
    const head = text.slice(0, 256).trimStart();
    return head.startsWith("[") || head.startsWith("{") ? "json" : "delimited";
}
const SAMPLE_ROWS = 50;
export function ingest(text, fileName, options = {}) {
    const clock = new Stopwatch();
    const format = options.format ?? detectFormat(text, fileName);
    let records;
    let mapping = null;
    if (format === "json") {
        const parsed = clock.measure("JSON.parse", () => JSON.parse(text));
        records = clock.measure("normalise", () => jsonToRecords(parsed));
    }
    else {
        const rows = clock.measure("tokenise", () => readDelimitedRows(text));
        const [headers = [], ...body] = rows;
        const candidate = clock.measure("detect columns", () => {
            const override = options.mapping;
            if (override !== undefined) {
                return { mapping: override, confidence: 1, source: "manual", notes: [] };
            }
            return detectMapping({ headers, rows: body.slice(0, SAMPLE_ROWS) });
        });
        if (candidate === null) {
            throw new Error(`Could not identify a patient-id and a state column in: ${headers.join(", ")}`);
        }
        mapping = candidate;
        records = clock.measure("group rows", () => rowsToRecords(body, headers, candidate.mapping));
    }
    const store = clock.measure("build store", () => buildStore(records));
    return { store, mapping, format, timings: clock.timings };
}
