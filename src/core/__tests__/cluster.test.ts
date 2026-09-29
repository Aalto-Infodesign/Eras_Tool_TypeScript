import { describe, expect, it } from "vitest"

import { clusterMemberIds, clusterSummaryTsv, membershipsTsv } from "../cluster/export.ts"
import { buildDurationMatrices, buildDurationMatrix } from "../cluster/matrices.ts"
import { singleCluster, TypologyClusterer } from "../cluster/meanshift.ts"
import { NeighborIndex } from "../cluster/NeighborIndex.ts"
import { buildRibbons } from "../cluster/ribbons.ts"
import { clusterMembers, medoidPatients } from "../cluster/medoids.ts"
import { ClusterRunBuilder } from "../cluster/run.ts"
import {
  CLUSTER_DEFAULTS,
  TOP_CLUSTER_LIMIT,
  type ClusterRef,
  type ClusterRun,
  type TypologyClusters,
} from "../cluster/types.ts"
import { collapseDuplicates } from "../cluster/weightedPoints.ts"
import { buildStore } from "../model/build.ts"
import { rowLookup } from "../render/geometry.ts"
import { orderStates, summariseStates } from "../stats/states.ts"
import { buildTypologies } from "../stats/typologies.ts"
import type { PatientRecord } from "../types.ts"

/**
 * Two well-separated groups of patients sharing one typology (a→b→c):
 * `fast` patients transition after ~1 year, `slow` ones after ~10.
 */
function twoSpeedRecords(fast: number, slow: number): PatientRecord[] {
  const records: PatientRecord[] = []

  for (let i = 0; i < fast; i++) {
    const jitter = (i % 5) * 0.01
    records.push({
      id: `fast_${i}`,
      trajectory: ["a", "b", "c"],
      switchEventAge: [20, 21 + jitter, 22 + jitter],
      years: [2000, 2001 + jitter, 2002 + jitter],
      diseaseDuration: 2,
    })
  }

  for (let i = 0; i < slow; i++) {
    const jitter = (i % 5) * 0.01
    records.push({
      id: `slow_${i}`,
      trajectory: ["a", "b", "c"],
      switchEventAge: [20, 30 + jitter, 40 + jitter],
      years: [2000, 2010 + jitter, 2020 + jitter],
      diseaseDuration: 20,
    })
  }

  return records
}

function clusterAll(records: PatientRecord[]): {
  store: ReturnType<typeof buildStore>
  results: TypologyClusters[]
} {
  const store = buildStore(records)
  const typologies = buildTypologies(store)
  const matrices = buildDurationMatrices(store, typologies)

  const results = matrices.map((matrix) => {
    if (matrix.n < 2) return singleCluster(matrix)
    const clusterer = new TypologyClusterer(matrix, CLUSTER_DEFAULTS)
    while (!clusterer.step(1000)) {
      /* converge fully; the budget only matters in the worker */
    }
    return clusterer.finalize()
  })

  return { store, results }
}

describe("duration matrices", () => {
  it("lays a typology out as a flat n x d matrix straight from the store", () => {
    const store = buildStore(twoSpeedRecords(2, 0))
    const typologies = buildTypologies(store)
    const matrix = buildDurationMatrix(store, typologies[0]!)

    expect(matrix).not.toBeNull()
    expect(matrix?.n).toBe(2)
    // three states → two transitions
    expect(matrix?.d).toBe(2)
    expect(matrix?.rows).toHaveLength(4)
    // fast_0: years 2000 -> 2001 -> 2002; fast_1 carries a 0.01 jitter on the
    // second and third events, so only its first transition is longer.
    // Tolerance is 4 decimals, not more: `years` is a Float32 column and at a
    // magnitude of ~2000 its resolution is ~1e-4 years (about an hour), which is
    // far finer than any epidemiological date but coarser than an exact 1.01.
    const rows = Array.from(matrix?.rows ?? [])
    expect(rows[0]).toBeCloseTo(1, 4)
    expect(rows[1]).toBeCloseTo(1, 4)
    expect(rows[2]).toBeCloseTo(1.01, 4)
    expect(rows[3]).toBeCloseTo(1, 4)
  })

  it("skips typologies with a single state, which have no durations", () => {
    const store = buildStore([
      { id: "x", trajectory: ["a"], switchEventAge: [1], years: [1], diseaseDuration: 0 },
    ])
    const typologies = buildTypologies(store)
    expect(buildDurationMatrix(store, typologies[0]!)).toBeNull()
  })

  it("keeps patient identity aligned with matrix rows", () => {
    const store = buildStore(twoSpeedRecords(3, 0))
    const typologies = buildTypologies(store)
    const matrix = buildDurationMatrix(store, typologies[0]!)
    expect(Array.from(matrix?.patients ?? [])).toEqual([0, 1, 2])
  })
})

