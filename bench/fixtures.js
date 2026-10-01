const STATES = [
    "healthy",
    "at_risk",
    "diagnosed",
    "treatment",
    "remission",
    "relapse",
    "comorbidity",
    "palliative",
];
/** Deterministic PRNG — benchmark runs must be comparable across commits. */
function mulberry32(seed) {
    let a = seed;
    return () => {
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
export function makeRecords(count, seed = 42) {
    const random = mulberry32(seed);
    const records = new Array(count);
    for (let p = 0; p < count; p++) {
        const length = 3 + Math.floor(random() * 6);
        const trajectory = new Array(length);
        const ages = new Array(length);
        const years = new Array(length);
        let cursor = 0;
        let age = 18 + random() * 30;
        const birthYear = 1935 + Math.floor(random() * 50);
        for (let k = 0; k < length; k++) {
            if (random() < 0.15 && cursor > 0)
                cursor -= 1;
            else
                cursor += random() < 0.25 ? 2 : 1;
            trajectory[k] = STATES[Math.min(cursor, STATES.length - 1)];
            age += random() * 9;
            ages[k] = age;
            years[k] = birthYear + age;
        }
        records[p] = {
            id: `MOCKID_${p}`,
            trajectory,
            switchEventAge: ages,
            years,
            diseaseDuration: years[length - 1] - years[0],
        };
    }
    return records;
}
export function makeTsv(records) {
    const lines = ["FINNGENID\tstage\tage\tdate\tdisease_duration"];
    for (const record of records) {
        for (let k = 0; k < record.trajectory.length; k++) {
            lines.push(`${record.id}\t${record.trajectory[k]}\t${record.switchEventAge[k]}\t` +
                `${record.years[k]}\t${record.diseaseDuration}`);
        }
    }
    return lines.join("\n");
}
