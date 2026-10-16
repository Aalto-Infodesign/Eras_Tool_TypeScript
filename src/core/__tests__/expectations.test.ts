import { beforeEach, describe, expect, it } from "vitest"

import { useEras } from "../../app/store.ts"
import { buildStore } from "../model/build.ts"
import { emptyFilters } from "../query/filters.ts"
import { Selection } from "../query/Selection.ts"
import { buildTypologies } from "../stats/typologies.ts"
import type { PatientRecord } from "../types.ts"

const patient = (id: string, trajectory: readonly string[]): PatientRecord => ({
  id,
  trajectory,
  switchEventAge: trajectory.map((_, i) => 20 + i * 10),
  years: trajectory.map((_, i) => 2000 + i * 10),
  diseaseDuration: trajectory.length * 10,
})

/** a-b-c, a-b-d, a-e, f-g — distinct routes that branch after the first step. */
const store = buildStore([
  patient("p1", ["a", "b", "c"]),
  patient("p2", ["a", "b", "d"]),
  patient("p3", ["a", "e"]),
  patient("p4", ["f", "g"]),
])
const id = (name: string): number => store.stateNames.indexOf(name)
const selected = (): string[] => [...useEras.getState().selectedTypologies].sort()

describe("expectations", () => {
  beforeEach(() => {
    useEras.getState().reset()
    useEras.setState({
      store,
      baseStore: store,
      cohortSize: store.patientCount,
      typologies: buildTypologies(store),
      stateOrder: [...store.stateNames.keys()],
      visibleStates: [...store.stateNames.keys()],
      selection: new Selection(store.patientCount),
      population: new Selection(store.patientCount),
      filters: emptyFilters,
    })
  })

  it("saves the walk, switched on, and starts a fresh one without changing the selection", () => {
    const eras = useEras.getState()
    eras.selectPath([id("a"), id("b")])
    expect(selected()).toEqual(["a-b-c", "a-b-d"])

    eras.saveExpectation()
    const state = useEras.getState()
    expect(state.pathSteps).toEqual([])
    expect(state.expectations).toHaveLength(1)
    expect(state.expectations[0]!.steps).toEqual([id("a"), id("b")])
    expect(state.activeExpectations).toEqual([state.expectations[0]!.id])
    expect(selected()).toEqual(["a-b-c", "a-b-d"])
  })

  it("merges a different route after the branch, which one walk cannot express", () => {
    const eras = useEras.getState()
    eras.selectPath([id("a"), id("b"), id("c")])
    eras.saveExpectation()
    eras.selectPath([id("f"), id("g")])
    eras.saveExpectation()

    expect(selected()).toEqual(["a-b-c", "f-g"])

    // The walk in progress merges too.
    eras.selectPath([id("a"), id("e")])
    expect(selected()).toEqual(["a-b-c", "a-e", "f-g"])
  })

  it("toggles an expectation out of the selection and back", () => {
    const eras = useEras.getState()
    eras.selectPath([id("a"), id("e")])
    eras.saveExpectation()
    eras.selectPath([id("f")])
    eras.saveExpectation()
    const [first, second] = useEras.getState().expectations

    eras.toggleExpectation(first!.id)
    expect(selected()).toEqual(["f-g"])
    eras.toggleExpectation(second!.id)
    // Nothing switched on and no walk: the whole cohort.
    expect(selected()).toEqual([])
    eras.toggleExpectation(first!.id)
    expect(selected()).toEqual(["a-e"])

    // Undo puts the switch back with the selection.
    eras.undoSelection()
    expect(useEras.getState().activeExpectations).toEqual([])
  })

  it("drops a deleted expectation from the selection", () => {
    const eras = useEras.getState()
    eras.selectPath([id("f")])
    eras.saveExpectation()
    eras.selectPath([id("a"), id("e")])
    eras.saveExpectation()
    eras.removeExpectation(useEras.getState().expectations[0]!.id)

    expect(useEras.getState().expectations).toHaveLength(1)
    expect(selected()).toEqual(["a-e"])
  })

  it("is switched off by a selection made some other way, and kept", () => {
    const eras = useEras.getState()
    eras.selectPath([id("f")])
    eras.saveExpectation()
    eras.selectTypologies(["a-e"])

    expect(useEras.getState().activeExpectations).toEqual([])
    expect(useEras.getState().expectations).toHaveLength(1)
    expect(selected()).toEqual(["a-e"])
  })
})
