import { describe, expect, it } from "vitest"

import { buildStore } from "../model/build.ts"
import { countLivePatients, spliceStates } from "../model/reshape.ts"
import { applyFilters, emptyFilters } from "../query/filters.ts"
import { buildStateStats } from "../render/boxplots.ts"
import { buildGeometry } from "../render/geometry.ts"
import { buildLumps } from "../render/lumps.ts"
import { buildPalette } from "../render/palette.ts"
import { summariseStates } from "../stats/states.ts"
import { buildTypologies } from "../stats/typologies.ts"
import type { PatientRecord, TrajectoryStore } from "../types.ts"

/** One patient walking a → b → c, ten years apart. */
const abc: PatientRecord[] = [
  {
    id: "p1",
    trajectory: ["a", "b", "c"],
    switchEventAge: [20, 30, 40],
    years: [2000, 2010, 2020],
    diseaseDuration: 20,
  },
]

const maskOf = (store: TrajectoryStore, ...names: string[]): Uint8Array => {
  const mask = new Uint8Array(store.stateNames.length)
  for (const name of names) mask[store.stateNames.indexOf(name)] = 1
  return mask
}

const geometryOf = (store: TrajectoryStore) =>
  buildGeometry(store, Uint32Array.of(0), {
    axis: "age",
    color: { kind: "state", palette: buildPalette(store.stateNames.length) },
  })

/** Each segment as `[sourceX, targetX]` in data space. */
const segments = (geometry: ReturnType<typeof buildGeometry>): [number, number][] =>
  Array.from({ length: geometry.segmentCount }, (_, i) => [
    geometry.positions[i * 4] as number,
    geometry.positions[i * 4 + 2] as number,
  ])