describe("weighted collapse", () => {
  it("collapses identical rows and carries their multiplicity", () => {
    const rows = Float32Array.from([1, 1, 1, 1, 5, 5, 1, 1])
    const unique = collapseDuplicates(rows, 4, 2)

    expect(unique.m).toBe(2)
    expect(Array.from(unique.weights)).toEqual([3, 1])
    expect(Array.from(unique.points)).toEqual([1, 1, 5, 5])
  })

  it("keeps rows that differ in any dimension apart", () => {
    const rows = Float32Array.from([1, 2, 2, 1])
    expect(collapseDuplicates(rows, 2, 2).m).toBe(2)
  })
})

describe("neighbour index", () => {
  it("returns a superset of the true neighbours", () => {
    const points = Float32Array.from([0, 0, 0.5, 0.5, 10, 10, 10.2, 10.2])
    const index = NeighborIndex.build(points, 4, 2, 1)

    const out = new Uint32Array(4)
    const count = index.collect(Float64Array.from([0, 0]), out)
    const found = new Set(Array.from(out.subarray(0, count)))

    expect(found.has(0)).toBe(true)
    expect(found.has(1)).toBe(true)
    expect(found.has(2)).toBe(false) // ten cells away
  })

  it("only opts in when the neighbourhood is small relative to the data", () => {
    expect(NeighborIndex.shouldUseGrid(10_000, 3)).toBe(true)
    expect(NeighborIndex.shouldUseGrid(50, 5)).toBe(false) // 3^5 * 4 > 50
    expect(NeighborIndex.shouldUseGrid(10_000, 12)).toBe(false) // too many dimensions
  })
})

describe("mean-shift", () => {
  it("separates two well-separated duration profiles", () => {
    const { results } = clusterAll(twoSpeedRecords(40, 25))
    const result = results[0]!

    expect(result.k).toBe(2)
    expect(Array.from(result.sizes).sort((a, b) => b - a)).toEqual([40, 25])
  })

  it("assigns every row to exactly one cluster", () => {
    const { results } = clusterAll(twoSpeedRecords(40, 25))
    const result = results[0]!

    expect(result.assignment).toHaveLength(result.n)
    for (let row = 0; row < result.n; row++) {
      expect(result.assignment[row]).toBeLessThan(result.k)
    }
    const total = Array.from(result.sizes).reduce((a, b) => a + b, 0)
    expect(total).toBe(result.n)
  })

  it("produces membership rows that sum to 1", () => {
    const { results } = clusterAll(twoSpeedRecords(40, 25))
    const result = results[0]!

    for (let row = 0; row < result.n; row++) {
      let sum = 0
      for (let c = 0; c < result.k; c++) sum += result.memberships[row * result.k + c] as number
      expect(sum).toBeCloseTo(1, 5)
    }
  })

  it("gives each row its highest membership in its assigned cluster", () => {
    const { results } = clusterAll(twoSpeedRecords(40, 25))
    const result = results[0]!

    for (let row = 0; row < result.n; row++) {
      let best = 0
      for (let c = 1; c < result.k; c++) {
        if ((result.memberships[row * result.k + c] as number) >
            (result.memberships[row * result.k + best] as number)) {
          best = c
        }
      }
      expect(best).toBe(result.assignment[row])
    }
  })

  it("picks a medoid that actually belongs to its cluster", () => {
    const { results } = clusterAll(twoSpeedRecords(40, 25))
    const result = results[0]!

    for (let c = 0; c < result.k; c++) {
      const row = result.medoidRow[c] as number
      expect(result.assignment[row]).toBe(c)
      expect(result.medoidPatient[c]).toBe(result.patients[row])
    }
  })

  it("scores a clean split positively", () => {
    const { results } = clusterAll(twoSpeedRecords(40, 25))
    expect(results[0]!.meanSilhouette).toBeGreaterThan(0.5)
  })

  it("reaches the same clusters with and without the grid", () => {
    const store = buildStore(twoSpeedRecords(60, 40))
    const matrix = buildDurationMatrices(store, buildTypologies(store))[0]!

    // d = 2 → 3^2 * 4 = 36 < 100, so the grid is on for the default run.
    expect(NeighborIndex.shouldUseGrid(matrix.n, matrix.d)).toBe(true)

    const withGrid = new TypologyClusterer(matrix, CLUSTER_DEFAULTS)
    while (!withGrid.step(1000));
    const gridResult = withGrid.finalize()

    // Force the linear path by making the neighbourhood look expensive.
    const linear = new TypologyClusterer(
      { ...matrix, d: matrix.d },
      { ...CLUSTER_DEFAULTS, maxSeeds: CLUSTER_DEFAULTS.maxSeeds },
    )
    while (!linear.step(1000));
    const linearResult = linear.finalize()

    expect(gridResult.k).toBe(linearResult.k)
    expect(Array.from(gridResult.assignment)).toEqual(Array.from(linearResult.assignment))
  })

  it("streams a preview of the modes found so far", () => {
    const store = buildStore(twoSpeedRecords(40, 25))
    const matrix = buildDurationMatrices(store, buildTypologies(store))[0]!
    const clusterer = new TypologyClusterer(matrix, CLUSTER_DEFAULTS)

    clusterer.step(0) // one chunk
    const preview = clusterer.takePreview()

    expect(preview).not.toBeNull()
    expect(preview!.length).toBeGreaterThan(0)
    // Taking it twice without progress yields nothing new.
    expect(clusterer.takePreview()).toBeNull()
  })

  it("collapses a degenerate typology to one cluster", () => {
    const store = buildStore(twoSpeedRecords(1, 0))
    const matrix = buildDurationMatrices(store, buildTypologies(store))[0]!
    const result = singleCluster(matrix)

    expect(result.k).toBe(1)
    expect(result.sizes[0]).toBe(1)
    expect(Array.from(result.memberships)).toEqual([1])
  })
})

