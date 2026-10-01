/**
 * Groups patients by identical ordered state sequence (the "silhouettes").
 *
 * The original built the key with `trajectory.join("-")` for every patient, then
 * `d3.groups` over those strings — one string allocation per patient plus full
 * string hashing and comparison on every lookup. Here the key is a 32-bit FNV-1a
 * hash over the interned state ids; buckets hold the few patients that collide
 * and are disambiguated by comparing the id runs directly.
 */
export function buildTypologies(store) {
    const { patientCount, offsets, stateIds } = store;
    // Patients with at least one event. A splice can empty a trajectory without
    // removing its row, and those patients are no longer part of the cohort — so
    // they must not sit in the denominator of everyone else's share either.
    let cohort = 0;
    // hash → indices of the representative patients of each group under that hash
    const buckets = new Map();
    // group index → first patient in it (its canonical sequence)
    const representatives = [];
    const members = [];
    for (let p = 0; p < patientCount; p++) {
        const start = offsets[p];
        const end = offsets[p + 1];
        // A splice can empty a trajectory without removing its row (patient indices
        // are stable by design). Such a patient has no sequence to group by, and
        // grouping them anyway would invent one huge typology keyed on "".
        if (end === start)
            continue;
        cohort += 1;
        let hash = 0x811c9dc5;
        for (let e = start; e < end; e++) {
            hash ^= stateIds[e];
            hash = Math.imul(hash, 0x01000193);
        }
        hash >>>= 0;
        let bucket = buckets.get(hash);
        if (bucket === undefined) {
            bucket = [];
            buckets.set(hash, bucket);
        }
        let groupIndex = -1;
        for (const candidate of bucket) {
            if (sameSequence(store, representatives[candidate], p)) {
                groupIndex = candidate;
                break;
            }
        }
        if (groupIndex === -1) {
            groupIndex = representatives.length;
            representatives.push(p);
            members.push([p]);
            bucket.push(groupIndex);
        }
        else {
            ;
            members[groupIndex].push(p);
        }
    }
    const typologies = representatives.map((rep, g) => {
        const start = offsets[rep];
        const end = offsets[rep + 1];
        const states = stateIds.slice(start, end);
        const patients = Uint32Array.from(members[g]);
        return {
            key: Array.from(states, (s) => store.stateNames[s] ?? String(s)).join("-"),
            states,
            patients,
            size: patients.length,
            share: cohort === 0 ? 0 : patients.length / cohort,
        };
    });
    typologies.sort((a, b) => b.size - a.size);
    return typologies;
}
function sameSequence(store, a, b) {
    const aStart = store.offsets[a];
    const aEnd = store.offsets[a + 1];
    const bStart = store.offsets[b];
    const bEnd = store.offsets[b + 1];
    if (aEnd - aStart !== bEnd - bStart)
        return false;
    for (let i = 0; i < aEnd - aStart; i++) {
        if (store.stateIds[aStart + i] !== store.stateIds[bStart + i])
            return false;
    }
    return true;
}
