import { describe, expect, it } from "vitest"

import { clusterMembers } from "../cluster/medoids.ts"
import { CLUSTER_DEFAULTS, type ClusterRun, type TypologyClusters } from "../cluster/types.ts"
import { buildStore } from "../model/build.ts"
import { spliceStates } from "../model/reshape.ts"
import { jsonToRecords } from "../parse/json.ts"
import { applyFilters, emptyFilters, intersectTypologies } from "../query/filters.ts"
import {
  activeSteps,
  isolatedClusters,
  patientIdsCsv,
  patientRecordsJson,
  pipelineFailures,
  reconcileOrder,
  STEP_BITS,
  survivorCounts,
  survivors,
} from "../query/pipeline.ts"
import { buildTypologies } from "../stats/typologies.ts"
import type { PatientRecord } from "../types.ts"

/** Ten patients; even ones walk a → b, odd ones a → c. Disease duration 10..19. */
function cohort(): PatientRecord[] {
  return Array.from({ length: 10 }, (_, i) => ({
    id: `p_${i}`,
    trajectory: ["a", i % 2 === 0 ? "b" : "c"],
    switchEventAge: [20 + i, 30 + i],
    years: [2000 + i, 2010 + i],
    diseaseDuration: 10 + i,
  }))
}

/** One typology's clustering, reduced to what `clusterMembers` reads. */
function runOver(typologyKey: string, patients: Uint32Array, assignment: number[]): ClusterRun {
  const result = { typologyKey, n: patients.length, k: 2, patients, assignment: Int32Array.from(assignment) }
  return {
    byTypology: new Map([[typologyKey, result as unknown as TypologyClusters]]),
    clusterOfPatient: new Int32Array(0),
    clusters: [0, 1].map((c) => ({
      globalIndex: c,
      typologyKey,
      localCluster: c,
      size: assignment.filter((a) => a === c).length,
      medoidPatient: patients[assignment.indexOf(c)] as number,
    })),
    topBySize: [],
    params: CLUSTER_DEFAULTS,
  }
}

describe("build order", () => {
  it("keeps applied steps in place and appends new ones", () => {
    const order = reconcileOrder([], ["age"])
    expect(order).toEqual(["age"])

    // Dragging an existing range changes nothing about the order.
    expect(reconcileOrder(order, ["age"])).toBe(order)

    // A typology picked after the age filter comes after it, whatever the
    // canonical order would say about a disease filter added later still.
    const next = reconcileOrder(reconcileOrder(order, ["age", "typologies"]), [
      "age",
      "diseaseDuration",
      "typologies",
    ])
    expect(next).toEqual(["age", "typologies", "diseaseDuration"])

    // Dropped and placed again: back at the end.
    expect(reconcileOrder(reconcileOrder(next, ["diseaseDuration", "typologies"]), activeSteps(
      { ...emptyFilters, age: { min: 0, max: 1 }, diseaseDuration: { min: 0, max: 1 } },
      ["k"],
      [],
    ))).toEqual(["typologies", "diseaseDuration", "age"])
  })

  it("isolates clusters only on a focused typology", () => {
    const run = runOver("t", Uint32Array.of(0, 2), [0, 1])
    expect(isolatedClusters(run, [0], null)).toEqual([])
    expect(isolatedClusters(run, [0], "t")).toEqual([0])
    expect(isolatedClusters(run, [0], "other")).toEqual([])
    expect(isolatedClusters(null, [0], "t")).toEqual([])
  })
})

describe("build counts", () => {
  const store = buildStore(cohort())
  const typologies = buildTypologies(store)
  const even = typologies.find((t) => store.stateNames[t.states[1] as number] === "b")
  if (even === undefined) throw new Error("fixture: no a → b typology")

  const filters = { ...emptyFilters, diseaseDuration: { min: 10, max: 15 } } // keeps 0..5

  it("narrows step by step and ends on the selection the chart draws", () => {
    const failures = pipelineFailures(store, filters, [even.patients], null)

    const counts = survivorCounts(failures, [STEP_BITS.diseaseDuration, STEP_BITS.typologies])
    expect(counts).toEqual([6, 3]) // 0..5, then the even ones: 0, 2, 4

    // The other order passes through a different count and lands in the same place.
    expect(survivorCounts(failures, [STEP_BITS.typologies, STEP_BITS.diseaseDuration])).toEqual([5, 3])

    const selection = intersectTypologies(applyFilters(store, filters), [even.patients])
    const last = survivors(failures, STEP_BITS.diseaseDuration | STEP_BITS.typologies)
    expect([...last]).toEqual([...selection.indices()])
  })

  it("ends on the isolated cluster's members when one narrows the chart", () => {
    // Even patients 0, 2, 4, 6, 8: cluster 0 is 0 and 6, cluster 1 the rest.
    const run = runOver(even.key, even.patients, [0, 1, 1, 0, 1])
    const members = clusterMembers(run, [0], null)

    const failures = pipelineFailures(store, filters, [even.patients], members)
    const all = STEP_BITS.diseaseDuration | STEP_BITS.typologies | STEP_BITS.clusters

    const selection = intersectTypologies(applyFilters(store, filters), [even.patients])
    // 6 is a member but outside the disease range, so the chart draws 0 alone.
    expect([...survivors(failures, all)]).toEqual([...clusterMembers(run, [0], selection.mask)])
    expect([...survivors(failures, all)]).toEqual([0])
  })

  it("charges spliced-empty patients to the removed states", () => {
    const withLoner = buildStore([
      ...cohort(),
      { id: "only_d", trajectory: ["d"], switchEventAge: [50], years: [2050], diseaseDuration: 12 },
    ])
    const mask = new Uint8Array(withLoner.stateNames.length)
    mask[withLoner.stateNames.indexOf("d")] = 1
    const spliced = spliceStates(withLoner, mask)

    const failures = pipelineFailures(spliced, filters, null, null)
    expect(survivorCounts(failures, [STEP_BITS.removedStates, STEP_BITS.diseaseDuration])).toEqual([10, 6])
  })

  it("does not cut anyone for an inverted range that is not set", () => {
    const inverted = { ...emptyFilters, inverted: { diseaseDuration: true } }
    expect(applyFilters(store, inverted).count).toBe(10)
  })
})

describe("build exports", () => {
  const store = buildStore(cohort())
  const patients = Uint32Array.of(1, 4)

  it("writes one id per line under the file's own id column", () => {
    expect(patientIdsCsv(store, patients, "FINNGENID").join("")).toBe("FINNGENID\np_1\np_4\n")
  })

  it("writes records that load straight back in", () => {
    const text = patientRecordsJson(store, patients, "FINNGENID").join("")
    const records = jsonToRecords(JSON.parse(text))

    expect(records.map((r) => r.id)).toEqual(["p_1", "p_4"])
    expect(records[1]?.trajectory).toEqual(["a", "b"])
    expect(records[1]?.switchEventAge).toEqual([24, 34])
    expect(records[1]?.years).toEqual([2004, 2014])
    expect(records[1]?.diseaseDuration).toBe(14)
  })

  it("stays valid JSON across chunk boundaries and when empty", () => {
    const many = new Uint32Array(12_000).map((_, i) => i % 10)
    expect(JSON.parse(patientRecordsJson(store, many, "id").join(""))).toHaveLength(12_000)
    expect(JSON.parse(patientRecordsJson(store, new Uint32Array(), "id").join(""))).toEqual([])
  })
})