describe("splicing a state out of the store", () => {
  it("links across the gap instead of leaving loose ends", () => {
    const store = buildStore(abc)

    // a→b and b→c. The store's closing self link onto c is not drawn: it has
    // zero length, so neither backend rasterises it.
    expect(segments(geometryOf(store))).toEqual([
      [20, 30],
      [30, 40],
    ])

    const spliced = spliceStates(store, maskOf(store, "b"))
    expect(segments(geometryOf(spliced))).toEqual([[20, 40]])
  })

  it("recomputes durations across what was removed", () => {
    const store = buildStore(abc) // a→b and b→c are ten years each
    const spliced = spliceStates(store, maskOf(store, "b"))

    // The surviving a→c link spans the whole twenty years, and the extent
    // follows it — so the duration filter now judges the trajectory that exists.
    expect(spliced.durations[0]).toBeCloseTo(20)
    expect(spliced.extents.duration[1]).toBeCloseTo(20)
    expect(store.extents.duration[1]).toBeCloseTo(10)
  })

  it("rescales the axes to what is left", () => {
    const store = buildStore(abc)
    const spliced = spliceStates(store, maskOf(store, "c"))

    expect(store.extents.age).toEqual([20, 40])
    expect(spliced.extents.age).toEqual([20, 30])
    expect(spliced.extents.maxTrajectoryLength).toBe(2)
  })

  it("merges typologies that differed only by the removed state", () => {
    const store = buildStore([
      {
        id: "through_b",
        trajectory: ["a", "b", "c"],
        switchEventAge: [20, 30, 40],
        years: [2000, 2010, 2020],
        diseaseDuration: 20,
      },
      {
        id: "straight",
        trajectory: ["a", "c"],
        switchEventAge: [20, 40],
        years: [2000, 2020],
        diseaseDuration: 20,
      },
    ])

    // Two distinct paths to begin with.
    expect(buildTypologies(store).map((t) => t.key).sort()).toEqual(["a-b-c", "a-c"])

    // With `b` gone they are the same path — which is the thing a filter could
    // never do, and the reason this has to reshape the store.
    const merged = buildTypologies(spliceStates(store, maskOf(store, "b")))
    expect(merged).toHaveLength(1)
    expect(merged[0]!.key).toBe("a-c")
    expect(merged[0]!.size).toBe(2)
  })

  it("drops the removed state's population without renumbering the others", () => {
    const store = buildStore(abc)
    const spliced = spliceStates(store, maskOf(store, "b"))

    // The vocabulary is carried over whole, so ids and palette colours hold.
    expect(spliced.stateNames).toEqual(store.stateNames)

    const populations = summariseStates(spliced)
    const b = store.stateNames.indexOf("b")
    expect(populations[b]!.population).toBe(0)
    expect(populations[store.stateNames.indexOf("a")]!.population).toBe(1)
  })

  it("keeps patient indices stable, leaving emptied patients in place", () => {
    const store = buildStore([
      ...abc,
      {
        id: "only_b",
        trajectory: ["b"],
        switchEventAge: [25],
        years: [2005],
        diseaseDuration: 0,
      },
    ])

    const spliced = spliceStates(store, maskOf(store, "b"))

    // Row 1 is still `only_b` — everything in the app addresses patients by
    // index, so compacting would invalidate the selection, hover and typologies.
    expect(spliced.patientCount).toBe(store.patientCount)
    expect(spliced.ids.at(1)).toBe("only_b")
    expect(spliced.offsets[1]).toBe(spliced.offsets[2])

    // …but they are no longer visible, and no longer a typology of their own.
    expect(applyFilters(spliced, emptyFilters).count).toBe(1)
    expect(buildTypologies(spliced).map((t) => t.key)).toEqual(["a-c"])
  })

  it("collapses lumps across the removed state too", () => {
    const store = buildStore(abc)
    expect(buildLumps(store, Uint32Array.of(0), { axis: "age" })).toHaveLength(3)

    const spliced = spliceStates(store, maskOf(store, "b"))
    const names = buildLumps(spliced, Uint32Array.of(0), { axis: "age" }).map(
      (lump) => `${spliced.stateNames[lump.sourceState]}-${spliced.stateNames[lump.targetState]}`,
    )

    expect(names.sort()).toEqual(["a-c", "c-c"])
  })

  it("drops the removed state's row from the box plots", () => {
    const store = buildStore(abc)
    const spliced = spliceStates(store, maskOf(store, "b"))

    expect(buildStateStats(spliced, null, "age").map((s) => spliced.stateNames[s.state])).toEqual([
      "a",
      "c",
    ])
  })

  it("takes a patient out of the cohort when their whole path is removed", () => {
    // Three patients walk a→b; three only ever visit c.
    const store = buildStore([
      ...Array.from({ length: 3 }, (_, i) => ({
        id: `ab_${i}`,
        trajectory: ["a", "b"],
        switchEventAge: [20 + i, 30 + i],
        years: [2000 + i, 2010 + i],
        diseaseDuration: 10,
      })),
      ...Array.from({ length: 3 }, (_, i) => ({
        id: `c_${i}`,
        trajectory: ["c"],
        switchEventAge: [40 + i],
        years: [2020 + i],
        diseaseDuration: 5,
      })),
    ])

    expect(countLivePatients(store)).toBe(6)

    const spliced = spliceStates(store, maskOf(store, "c"))

    // The rows stay, so indices hold; the cohort halves.
    expect(spliced.patientCount).toBe(6)
    expect(countLivePatients(spliced)).toBe(3)
    expect(applyFilters(spliced, emptyFilters).count).toBe(3)
  })

  it("measures typology share against the cohort that is left", () => {
    const store = buildStore([
      ...Array.from({ length: 3 }, (_, i) => ({
        id: `ab_${i}`,
        trajectory: ["a", "b"],
        switchEventAge: [20 + i, 30 + i],
        years: [2000 + i, 2010 + i],
        diseaseDuration: 10,
      })),
      ...Array.from({ length: 3 }, (_, i) => ({
        id: `c_${i}`,
        trajectory: ["c"],
        switchEventAge: [40 + i],
        years: [2020 + i],
        diseaseDuration: 5,
      })),
    ])

    expect(buildTypologies(store).map((t) => t.share)).toEqual([0.5, 0.5])

    // `a-b` is now the whole cohort, not half of it. Dividing by the row count
    // would leave the shares summing to 50%.
    const after = buildTypologies(spliceStates(store, maskOf(store, "c")))
    expect(after).toHaveLength(1)
    expect(after[0]!.share).toBe(1)
    expect(after.reduce((sum, t) => sum + t.share, 0)).toBeCloseTo(1)
  })

  it("survives removing everything", () => {
    const store = buildStore(abc)
    const spliced = spliceStates(store, maskOf(store, "a", "b", "c"))

    expect(spliced.eventCount).toBe(0)
    expect(spliced.patientCount).toBe(store.patientCount)
    expect(buildTypologies(spliced)).toEqual([])
    expect(countLivePatients(spliced)).toBe(0)
    expect(applyFilters(spliced, emptyFilters).count).toBe(0)
    expect(geometryOf(spliced).segmentCount).toBe(0)
  })

  it("is an exact round trip when nothing is removed", () => {
    const store = buildStore(abc)
    const spliced = spliceStates(store, new Uint8Array(store.stateNames.length))

    expect(spliced.eventCount).toBe(store.eventCount)
    expect(Array.from(spliced.offsets)).toEqual(Array.from(store.offsets))
    expect(Array.from(spliced.stateIds)).toEqual(Array.from(store.stateIds))
    expect(Array.from(spliced.durations)).toEqual(Array.from(store.durations))
    expect(spliced.extents).toEqual(store.extents)
  })
})
