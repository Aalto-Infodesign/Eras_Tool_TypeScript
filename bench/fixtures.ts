import type { PatientRecord } from "../src/core/types.ts"

const STATES = [
  "healthy",
  "at_risk",
  "diagnosed",
  "treatment",
  "remission",
  "relapse",
  "comorbidity",
  "palliative",
] as const

/** Deterministic PRNG — benchmark runs must be comparable across commits. */
function mulberry32(seed: number): () => number {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function makeRecords(count: number, seed = 42): PatientRecord[] {
  const random = mulberry32(seed)
  const records: PatientRecord[] = new Array<PatientRecord>(count)

  for (let p = 0; p < count; p++) {
    const length = 3 + Math.floor(random() * 6)
    const trajectory: string[] = new Array<string>(length)
    const ages: number[] = new Array<number>(length)
    const years: number[] = new Array<number>(length)

    let cursor = 0
    let age = 18 + random() * 30
    const birthYear = 1935 + Math.floor(random() * 50)

    for (let k = 0; k < length; k++) {
      if (random() < 0.15 && cursor > 0) cursor -= 1
      else cursor += random() < 0.25 ? 2 : 1

      trajectory[k] = STATES[Math.min(cursor, STATES.length - 1)] as string
      age += random() * 9
      ages[k] = age
      years[k] = birthYear + age
    }

    records[p] = {
      id: `MOCKID_${p}`,
      trajectory,
      switchEventAge: ages,
      years,
      diseaseDuration: (years[length - 1] as number) - (years[0] as number),
    }
  }

  return records
}

export function makeTsv(records: readonly PatientRecord[]): string {
  const lines: string[] = ["FINNGENID\tstage\tage\tdate\tdisease_duration"]
  for (const record of records) {
    for (let k = 0; k < record.trajectory.length; k++) {
      lines.push(
        `${record.id}\t${record.trajectory[k]}\t${record.switchEventAge[k]}\t` +
          `${record.years[k]}\t${record.diseaseDuration}`,
      )
    }
  }
  return lines.join("\n")
}
