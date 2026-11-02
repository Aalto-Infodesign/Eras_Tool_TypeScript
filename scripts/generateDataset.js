/**
 * Synthetic datasets for the performance work.
 *
 * The largest file in the original repo is 25k patients (8 MB). The lag the tool
 * actually suffers from shows up an order of magnitude above that, so the
 * benchmarks need something to push against.
 *
 *   npm run gen:data -- --patients 250000 --out public/data/generated/data_250k.json
 *   npm run gen:data -- --patients 250000 --format tsv
 *   npm run gen:data -- --patients 1000000 --states 3 --min 2 --max 5 --distinct \
 *     --out public/data/generated/data_1m.json
 *
 * `--distinct` never repeats the previous state. With a handful of states the
 * walk otherwise runs off the end and sticks there — at three states, most
 * sequences came out as the last state over and over.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
function parseArgs(argv) {
    const get = (flag) => {
        const index = argv.indexOf(`--${flag}`);
        return index === -1 ? undefined : argv[index + 1];
    };
    const patients = Number(get("patients") ?? 250_000);
    const format = (get("format") ?? "json") === "tsv" ? "tsv" : "json";
    const label = patients >= 1000 ? `${Math.round(patients / 1000)}k` : String(patients);
    return {
        patients,
        states: Number(get("states") ?? 8),
        minLength: Number(get("min") ?? 3),
        maxLength: Number(get("max") ?? 8),
        distinct: argv.includes("--distinct"),
        format,
        out: get("out") ?? `public/data/generated/data_${label}.${format}`,
    };
}
/** Deterministic PRNG so two runs of the benchmark see the same data. */
function mulberry32(seed) {
    let a = seed;
    return () => {
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
const STATE_NAMES = [
    "healthy",
    "at_risk",
    "diagnosed",
    "treatment",
    "remission",
    "relapse",
    "comorbidity",
    "palliative",
    "recovered",
    "deceased",
];
function main() {
    const options = parseArgs(process.argv.slice(2));
    const random = mulberry32(42);
    const states = STATE_NAMES.slice(0, Math.min(options.states, STATE_NAMES.length));
    const chunks = [];
    if (options.format === "json")
        chunks.push("[");
    else
        chunks.push("FINNGENID\tstage\tage\tdate\tdisease_duration\n");
    for (let p = 0; p < options.patients; p++) {
        const length = options.minLength + Math.floor(random() * (options.maxLength - options.minLength + 1));
        // A biased walk: most patients follow the canonical order, a minority skip
        // or repeat states. That gives a realistic long tail of typologies rather
        // than a handful of identical sequences.
        const trajectory = [];
        let cursor = 0;
        let previous = -1;
        for (let k = 0; k < length; k++) {
            if (random() < 0.15 && cursor > 0)
                cursor -= 1;
            else if (random() < 0.25)
                cursor += 2;
            else
                cursor += 1;
            let index = Math.min(cursor, states.length - 1);
            // Landed on the state it is already in — clamped at the end, usually:
            // switch to any other one instead, and carry on the walk from there.
            if (options.distinct && index === previous && states.length > 1) {
                index = (index + 1 + Math.floor(random() * (states.length - 1))) % states.length;
                cursor = index;
            }
            previous = index;
            trajectory.push(states[index]);
        }
        let age = 18 + random() * 30;
        const birthYear = 1935 + Math.floor(random() * 50);
        const ages = [];
        const years = [];
        for (let k = 0; k < trajectory.length; k++) {
            age += random() * 9;
            ages.push(Number(age.toFixed(4)));
            years.push(Number((birthYear + age).toFixed(4)));
        }
        const duration = Number(((years.at(-1) ?? 0) - (years[0] ?? 0)).toFixed(4));
        const id = `MOCKID_${p}`;
        if (options.format === "json") {
            chunks.push(`${p === 0 ? "" : ","}\n${JSON.stringify({
                FINNGENID: id,
                trajectory,
                SwitchEventAge: ages,
                years,
                diseaseDuration: duration,
            })}`);
        }
        else {
            for (let k = 0; k < trajectory.length; k++) {
                chunks.push(`${id}\t${trajectory[k]}\t${ages[k]}\t${years[k]}\t${duration}\n`);
            }
        }
    }
    if (options.format === "json")
        chunks.push("\n]\n");
    mkdirSync(dirname(options.out), { recursive: true });
    const text = chunks.join("");
    writeFileSync(options.out, text);
    const events = text.length;
    console.log(`${options.out} — ${options.patients.toLocaleString()} patients, ` +
        `${(events / 1024 / 1024).toFixed(1)} MB`);
}
main();
