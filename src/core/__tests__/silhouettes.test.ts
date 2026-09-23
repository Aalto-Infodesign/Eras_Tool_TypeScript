import { describe, expect, it } from "vitest"

import { buildStore } from "../model/build.ts"
import {
  filteredSizes,
  orderFromTypology,
  typologyIds,
  uniqueStates,
} from "../stats/silhouettes.ts"
import { buildTypologies } from "../stats/typologies.ts"
import type { PatientRecord } from "../types.ts"

const patient = (id: string, trajectory: readonly string[]): PatientRecord => ({
  id,
  trajectory,
  switchEventAge: trajectory.map((_, i) => 20 + i * 10),
  years: trajectory.map((_, i) => 2000 + i * 10),
  diseaseDuration: trajectory.length * 10,
})

describe("uniqueStates", () => {
  it("keeps first appearance order and drops repeats", () => {
    expect(uniqueStates(Uint16Array.of(2, 0, 2, 1, 0))).toEqual([2, 0, 1])
  })
})

describe("orderFromTypology", () => {
  it("leads with the typology's states and keeps the rest in place", () => {
    expect(orderFromTypology(Uint16Array.of(3, 1), [0, 1, 2, 3])).toEqual([3, 1, 0, 2])
  })

  it("keeps a revisited state rather than cancelling it out", () => {
    // The original used lodash `xor` for the leftovers, a symmetric difference:
    // a state visited twice was in both lists, so it landed in neither and its
    // row disappeared from the chart. Every state must survive the reorder.
    const next = orderFromTypology(Uint16Array.of(0, 1, 0), [0, 1, 2])
    expect([...next].sort()).toEqual([0, 1, 2])
    expect(next).toEqual([0, 1, 2])
  })

  it("ignores states the current ordering no longer has", () => {
    // A typology built before a splice can still name a state that has since
    // been removed; giving it a row would open an empty band.
    expect(orderFromTypology(Uint16Array.of(9, 1), [0, 1, 2])).toEqual([1, 0, 2])
  })
})

describe("filteredSizes", () => {
  it("counts each group's patients that pass the mask", () => {
    const store = buildStore([
      patient("p1", ["a", "b"]),
      patient("p2", ["a", "b"]),
      patient("p3", ["a", "c"]),
    ])
    const typologies = buildTypologies(store)

    const mask = new Uint8Array(store.patientCount).fill(1)
    mask[typologies[0]!.patients[0]!] = 0

    const sizes = filteredSizes(typologies, mask)
    expect([...sizes]).toEqual(typologies.map((t, i) => (i === 0 ? t.size - 1 : t.size)))
  })
})

describe("typologyIds", () => {
  it("returns every id when unmasked and only the live ones when masked", () => {
    const store = buildStore([
      patient("p1", ["a", "b"]),
      patient("p2", ["a", "b"]),
      patient("p3", ["a", "b"]),
    ])
    const typologies = buildTypologies(store)

    expect(typologyIds(typologies, store.ids, null).sort()).toEqual(["p1", "p2", "p3"])

    const mask = new Uint8Array(store.patientCount)
    mask[1] = 1
    expect(typologyIds(typologies, store.ids, mask)).toEqual(["p2"])
  })
})
