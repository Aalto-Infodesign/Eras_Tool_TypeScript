import { describe, expect, it } from "vitest"

import { buildStore } from "../model/build.ts"
import {
  filteredSizes,
  repeatedSteps,
  sequenceLabels,
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

describe("sequenceLabels", () => {
  const names = ["a", "b", "c"]

  it("numbers only the states that actually repeat", () => {
    expect(sequenceLabels(Uint16Array.of(0, 1, 0, 2), names)).toEqual([
      "a (1)",
      "b",
      "a (2)",
      "c",
    ])
  })

  it("leaves a sequence that never returns unnumbered", () => {
    expect(sequenceLabels(Uint16Array.of(0, 1, 2), names)).toEqual(["a", "b", "c"])
  })

  it("counts each state's visits independently", () => {
    expect(sequenceLabels(Uint16Array.of(0, 1, 0, 1, 0), names)).toEqual([
      "a (1)",
      "b (1)",
      "a (2)",
      "b (2)",
      "a (3)",
    ])
  })
})

describe("repeatedSteps", () => {
  const names = ["a", "b", "c"]

  it("marks every visit to a state the sequence returns to", () => {
    expect(repeatedSteps(Uint16Array.of(0, 1, 0, 2))).toEqual([true, false, true, false])
  })

  it("marks nothing in a sequence that never comes back", () => {
    expect(repeatedSteps(Uint16Array.of(0, 1, 2))).toEqual([false, false, false])
  })

  /*
   * The two halves have to agree: the swatch lifts on exactly the steps whose
   * label carries an ordinal, or a raised dot points at a name with no visit
   * number on it and the notation stops meaning anything.
   */
  it("agrees with sequenceLabels about which steps repeat", () => {
    const states = Uint16Array.of(2, 0, 1, 0, 2, 2)
    const labels = sequenceLabels(states, names)
    expect(repeatedSteps(states)).toEqual(labels.map((label) => label.includes("(")))
  })
})