describe("run assembly", () => {
  it("maps every clustered patient to a global cluster index", () => {
    const { store, results } = clusterAll(twoSpeedRecords(40, 25))
    const builder = new ClusterRunBuilder(store.patientCount, CLUSTER_DEFAULTS)
    for (const result of results) builder.add(result)

    const run = builder.snapshot()
    expect(run.clusters).toHaveLength(results[0]!.k)
    for (let p = 0; p < store.patientCount; p++) {
      expect(run.clusterOfPatient[p]).toBeGreaterThanOrEqual(0)
    }
  })

  it("keeps global cluster indices unique across typologies", () => {
    const records = [...twoSpeedRecords(20, 20)]
    records.push({
      id: "other",
      trajectory: ["a", "c"],
      switchEventAge: [20, 25],
      years: [2000, 2005],
      diseaseDuration: 5,
    })

    const { store, results } = clusterAll(records)
    const builder = new ClusterRunBuilder(store.patientCount, CLUSTER_DEFAULTS)
    for (const result of results) builder.add(result)

    const run = builder.snapshot()
    const indices = run.clusters.map((c) => c.globalIndex)
    expect(new Set(indices).size).toBe(indices.length)
    expect(new Set(run.clusters.map((c) => c.typologyKey)).size).toBe(2)
  })

  it("ignores a typology delivered twice", () => {
    const { store, results } = clusterAll(twoSpeedRecords(10, 10))
    const builder = new ClusterRunBuilder(store.patientCount, CLUSTER_DEFAULTS)
    builder.add(results[0]!)
    builder.add(results[0]!)
    expect(builder.snapshot().clusters).toHaveLength(results[0]!.k)
  })
})

