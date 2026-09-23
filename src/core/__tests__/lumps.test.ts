import { describe, expect, it } from "vitest"

import { buildStore } from "../model/build.ts"
import { buildLumps, type Lump } from "../render/lumps.ts"
import type { PatientRecord } from "../types.ts"

const allPatients = (count: number): Uint32Array =>
  Uint32Array.from({ length: count }, (_, i) => i)

const find = (
  lumps: readonly Lump[],
  store: ReturnType<typeof buildStore>,
  source: string,
  target: string,
): Lump | undefined =>
  lumps.find(
    (lump) =>
      store.stateNames[lump.sourceState] === source &&
      store.stateNames[lump.targetState] === target,
  )

describe("lumps", () => {
  it("collapses every transition of a state pair into one extent", () => {
    const store = buildStore([
      {
        id: "p1",
        trajectory: ["a", "b"],
        switchEventAge: [20, 40],
        years: [2000, 2020],
        diseaseDuration: 20,
      },
      {
        id: "p2",
        trajectory: ["a", "b"],
        switchEventAge: [30, 50],
        years: [2010, 2030],
        diseaseDuration: 20,
      },
    ])

    const lumps = buildLumps(store, allPatients(store.patientCount), { axis: "age" })
    const ab = find(lumps, store, "a", "b")!

    expect(ab.count).toBe(2)
    // The source edge spans both departures, the target edge both arrivals.
    expect(ab.sourceMin).toBe(20)
    expect(ab.sourceMax).toBe(30)
    expect(ab.targetMin).toBe(40)
    expect(ab.targetMax).toBe(50)
  })

  it("keeps a→b and b→a apart", () => {
    const store = buildStore([
      {
        id: "there_and_back",
        trajectory: ["a", "b", "a"],
        switchEventAge: [10, 20, 30],
        years: [2000, 2010, 2020],
        diseaseDuration: 20,
      },
    ])

    const lumps = buildLumps(store, allPatients(store.patientCount), { axis: "age" })

    expect(find(lumps, store, "a", "b")!.count).toBe(1)
    expect(find(lumps, store, "b", "a")!.count).toBe(1)
    expect(find(lumps, store, "a", "b")!.sourceMin).toBe(10)
    expect(find(lumps, store, "b", "a")!.sourceMin).toBe(20)
  })

  it("turns a patient's last event into a self lump on one row", () => {
    const store = buildStore([
      {
        id: "p1",
        trajectory: ["a", "b"],
        switchEventAge: [20, 40],
        years: [2000, 2020],
        diseaseDuration: 20,
      },
    ])

    const lumps = buildLumps(store, allPatients(store.patientCount), { axis: "age" })
    const bb = find(lumps, store, "b", "b")!

    // Source and target are the same state *and* the same x, which is what makes
    // it draw as a flat band lying on the row rather than a sloped quad.
    expect(bb.count).toBe(1)
    expect(bb.sourceMin).toBe(40)
    expect(bb.targetMax).toBe(40)
  })

  it("is bounded by the vocabulary, not by the patient count", () => {
    const many: PatientRecord[] = Array.from({ length: 400 }, (_, i) => ({
      id: `p_${i}`,
      trajectory: ["a", "b", "c"],
      switchEventAge: [20 + i, 30 + i, 40 + i],
      years: [2000 + i, 2010 + i, 2020 + i],
      diseaseDuration: 20,
    }))

    const store = buildStore(many)
    const lumps = buildLumps(store, allPatients(store.patientCount), { axis: "age" })

    // a→b, b→c and the c→c self link: three, from 1,200 events.
    expect(lumps).toHaveLength(3)
    expect(lumps.every((lump) => lump.count === 400)).toBe(true)
    // Ranked biggest first so heavy transitions paint underneath.
    expect(lumps.map((l) => l.count)).toEqual([...lumps.map((l) => l.count)].sort((a, b) => b - a))
  })

  it("reads the calendar axis from the same links", () => {
    const store = buildStore([
      {
        id: "p1",
        trajectory: ["a", "b"],
        switchEventAge: [20, 40],
        years: [2000, 2020],
        diseaseDuration: 20,
      },
    ])

    const lumps = buildLumps(store, allPatients(store.patientCount), { axis: "year" })
    const ab = find(lumps, store, "a", "b")!

    expect(ab.sourceMin).toBe(2000)
    expect(ab.targetMin).toBe(2020)
  })

  it("drops links outside the duration filter, but never a self link", () => {
    const store = buildStore([
      {
        id: "slow",
        trajectory: ["a", "b"],
        switchEventAge: [20, 60],
        years: [2000, 2040], // a 40-year transition
        diseaseDuration: 40,
      },
    ])

    const lumps = buildLumps(store, allPatients(store.patientCount), {
      axis: "age",
      durationRange: { min: 0, max: 5 },
    })

    expect(find(lumps, store, "a", "b")).toBeUndefined()
    // The closing self link carries no duration, so the filter cannot judge it.
    expect(find(lumps, store, "b", "b")!.count).toBe(1)
  })

  it("only counts the patients it is given", () => {
    const store = buildStore([
      {
        id: "p1",
        trajectory: ["a", "b"],
        switchEventAge: [20, 40],
        years: [2000, 2020],
        diseaseDuration: 20,
      },
      {
        id: "p2",
        trajectory: ["a", "b"],
        switchEventAge: [30, 90],
        years: [2010, 2070],
        diseaseDuration: 60,
      },
    ])

    const lumps = buildLumps(store, Uint32Array.of(0), { axis: "age" })
    const ab = find(lumps, store, "a", "b")!

    expect(ab.count).toBe(1)
    expect(ab.targetMax).toBe(40) // p2's late arrival is not in view
  })

  it("returns nothing for an empty selection", () => {
    const store = buildStore([
      {
        id: "p1",
        trajectory: ["a"],
        switchEventAge: [20],
        years: [2000],
        diseaseDuration: 0,
      },
    ])

    expect(buildLumps(store, new Uint32Array(), { axis: "age" })).toEqual([])
  })
})
