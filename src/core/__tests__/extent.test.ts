import { describe, expect, it } from "vitest"

import { buildStore } from "../model/build.ts"
import { spliceStates } from "../model/reshape.ts"
import { applyFilters, emptyFilters } from "../query/filters.ts"
import { visibleExtent } from "../query/extent.ts"
import type { PatientRecord } from "../types.ts"

/** Patients arriving a decade apart, each spanning ten years. */
const cohort: PatientRecord[] = Array.from({ length: 5 }, (_, i) => ({
  id: `p_${i}`,
  trajectory: ["a", "b"],
  switchEventAge: [20 + i * 10, 30 + i * 10],
  years: [2000 + i * 10, 2010 + i * 10],
  diseaseDuration: 10,
}))

describe("visible extent", () => {
  it("spans every event of the given patients", () => {
    const store = buildStore(cohort)
    const all = Uint32Array.from({ length: store.patientCount }, (_, i) => i)

    expect(visibleExtent(store, all, "age")).toEqual([20, 70])
    expect(visibleExtent(store, all, "year")).toEqual([2000, 2050])
  })

  it("narrows to the filtered selection, which is the point", () => {
    const store = buildStore(cohort)

    // Keep only patients whose whole age span sits inside 35–65.
    const selection = applyFilters(store, { ...emptyFilters, age: { min: 35, max: 65 } })
    const extent = visibleExtent(store, selection.indices(), "age")

    // The dataset spans 20–70; what is left spans a third of that.
    expect(store.extents.age).toEqual([20, 70])
    expect(extent).toEqual([40, 60])
  })

  it("returns null when nothing is in view, so the caller keeps its scale", () => {
    const store = buildStore(cohort)
    expect(visibleExtent(store, new Uint32Array(), "age")).toBeNull()
  })

  it("widens a single point rather than collapsing the scale", () => {
    const store = buildStore([
      {
        id: "one",
        trajectory: ["a", "a"],
        switchEventAge: [40, 40],
        years: [2000, 2000],
        diseaseDuration: 0,
      },
    ])

    expect(visibleExtent(store, Uint32Array.of(0), "age")).toEqual([39.5, 40.5])
  })

  it("ignores patients a splice emptied", () => {
    const store = buildStore([
      ...cohort,
      {
        id: "outlier",
        trajectory: ["z"],
        switchEventAge: [99],
        years: [2099],
        diseaseDuration: 0,
      },
    ])

    const all = Uint32Array.from({ length: store.patientCount }, (_, i) => i)
    expect(visibleExtent(store, all, "age")).toEqual([20, 99])

    const mask = new Uint8Array(store.stateNames.length)
    mask[store.stateNames.indexOf("z")] = 1
    const spliced = spliceStates(store, mask)

    // The emptied row contributes no events, so it cannot hold the axis open.
    expect(visibleExtent(spliced, all, "age")).toEqual([20, 70])
  })
})