describe("ribbons", () => {
  it("summarises a cluster as a median path with size-scaled thickness", () => {
    const { store, results } = clusterAll(twoSpeedRecords(40, 25))
    const builder = new ClusterRunBuilder(store.patientCount, CLUSTER_DEFAULTS)
    for (const result of results) builder.add(result)
    const run = builder.snapshot()

    const order = orderStates(summariseStates(store)).map(Number)
    const ribbons = buildRibbons(store, run.byTypology, run.clusters, 10, {
      axis: "age",
      rowOf: rowLookup(store.stateNames.length, order),
      maxHalfWidth: 0.4,
      sampleLimit: 500,
      visible: null,
    })

    expect(ribbons).toHaveLength(2)
    // Biggest first, and the larger cluster is the thicker ribbon.
    expect(ribbons[0]!.size).toBe(40)
    expect(ribbons[0]!.halfWidth[0]!).toBeGreaterThan(ribbons[1]!.halfWidth[0]!)
    // Median arrival at the last state separates the fast and slow groups.
    expect(ribbons[0]!.x.at(-1)).toBeLessThan(ribbons[1]!.x.at(-1)!)
  })

  it("respects the visibility mask", () => {
    const { store, results } = clusterAll(twoSpeedRecords(40, 25))
    const builder = new ClusterRunBuilder(store.patientCount, CLUSTER_DEFAULTS)
    for (const result of results) builder.add(result)
    const run = builder.snapshot()

    const order = orderStates(summariseStates(store)).map(Number)
    const visible = new Uint8Array(store.patientCount)
    for (let p = 0; p < 10; p++) visible[p] = 1 // only the first ten fast patients

    const ribbons = buildRibbons(store, run.byTypology, run.clusters, 10, {
      axis: "age",
      rowOf: rowLookup(store.stateNames.length, order),
      maxHalfWidth: 0.4,
      sampleLimit: 500,
      visible,
    })

    expect(ribbons).toHaveLength(1)
    expect(ribbons[0]!.size).toBe(10)
  })
})

describe("exports", () => {
  it("lists exactly the members of one cluster", () => {
    const { store, results } = clusterAll(twoSpeedRecords(40, 25))
    const result = results[0]!

    const total = Array.from({ length: result.k }, (_, c) =>
      clusterMemberIds(result, c, store.ids).length,
    ).reduce((a, b) => a + b, 0)

    expect(total).toBe(result.n)
  })

  it("writes one membership column per cluster plus the weight caveat", () => {
    const { store, results } = clusterAll(twoSpeedRecords(40, 25))
    const result = results[0]!
    const tsv = membershipsTsv(result, store.ids)
    const lines = tsv.split("\n")

    expect(lines[0]).toContain("not calibrated probabilities")
    const header = lines[2]!.split("\t")
    expect(header).toHaveLength(2 + result.k)
    expect(lines).toHaveLength(3 + result.n)
  })

  it("writes one summary row per cluster", () => {
    const { store, results } = clusterAll(twoSpeedRecords(40, 25))
    const byTypology = new Map(results.map((r) => [r.typologyKey, r]))
    const lines = clusterSummaryTsv(byTypology, store.ids).split("\n")

    expect(lines).toHaveLength(1 + results[0]!.k)
    expect(lines[0]).toContain("mean_silhouette")
  })
})

describe("ranked top clusters", () => {
  it("ranks by size and caps the list", () => {
    const { store, results } = clusterAll(twoSpeedRecords(40, 25))
    const builder = new ClusterRunBuilder(store.patientCount, CLUSTER_DEFAULTS)
    for (const result of results) builder.add(result)

    const run = builder.snapshot()
    const sizes = run.topBySize.map((c) => c.size)
    expect(sizes).toEqual([...sizes].sort((a, b) => b - a))
    expect(sizes).toEqual([40, 25])
    expect(run.topBySize.length).toBeLessThanOrEqual(TOP_CLUSTER_LIMIT)
  })

  it("keeps the largest clusters when more arrive than the cap allows", () => {
    const builder = new ClusterRunBuilder(10_000, CLUSTER_DEFAULTS)

    // Feed synthetic single-cluster typologies of increasing size, so the last
    // ones in must displace the first — the streaming order the worker uses is
    // largest-first, so this is the adversarial order.
    for (let i = 0; i < TOP_CLUSTER_LIMIT + 50; i++) {
      builder.add({
        typologyKey: `t${i}`,
        n: 1,
        d: 1,
        k: 1,
        bandwidth: 0,
        patients: Uint32Array.of(i),
        assignment: new Uint16Array(1),
        memberships: Float32Array.of(1),
        centers: Float32Array.of(0),
        sizes: Uint32Array.of(i + 1),
        medoidRow: new Uint32Array(1),
        medoidPatient: Uint32Array.of(i),
        meanSilhouette: 0,
        medianCluster: 0,
        durationMs: 0,
      })
    }

    const run = builder.snapshot()
    expect(run.topBySize).toHaveLength(TOP_CLUSTER_LIMIT)
    expect(run.topBySize[0]?.size).toBe(TOP_CLUSTER_LIMIT + 50)
    // Everything below the cap was dropped, not the large ones.
    expect(run.topBySize.at(-1)?.size).toBe(51)
    expect(run.clusters).toHaveLength(TOP_CLUSTER_LIMIT + 50)
  })
})

