import { describe, expect, it } from "vitest"

import { buildStore } from "../model/build.ts"
import { buildStateStats } from "../render/boxplots.ts"
import { quantile } from "../render/ribbons.ts"
import type { PatientRecord } from "../types.ts"

/** `n` patients reaching a, b, c at ages `20+i`, `30+i`, `40+i`. */
function ladder(n: number): PatientRecord[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `p_${i}`,
    trajectory: ["a", "b", "c"],
    switchEventAge: [20 + i, 30 + i, 40 + i],
    years: [2000 + i, 2010 + i, 2020 + i],
    diseaseDuration: 20,
  }))
}

const byName = (store: ReturnType<typeof buildStore>, name: string): number =>
  store.stateNames.indexOf(name)

describe("state box plot stats", () => {
  it("summarises arrival time per state", () => {
    const store = buildStore(ladder(9)) // ages 20..28, 30..38, 40..48
    const stats = buildStateStats(store, null, "age")

    expect(stats).toHaveLength(3)

    const a = stats.find((s) => s.state === byName(store, "a"))!
    expect(a.count).toBe(9)
    expect(a.min).toBeCloseTo(20)
    expect(a.q1).toBeCloseTo(22)
    expect(a.median).toBeCloseTo(24)
    expect(a.q3).toBeCloseTo(26)
    expect(a.max).toBeCloseTo(28)

    const c = stats.find((s) => s.state === byName(store, "c"))!
    expect(c.median).toBeCloseTo(44)
  })

  it("reads the calendar axis from the same events", () => {
    const store = buildStore(ladder(9))
    const stats = buildStateStats(store, null, "year")

    const a = stats.find((s) => s.state === byName(store, "a"))!
    expect(a.min).toBeCloseTo(2000)
    expect(a.median).toBeCloseTo(2004)
    expect(a.max).toBeCloseTo(2008)
  })

  it("counts visits, not patients, so a revisited state is weighted twice", () => {
    const store = buildStore([
      {
        id: "loop",
        trajectory: ["a", "b", "a"],
        switchEventAge: [10, 20, 30],
        years: [2000, 2010, 2020],
        diseaseDuration: 20,
      },
    ])

    const stats = buildStateStats(store, null, "age")
    const a = stats.find((s) => s.state === byName(store, "a"))!

    expect(a.count).toBe(2)
    expect(a.min).toBeCloseTo(10)
    expect(a.max).toBeCloseTo(30)
    expect(a.median).toBeCloseTo(20)
  })

  it("restricts to the visible mask", () => {
    const store = buildStore(ladder(9))

    const visible = new Uint8Array(store.patientCount)
    for (let p = 0; p < 3; p++) visible[p] = 1 // ages 20, 21, 22 at state a

    const stats = buildStateStats(store, visible, "age")
    const a = stats.find((s) => s.state === byName(store, "a"))!

    expect(a.count).toBe(3)
    expect(a.min).toBeCloseTo(20)
    expect(a.median).toBeCloseTo(21)
    expect(a.max).toBeCloseTo(22)
  })

  it("omits a state no visible patient reaches", () => {
    const store = buildStore([
      ...ladder(2),
      {
        id: "only_d",
        trajectory: ["d"],
        switchEventAge: [50],
        years: [2050],
        diseaseDuration: 0,
      },
    ])

    const visible = new Uint8Array(store.patientCount)
    visible[store.patientCount - 1] = 1 // the `d` patient alone

    const stats = buildStateStats(store, visible, "age")
    expect(stats.map((s) => store.stateNames[s.state])).toEqual(["d"])
  })

  it("keeps the extremes exact however coarse the buckets are", () => {
    const store = buildStore(ladder(500)) // state `a` spans ages 20..519

    // Sixteen buckets over the whole axis: far coarser than anything real.
    const coarse = buildStateStats(store, null, "age", 16)
    const a = coarse.find((s) => s.state === byName(store, "a"))!

    expect(a.count).toBe(500)
    expect(a.min).toBe(20)
    expect(a.max).toBe(519)
    // Quantiles degrade with the bucket width, but never leave the bar.
    expect(a.median).toBeGreaterThanOrEqual(a.min)
    expect(a.median).toBeLessThanOrEqual(a.max)
  })

  it("tracks the true quantiles at the real bucket resolution", () => {
    const store = buildStore(ladder(500))
    const a = buildStateStats(store, null, "age").find((s) => s.state === byName(store, "a"))!

    // Ages 20..519: the exact interpolated quartiles of an arithmetic run.
    expect(a.q1).toBeCloseTo(144.75, 1)
    expect(a.median).toBeCloseTo(269.5, 1)
    expect(a.q3).toBeCloseTo(394.25, 1)
  })

  it("agrees with the ribbons' quantile, so the two layers report one median", () => {
    const store = buildStore(ladder(9))
    const stats = buildStateStats(store, null, "age")

    // The same nine arrival ages the ribbon builder would summarise for state `a`.
    const ages = Float64Array.from({ length: 9 }, (_, i) => 20 + i)

    const a = stats.find((s) => s.state === byName(store, "a"))!
    expect(a.q1).toBeCloseTo(quantile(ages, 0.25), 1)
    expect(a.median).toBeCloseTo(quantile(ages, 0.5), 1)
    expect(a.q3).toBeCloseTo(quantile(ages, 0.75), 1)
  })

  it("returns nothing for an empty selection", () => {
    const store = buildStore(ladder(4))
    expect(buildStateStats(store, new Uint8Array(store.patientCount), "age")).toEqual([])
  })
})
