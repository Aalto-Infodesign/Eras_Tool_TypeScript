import { describe, expect, it } from "vitest"

import { buildStore } from "../model/build.ts"
import { spliceStates } from "../model/reshape.ts"
import { applyFilters, emptyFilters, FAILS, filterFailures, UNSELECTED } from "../query/filters.ts"
import { buildDistributions } from "../stats/distributions.ts"
import type { PatientRecord } from "../types.ts"

/** `n` patients whose calendar span starts at 2000+i and ends ten years later. */
function cohort(n: number): PatientRecord[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `p_${i}`,
    trajectory: ["a", "b"],
    switchEventAge: [20 + i, 30 + i],
    years: [2000 + i, 2010 + i],
    diseaseDuration: 10 + i,
  }))
}

const total = (counts: Uint32Array): number => counts.reduce((sum, c) => sum + c, 0)

describe("filter distributions", () => {
  it("gives a span filter two curves, one per handle", () => {
    const store = buildStore(cohort(20))
    const { year } = buildDistributions(store)

    // Every patient contributes once to each curve.
    expect(total(year.start.counts)).toBe(20)
    expect(total(year.end.counts)).toBe(20)

    // Starts run 2000..2019 and ends 2010..2029 over a 2000..2029 domain, so the
    // two curves are the same shape shifted along the axis.
    const first = (counts: Uint32Array): number => counts.findIndex((c) => c > 0)
    const last = (counts: Uint32Array): number => counts.length - 1 - [...counts].reverse().findIndex((c) => c > 0)

    expect(first(year.start.counts)).toBe(0)
    expect(last(year.end.counts)).toBe(year.end.counts.length - 1)
    expect(last(year.start.counts)).toBeLessThan(last(year.end.counts))
    expect(first(year.start.counts)).toBeLessThan(first(year.end.counts))
  })

  it("bins disease duration per patient and segment duration per link", () => {
    const store = buildStore(cohort(20))
    const { diseaseDuration, duration } = buildDistributions(store)

    expect(total(diseaseDuration.counts)).toBe(20)
    // Two events per patient is one real link each; the closing self-link is a
    // convention carrying a zero, not a measured duration.
    expect(total(duration.counts)).toBe(20)
  })

  it("survives a domain no wider than a single value", () => {
    const store = buildStore([
      {
        id: "flat",
        trajectory: ["a", "a"],
        switchEventAge: [40, 40],
        years: [2000, 2000],
        diseaseDuration: 0,
      },
    ])

    const { duration, diseaseDuration } = buildDistributions(store)
    expect(duration.max).toBe(0)
    expect(diseaseDuration.max).toBe(0)
  })

  it("follows a reshaped store rather than the ingested one", () => {
    const store = buildStore(cohort(4))
    const b = store.stateNames.indexOf("b")

    const mask = new Uint8Array(store.stateNames.length)
    mask[b] = 1
    const spliced = spliceStates(store, mask)

    // With `b` gone every patient is a single event: no links are left to bin.
    expect(total(buildDistributions(store).duration.counts)).toBe(4)
    expect(total(buildDistributions(spliced).duration.counts)).toBe(0)
    // …and the start and end of a one-event span are the same value.
    const { year } = buildDistributions(spliced)
    expect(Array.from(year.start.counts)).toEqual(Array.from(year.end.counts))
  })

  it("leaves emptied patients out of the patient-level histogram", () => {
    const store = buildStore([
      ...cohort(3),
      {
        id: "only_c",
        trajectory: ["c"],
        switchEventAge: [90],
        years: [2090],
        diseaseDuration: 99,
      },
    ])

    const mask = new Uint8Array(store.stateNames.length)
    mask[store.stateNames.indexOf("c")] = 1

    expect(total(buildDistributions(spliceStates(store, mask)).diseaseDuration.counts)).toBe(3)
  })
})

describe("inverting a filter", () => {
  it("keeps the complement of a range", () => {
    const store = buildStore(cohort(10)) // disease durations 10..19

    const inside = { ...emptyFilters, diseaseDuration: { min: 10, max: 14 } }
    expect(applyFilters(store, inside).count).toBe(5)

    const outside = { ...inside, inverted: { diseaseDuration: true } }
    expect(applyFilters(store, outside).count).toBe(5)

    // The two partitions are disjoint and cover everyone.
    const a = applyFilters(store, inside)
    const b = applyFilters(store, outside)
    for (let p = 0; p < store.patientCount; p++) {
      expect(a.has(p) === b.has(p)).toBe(false)
    }
  })

  it("inverts the segment-duration filter too, which it used not to", () => {
    const store = buildStore(cohort(10)) // every link spans ten years

    const matching = { ...emptyFilters, duration: { min: 9, max: 11 } }
    expect(applyFilters(store, matching).count).toBe(10)

    const inverted = { ...matching, inverted: { duration: true } }
    expect(applyFilters(store, inverted).count).toBe(0)
  })
})

describe("selection distributions", () => {
  it("records every range a patient fails, not just the first", () => {
    const store = buildStore(cohort(10)) // disease 10..19, years 2000+i..2010+i

    const filters = {
      ...emptyFilters,
      diseaseDuration: { min: 10, max: 14 },
      year: { min: 2000, max: 2012 },
    }
    const failures = filterFailures(store, filters, new Uint8Array(store.patientCount))

    expect(failures[0]).toBe(0)
    expect(failures[3]).toBe(FAILS.year) // disease 13 passes; span ends 2013
    expect(failures[7]).toBe(FAILS.diseaseDuration | FAILS.year)

    // Exactly the patients the mask keeps fail nothing.
    const mask = applyFilters(store, filters)
    for (let p = 0; p < store.patientCount; p++) {
      expect(failures[p] === 0).toBe(mask.has(p))
    }
  })

  it("lifts only each filter's own range from its histogram", () => {
    const store = buildStore(cohort(10))

    const filters = {
      ...emptyFilters,
      diseaseDuration: { min: 10, max: 14 }, // keeps patients 0..4
      year: { min: 2000, max: 2012 }, // keeps patients 0..2
    }
    const failures = filterFailures(store, filters, new Uint8Array(store.patientCount))
    const subset = buildDistributions(store, failures)

    // Disease duration ignores its own cut but not the year's.
    expect(total(subset.diseaseDuration.counts)).toBe(3)
    // Year ignores its own cut but not disease duration's.
    expect(total(subset.year.start.counts)).toBe(5)
    // Unfiltered dimensions see everyone both cuts keep.
    expect(total(subset.age.start.counts)).toBe(3)
    expect(total(subset.duration.counts)).toBe(3)
  })

  it("narrows every curve to the chosen patients", () => {
    const store = buildStore(cohort(10))
    const failures = filterFailures(store, emptyFilters, new Uint8Array(store.patientCount))
    for (let p = 4; p < 10; p++) failures[p] = (failures[p] as number) | UNSELECTED

    const subset = buildDistributions(store, failures)
    expect(total(subset.diseaseDuration.counts)).toBe(4)
    expect(total(subset.year.end.counts)).toBe(4)
    expect(total(subset.duration.counts)).toBe(4)
  })
})