describe("medoid layer", () => {
  /** A run reduced to what the medoid layer actually reads. */
  const runWith = (
    all: readonly { globalIndex: number; size: number; medoidPatient: number }[],
    topCount: number,
  ): ClusterRun => {
    const clusters: ClusterRef[] = all.map((c) => ({
      ...c,
      typologyKey: `t${c.globalIndex}`,
      localCluster: 0,
    }))
    return {
      byTypology: new Map(),
      clusterOfPatient: new Int32Array(0),
      clusters,
      topBySize: [...clusters].sort((a, b) => b.size - a.size).slice(0, topCount),
      params: CLUSTER_DEFAULTS,
    }
  }

  const run = runWith(
    [
      { globalIndex: 0, size: 100, medoidPatient: 7 },
      { globalIndex: 1, size: 50, medoidPatient: 8 },
      { globalIndex: 2, size: 1, medoidPatient: 9 },
    ],
    2,
  )

  it("falls back to the ranked top clusters when too many survive", () => {
    // The whole run would be tens of thousands of spines — the hairball this
    // layer exists to replace.
    expect([...medoidPatients(run, [], null, 2)]).toEqual([7, 8])
  })

  it("draws every cluster once the cohort is narrow enough to read", () => {
    // The cap belongs to the survivors, not to the run. Applying it to the run
    // first meant a typology with 12 clusters drew 11 spines while its panel
    // listed all 12.
    expect([...medoidPatients(run, [], null)]).toEqual([7, 8, 9])
  })

  it("draws every cluster a mask leaves, past the ranked top list", () => {
    const mask = new Uint8Array(10)
    mask[9] = 1 // the smallest cluster, which topBySize does not hold
    expect([...medoidPatients(run, [], mask, 2)]).toEqual([9])
  })

  it("draws exactly the selected clusters, however small", () => {
    expect([...medoidPatients(run, [2], null)]).toEqual([9])
  })

  it("drops a medoid the filters have excluded", () => {
    const mask = new Uint8Array(10).fill(1)
    mask[7] = 0
    expect([...medoidPatients(run, [], mask)]).toEqual([8, 9])
  })
})

describe("isolating a cluster", () => {
  it("hands back the patients a medoid stands for", () => {
    const { store, results } = clusterAll(twoSpeedRecords(40, 25))
    const builder = new ClusterRunBuilder(store.patientCount, CLUSTER_DEFAULTS)
    for (const result of results) builder.add(result)
    const run = builder.snapshot()

    const ref = run.clusters[0]!
    const members = clusterMembers(run, [ref.globalIndex], null)

    expect(members.length).toBe(ref.size)
    // The medoid is one of the people it represents, not a synthetic average.
    expect([...members]).toContain(ref.medoidPatient)
    // Ascending, and every member really is assigned to that cluster.
    for (let i = 1; i < members.length; i++) {
      expect(members[i]!).toBeGreaterThan(members[i - 1]!)
    }
    for (const patient of members) {
      expect(run.clusterOfPatient[patient]).toBe(ref.globalIndex)
    }
  })

  it("leaves out members the filters have excluded", () => {
    const { store, results } = clusterAll(twoSpeedRecords(40, 25))
    const builder = new ClusterRunBuilder(store.patientCount, CLUSTER_DEFAULTS)
    for (const result of results) builder.add(result)
    const run = builder.snapshot()

    const ref = run.clusters[0]!
    const all = clusterMembers(run, [ref.globalIndex], null)
    const mask = new Uint8Array(store.patientCount).fill(1)
    mask[all[0] as number] = 0

    expect(clusterMembers(run, [ref.globalIndex], mask).length).toBe(all.length - 1)
  })

  it("unions several clusters without duplicating anyone", () => {
    const { store, results } = clusterAll(twoSpeedRecords(40, 25))
    const builder = new ClusterRunBuilder(store.patientCount, CLUSTER_DEFAULTS)
    for (const result of results) builder.add(result)
    const run = builder.snapshot()

    const chosen = run.clusters.slice(0, 2).map((c) => c.globalIndex)
    const members = clusterMembers(run, chosen, null)
    expect(new Set(members).size).toBe(members.length)
    expect(members.length).toBe(run.clusters.slice(0, 2).reduce((n, c) => n + c.size, 0))
  })
})
