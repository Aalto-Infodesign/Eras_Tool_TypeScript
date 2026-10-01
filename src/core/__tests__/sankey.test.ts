import { describe, expect, it } from "vitest"

import { buildStore } from "../model/build.ts"
import { spliceStates } from "../model/reshape.ts"
import { applyFilters, emptyFilters } from "../query/filters.ts"
import {
  buildSankey,
  itemKey,
  linkSegmentsInRange,
  parsePinKey,
  pinKey,
  pinOf,
  resolvePin,
  samePin,
  sankeyMetricValues,
  stepMetricValues,
  summarise,
  traceSankey,
  typologiesThrough,
  typologyOfPatient,
  type SankeyGraph,
  type SankeyItem,
  type SankeyItemKind,
  type SankeyMetric,
  type SankeyPin,
} from "../stats/sankey.ts"
import { filteredSizes } from "../stats/silhouettes.ts"
import { buildTypologies } from "../stats/typologies.ts"
import type { PatientRecord, TrajectoryStore, Typology } from "../types.ts"

const patient = (id: string, trajectory: readonly string[]): PatientRecord => ({
  id,
  trajectory,
  switchEventAge: trajectory.map((_, i) => 20 + i * 10),
  years: trajectory.map((_, i) => 2000 + i * 10),
  diseaseDuration: trajectory.length * 10,
})

/** a-b-c ×3, a-b-d ×2, a-e ×4, f ×1 */
const cohort = (): TrajectoryStore =>
  buildStore([
    patient("p1", ["a", "b", "c"]),
    patient("p2", ["a", "b", "c"]),
    patient("p3", ["a", "b", "c"]),
    patient("p4", ["a", "b", "d"]),
    patient("p5", ["a", "b", "d"]),
    patient("p6", ["a", "e"]),
    patient("p7", ["a", "e"]),
    patient("p8", ["a", "e"]),
    patient("p9", ["a", "e"]),
    patient("p10", ["f"]),
  ])

interface Built {
  readonly store: TrajectoryStore
  readonly typologies: Typology[]
  readonly sizes: Uint32Array
  readonly mask: Uint8Array
  readonly graph: SankeyGraph
  readonly id: (name: string) => number
}

/** The graph over `store`, optionally with some patients filtered out. */
const build = (store: TrajectoryStore, drop: readonly string[] = [], stateCount?: number): Built => {
  const typologies = buildTypologies(store)
  const mask = new Uint8Array(store.patientCount).fill(1)
  for (let p = 0; p < store.patientCount; p++) {
    if (drop.includes(store.ids.at(p))) mask[p] = 0
  }
  const sizes = filteredSizes(typologies, mask)
  const graph = buildSankey(typologies, sizes, stateCount ?? store.stateNames.length)
  return { store, typologies, sizes, mask, graph, id: (name) => store.stateNames.indexOf(name) }
}

const node = (b: Built, step: number, state: string): SankeyItem => ({
  kind: "node",
  index: b.graph.nodeAt(step, b.id(state)),
})

const link = (b: Built, step: number, source: string, target: string): SankeyItem => ({
  kind: "link",
  index: b.graph.linkAt(step, b.id(source), b.id(target)),
})

/** A readable picture of the graph: `a@0 9` and `a→b@0 5`. */
const describeGraph = (b: Built): { nodes: string[]; links: string[] } => ({
  nodes: b.graph.nodes.map((n) => `${b.store.stateNames[n.state]}@${n.step} ${n.size}`),
  links: b.graph.links.map((l) => {
    const source = b.graph.nodes[l.source]!
    const target = b.graph.nodes[l.target]!
    return `${b.store.stateNames[source.state]}→${b.store.stateNames[target.state]}@${l.step} ${l.size}`
  }),
})

const sorted = (values: Float64Array): number[] => [...values].sort((x, y) => x - y)

const keysOf = (b: Built, indices: Uint32Array): string[] =>
  Array.from(indices, (t) => b.typologies[t]!.key).sort()

describe("sankey graph", () => {
  it("has a node per (step, state) and a link per consecutive pair, in order", () => {
    const b = build(cohort())

    // Ids by first appearance: a b c d e f. Nodes by step then state id, links
    // by step, source, target.
    expect(describeGraph(b)).toEqual({
      nodes: ["a@0 9", "f@0 1", "b@1 5", "e@1 4", "c@2 3", "d@2 2"],
      links: ["a→b@0 5", "a→e@0 4", "b→c@1 3", "b→d@1 2"],
    })
    expect(b.graph.steps).toBe(3)
    expect(b.graph.total).toBe(10)
    b.graph.nodes.forEach((n, i) => expect(n.index).toBe(i))
    b.graph.links.forEach((l, i) => expect(l.index).toBe(i))
  })

  it("splits each node into who arrives, who goes on and who stops", () => {
    const b = build(cohort())
    const at = (step: number, state: string) => b.graph.nodes[b.graph.nodeAt(step, b.id(state))]!

    expect(at(0, "a")).toMatchObject({ size: 9, inflow: 0, outflow: 9, ends: 0 })
    expect(at(0, "f")).toMatchObject({ size: 1, inflow: 0, outflow: 0, ends: 1 })
    expect(at(1, "b")).toMatchObject({ size: 5, inflow: 5, outflow: 5, ends: 0 })
    expect(at(1, "e")).toMatchObject({ size: 4, inflow: 4, outflow: 0, ends: 4 })
  })

  it("conserves flow through every node", () => {
    const b = build(cohort(), ["p4", "p7"])
    const { graph } = b

    for (const n of graph.nodes) {
      const into = graph.incoming[n.index]!.reduce((sum, l) => sum + graph.links[l]!.size, 0)
      const out = graph.outgoing[n.index]!.reduce((sum, l) => sum + graph.links[l]!.size, 0)
      expect(into).toBe(n.inflow)
      expect(out).toBe(n.outflow)
      expect(n.outflow + n.ends).toBe(n.size)
    }
    // Everyone is in the first column.
    const first = graph.nodes.filter((n) => n.step === 0).reduce((sum, n) => sum + n.size, 0)
    expect(first).toBe(graph.total)
    expect(graph.total).toBe(8)
  })

  it("lists links into and out of a node by the other end's state", () => {
    const b = build(cohort())
    const a = b.graph.nodeAt(0, b.id("a"))
    const bNode = b.graph.nodeAt(1, b.id("b"))

    expect(b.graph.outgoing[a]).toEqual([link(b, 0, "a", "b").index, link(b, 0, "a", "e").index])
    expect(b.graph.incoming[bNode]).toEqual([link(b, 0, "a", "b").index])
    expect(b.graph.incoming[a]).toEqual([])
  })

  it("omits what nobody live crosses rather than drawing it at zero", () => {
    const b = build(cohort(), ["p6", "p7", "p8", "p9"])

    expect(describeGraph(b)).toEqual({
      nodes: ["a@0 5", "f@0 1", "b@1 5", "c@2 3", "d@2 2"],
      links: ["a→b@0 5", "b→c@1 3", "b→d@1 2"],
    })
    expect(b.graph.nodeAt(1, b.id("e"))).toBe(-1)
    expect(b.graph.linkAt(0, b.id("a"), b.id("e"))).toBe(-1)
    // The emptied typology is not in anyone's CSR list either.
    expect(keysOf(b, typologiesThrough(b.graph, b.typologies, node(b, 0, "a")))).toEqual([
      "a-b-c",
      "a-b-d",
    ])
  })

  it("is empty when nobody is live", () => {
    const store = cohort()
    const typologies = buildTypologies(store)
    const graph = buildSankey(typologies, new Uint32Array(typologies.length), store.stateNames.length)

    expect(graph.nodes).toEqual([])
    expect(graph.links).toEqual([])
    expect(graph.steps).toBe(0)
    expect(graph.total).toBe(0)
    expect(graph.nodeAt(0, 0)).toBe(-1)
    expect(buildSankey([], new Uint32Array(), 0).nodes).toEqual([])
  })

  it("keeps repeated states apart by step", () => {
    const b = build(buildStore([patient("p1", ["a", "b", "a"]), patient("p2", ["a", "a"])]))

    expect(describeGraph(b)).toEqual({
      nodes: ["a@0 2", "a@1 1", "b@1 1", "a@2 1"],
      links: ["a→a@0 1", "a→b@0 1", "b→a@1 1"],
    })
  })

  it("answers lookups outside the graph with -1", () => {
    const b = build(cohort())

    expect(b.graph.nodeAt(-1, 0)).toBe(-1)
    expect(b.graph.nodeAt(3, 0)).toBe(-1)
    expect(b.graph.nodeAt(0, 99)).toBe(-1)
    expect(b.graph.nodeAt(0.5, 0)).toBe(-1)
    // The last column has no links out of it.
    expect(b.graph.linkAt(2, b.id("c"), b.id("c"))).toBe(-1)
    expect(b.graph.linkAt(0, b.id("a"), b.id("c"))).toBe(-1)
  })

  it("builds the same graph through the Map fallback", () => {
    // 3 steps × 300² slots is past the dense limit, so this takes the Map path.
    const dense = build(cohort())
    const sparse = build(cohort(), [], 300)

    expect(sparse.graph.stateCount).toBe(300)
    expect(describeGraph(sparse)).toEqual(describeGraph(dense))
    expect([...sparse.graph.nodeTypologies]).toEqual([...dense.graph.nodeTypologies])
    expect([...sparse.graph.linkOffsets]).toEqual([...dense.graph.linkOffsets])
    for (const n of dense.graph.nodes) expect(sparse.graph.nodeAt(n.step, n.state)).toBe(n.index)
    expect(sparse.graph.linkAt(1, dense.id("b"), dense.id("d"))).toBe(3)
    expect(sparse.graph.nodeAt(0, 299)).toBe(-1)
  })

  it("widens past a stale state count instead of folding states together", () => {
    const store = cohort()
    const typologies = buildTypologies(store)
    const graph = buildSankey(typologies, filteredSizes(typologies, new Uint8Array(10).fill(1)), 2)

    expect(graph.stateCount).toBe(store.stateNames.length)
    expect(graph.nodes).toHaveLength(6)
  })
})

describe("sankey after a splice", () => {
  it("moves later events to earlier steps and links across what was removed", () => {
    const store = buildStore([
      {
        id: "p1",
        trajectory: ["a", "b", "a"],
        switchEventAge: [20, 30, 45],
        years: [2000, 2010, 2025],
        diseaseDuration: 25,
      },
      patient("p2", ["a", "b", "c"]),
    ])
    const mask = new Uint8Array(store.stateNames.length)
    mask[store.stateNames.indexOf("b")] = 1
    const b = build(spliceStates(store, mask))

    // a-b-a is now a-a: one same-state link from a@0 to a@1. And c, which was
    // at step 2, is at step 1.
    expect(describeGraph(b)).toEqual({
      nodes: ["a@0 2", "a@1 1", "c@1 1"],
      links: ["a→a@0 1", "a→c@0 1"],
    })

    // The same-state link's duration spans the removed state: 2000 → 2025.
    const values = sankeyMetricValues({
      store: b.store,
      graph: b.graph,
      typologies: b.typologies,
      mask: b.mask,
      item: link(b, 0, "a", "a"),
      metric: "duration",
    })
    expect([...values]).toEqual([25])
  })
})

describe("sankey pins", () => {
  it("round-trips keys", () => {
    const node: SankeyPin = { kind: "node", step: 2, state: 7 }
    const link: SankeyPin = { kind: "link", step: 0, source: 3, target: 3 }

    expect(pinKey(node)).toBe("n:2:7")
    expect(pinKey(link)).toBe("l:0:3:3")
    expect(parsePinKey("n:2:7")).toEqual(node)
    expect(parsePinKey("l:0:3:3")).toEqual(link)
  })

  it("refuses keys it would not have produced", () => {
    const malformed = ["", "n", "n:1", "n:1:2:3", "l:0:1", "x:1:2", "n:-1:2", "n:1.5:2", "n:a:b"]
    for (const key of [...malformed, "n: 1:2", "n:1:2:"]) expect(parsePinKey(key)).toBeNull()
  })

  it("resolves every item back to itself", () => {
    const b = build(cohort())
    const items: SankeyItem[] = [
      ...b.graph.nodes.map((n) => ({ kind: "node" as const, index: n.index })),
      ...b.graph.links.map((l) => ({ kind: "link" as const, index: l.index })),
    ]

    for (const item of items) {
      const pin = pinOf(b.graph, item)
      expect(pin).not.toBeNull()
      expect(resolvePin(b.graph, pin)).toEqual(item)
      expect(parsePinKey(itemKey(b.graph, item))).toEqual(pin)
    }
    expect(pinOf(b.graph, { kind: "link", index: 99 })).toBeNull()
    expect(itemKey(b.graph, { kind: "node", index: -1 })).toBe("")
    expect(resolvePin(b.graph, null)).toBeNull()
  })

  it("names a link by its states, not its node indices", () => {
    const b = build(cohort())
    expect(pinOf(b.graph, link(b, 1, "b", "d"))).toEqual({
      kind: "link",
      step: 1,
      source: b.id("b"),
      target: b.id("d"),
    })
  })

  it("follows its item to a new index after a rebuild, and goes dormant when it empties", () => {
    const before = build(cohort())
    const bc = pinOf(before.graph, link(before, 1, "b", "c"))!
    const c = pinOf(before.graph, node(before, 2, "c"))!
    const e = pinOf(before.graph, node(before, 1, "e"))!
    expect(resolvePin(before.graph, bc)).toEqual({ kind: "link", index: 2 })
    expect(resolvePin(before.graph, c)).toEqual({ kind: "node", index: 4 })

    // Filtering out every a-e patient drops a node and a link ahead of both.
    const after = build(cohort(), ["p6", "p7", "p8", "p9"])
    expect(resolvePin(after.graph, bc)).toEqual({ kind: "link", index: 1 })
    expect(resolvePin(after.graph, c)).toEqual({ kind: "node", index: 3 })
    expect(resolvePin(after.graph, e)).toBeNull()
  })

  it("compares pins by identity", () => {
    const node = (step: number, state: number): SankeyPin => ({ kind: "node", step, state })
    const link = (step: number, source: number, target: number): SankeyPin => ({
      kind: "link",
      step,
      source,
      target,
    })

    expect(samePin(null, null)).toBe(true)
    expect(samePin(node(1, 2), null)).toBe(false)
    expect(samePin(node(1, 2), node(1, 2))).toBe(true)
    expect(samePin(node(1, 2), node(2, 2))).toBe(false)
    expect(samePin(link(0, 1, 2), link(0, 1, 2))).toBe(true)
    expect(samePin(link(0, 1, 2), link(0, 2, 1))).toBe(false)
    expect(samePin(node(0, 1), link(0, 1, 1))).toBe(false)
  })
})

describe("typologies through an item", () => {
  it("finds every typology through a link", () => {
    const b = build(cohort())
    expect(keysOf(b, typologiesThrough(b.graph, b.typologies, link(b, 0, "a", "b")))).toEqual([
      "a-b-c",
      "a-b-d",
    ])
    expect(keysOf(b, typologiesThrough(b.graph, b.typologies, link(b, 0, "a", "e")))).toEqual(["a-e"])
  })

  it("narrows a node to who continues and who stops, as the original's buttons did", () => {
    const b = build(cohort())
    const through = (step: number, state: string, scope: "all" | "continuing" | "ending") =>
      keysOf(b, typologiesThrough(b.graph, b.typologies, node(b, step, state), scope))

    expect(through(0, "a", "all")).toEqual(["a-b-c", "a-b-d", "a-e"])
    expect(through(0, "a", "continuing")).toEqual(["a-b-c", "a-b-d", "a-e"])
    expect(through(0, "a", "ending")).toEqual([])
    expect(through(1, "e", "continuing")).toEqual([])
    expect(through(1, "e", "ending")).toEqual(["a-e"])
    expect(through(0, "f", "ending")).toEqual(["f"])
  })

  it("sizes the scopes to the node's outflow and ends", () => {
    const b = build(cohort(), ["p1", "p6"])
    const live = (indices: Uint32Array): number =>
      Array.from(indices).reduce((sum, t) => sum + b.sizes[t]!, 0)

    for (const n of b.graph.nodes) {
      const item: SankeyItem = { kind: "node", index: n.index }
      const all = typologiesThrough(b.graph, b.typologies, item, "all")
      const continuing = typologiesThrough(b.graph, b.typologies, item, "continuing")
      const ending = typologiesThrough(b.graph, b.typologies, item, "ending")

      expect(live(all)).toBe(n.size)
      expect(live(continuing)).toBe(n.outflow)
      expect(live(ending)).toBe(n.ends)
      expect(continuing.length + ending.length).toBe(all.length)
    }
    for (const l of b.graph.links) {
      expect(live(typologiesThrough(b.graph, b.typologies, { kind: "link", index: l.index }))).toBe(l.size)
    }
  })

  it("returns nothing for an index that is not in the graph", () => {
    const b = build(cohort())
    expect(typologiesThrough(b.graph, b.typologies, { kind: "node", index: 99 })).toHaveLength(0)
    expect(typologiesThrough(b.graph, b.typologies, { kind: "link", index: -1 })).toHaveLength(0)
  })
})

describe("sankey trace", () => {
  it("follows the patients through a link upstream and downstream", () => {
    const b = build(cohort())
    const through = typologiesThrough(b.graph, b.typologies, link(b, 1, "b", "c"))
    const trace = traceSankey(b.graph, b.typologies, b.sizes, through)

    expect(trace.total).toBe(3)
    expect(trace.nodes[node(b, 0, "a").index]).toBe(3)
    expect(trace.nodes[node(b, 1, "b").index]).toBe(3)
    expect(trace.nodes[node(b, 2, "c").index]).toBe(3)
    expect(trace.nodes[node(b, 2, "d").index]).toBe(0)
    expect(trace.links[link(b, 0, "a", "b").index]).toBe(3)
    expect(trace.links[link(b, 0, "a", "e").index]).toBe(0)
  })

  it("reproduces the graph when it traces everyone", () => {
    const b = build(cohort(), ["p2"])
    const everyone = Uint32Array.from(b.typologies.keys())
    const trace = traceSankey(b.graph, b.typologies, b.sizes, everyone)

    expect([...trace.nodes]).toEqual(b.graph.nodes.map((n) => n.size))
    expect([...trace.links]).toEqual(b.graph.links.map((l) => l.size))
    expect(trace.total).toBe(b.graph.total)
  })

  it("skips a typology nobody live is in", () => {
    const b = build(cohort(), ["p10"])
    const f = b.typologies.findIndex((t) => t.key === "f")
    const trace = traceSankey(b.graph, b.typologies, b.sizes, Uint32Array.of(f))
    expect(trace.total).toBe(0)
    expect(trace.nodes.every((c) => c === 0)).toBe(true)
  })

  it("maps each patient to their typology, and emptied patients to none", () => {
    const store = cohort()
    const mask = new Uint8Array(store.stateNames.length)
    mask[store.stateNames.indexOf("f")] = 1
    const spliced = spliceStates(store, mask)
    const typologies = buildTypologies(spliced)
    const of = typologyOfPatient(typologies, spliced.patientCount)

    for (let p = 0; p < spliced.patientCount; p++) {
      if (store.ids.at(p) === "p10") expect(of[p]).toBe(-1)
      else expect(typologies[of[p]!]!.patients).toContain(p)
    }
  })
})

const record = (
  id: string,
  trajectory: readonly string[],
  switchEventAge: readonly number[],
  years: readonly number[],
  diseaseDuration: number,
): PatientRecord => ({ id, trajectory, switchEventAge, years, diseaseDuration })

/** Patients with distinct numbers everywhere, so each metric is identifiable. */
const measured = (): TrajectoryStore =>
  buildStore([
    record("q1", ["a", "b", "c"], [20, 31, 45], [2000, 2011, 2025], 25),
    record("q2", ["a", "b", "c"], [22, 24, 30], [2002, 2004, 2010], 8),
    record("q3", ["a", "b"], [40, 47], [1990, 1997], 7),
    record("q4", ["a"], [60], [2020], 0),
  ])

describe("sankey metric values", () => {
  const values = (b: Built, item: SankeyItem, metric: SankeyMetric): number[] =>
    sorted(sankeyMetricValues({ ...b, item, metric }))

  it("reads a link's duration from a to b and its age and year on reaching b", () => {
    const b = build(measured())
    const ab = link(b, 0, "a", "b")

    expect(values(b, ab, "duration")).toEqual([2, 7, 11])
    expect(values(b, ab, "age")).toEqual([24, 31, 47])
    expect(values(b, ab, "year")).toEqual([1997, 2004, 2011])
    expect(values(b, ab, "diseaseDuration")).toEqual([7, 8, 25])

    const bc = link(b, 1, "b", "c")
    expect(values(b, bc, "duration")).toEqual([6, 14])
    expect(values(b, bc, "age")).toEqual([30, 45])
  })

  it("reads a node's age on reaching it, and its duration only for who goes on", () => {
    const b = build(measured())
    const a = node(b, 0, "a")
    const bNode = node(b, 1, "b")

    expect(values(b, a, "age")).toEqual([20, 22, 40, 60])
    expect(values(b, a, "year")).toEqual([1990, 2000, 2002, 2020])
    expect(values(b, a, "diseaseDuration")).toEqual([0, 7, 8, 25])
    // q4 stops at a: its closing self-link's zero is not a duration.
    expect(values(b, a, "duration")).toEqual([2, 7, 11])
    // q3 stops at b, so only q1 and q2 have a time in b.
    expect(values(b, bNode, "duration")).toEqual([6, 14])
    expect(values(b, node(b, 2, "c"), "duration")).toEqual([])
  })

  it("counts only live patients, at exact length", () => {
    const b = build(measured(), ["q2"])
    const result = sankeyMetricValues({
      store: b.store,
      graph: b.graph,
      typologies: b.typologies,
      mask: b.mask,
      item: link(b, 0, "a", "b"),
      metric: "duration",
    })

    expect(result).toHaveLength(2)
    expect([...result].sort((x, y) => x - y)).toEqual([7, 11])
  })

  it("gives the whole step as the baseline", () => {
    const b = build(measured())
    const step = (s: number, kind: SankeyItemKind, metric: SankeyMetric): number[] =>
      sorted(stepMetricValues({ ...b, step: s, kind, metric }))

    // Every link 0 → 1: q1, q2, q3.
    expect(step(0, "link", "duration")).toEqual([2, 7, 11])
    expect(step(0, "link", "age")).toEqual([24, 31, 47])
    // Every node in column 0 has an age; only those who go on have a duration.
    expect(step(0, "node", "age")).toEqual([20, 22, 40, 60])
    expect(step(0, "node", "duration")).toEqual([2, 7, 11])
    expect(step(1, "link", "duration")).toEqual([6, 14])
    expect(step(5, "link", "duration")).toEqual([])
  })

  it("respects the mask in the baseline too", () => {
    const b = build(measured(), ["q1"])
    const baseline = stepMetricValues({
      store: b.store,
      typologies: b.typologies,
      mask: b.mask,
      step: 0,
      kind: "node",
      metric: "age",
    })
    expect([...baseline].sort((x, y) => x - y)).toEqual([22, 40, 60])
  })
})

describe("segments in the duration filter", () => {
  it("counts each link's segments inside the range, or outside it when inverted", () => {
    const b = build(measured())
    const range = { min: 5, max: 12 }
    const inside = linkSegmentsInRange({ ...b, range, inverted: false })
    const outside = linkSegmentsInRange({ ...b, range, inverted: true })

    // a→b durations are 2, 7, 11; b→c are 6, 14.
    expect(inside[link(b, 0, "a", "b").index]).toBe(2)
    expect(inside[link(b, 1, "b", "c").index]).toBe(1)
    for (const l of b.graph.links) expect(inside[l.index]! + outside[l.index]!).toBe(l.size)
  })

  it("sees the graph the filter itself produced", () => {
    // The filter keeps a patient if *any* segment is in range, so a kept
    // patient's other segments can fall outside it — that is the ghost share.
    const store = measured()
    const range = { min: 13, max: 20 }
    const selection = applyFilters(store, { ...emptyFilters, duration: range })
    const typologies = buildTypologies(store)
    const graph = buildSankey(typologies, filteredSizes(typologies, selection.mask), store.stateNames.length)
    const { mask } = selection
    const lit = linkSegmentsInRange({ store, graph, typologies, mask, range, inverted: false })

    // Only q1 (b→c 14 y) survives; its a→b segment (11 y) is outside the range.
    expect(graph.total).toBe(1)
    const ab = graph.linkAt(0, store.stateNames.indexOf("a"), store.stateNames.indexOf("b"))
    const bc = graph.linkAt(1, store.stateNames.indexOf("b"), store.stateNames.indexOf("c"))
    expect(lit[ab]).toBe(0)
    expect(lit[bc]).toBe(1)
  })
})

describe("summarise", () => {
  it("is all NaN for no values", () => {
    const summary = summarise(new Float64Array())
    expect(summary.n).toBe(0)
    for (const key of ["min", "q1", "median", "q3", "max", "mean"] as const) {
      expect(summary[key]).toBeNaN()
    }
  })

  it("collapses to the value for one", () => {
    expect(summarise(Float64Array.of(4))).toEqual({ n: 1, min: 4, q1: 4, median: 4, q3: 4, max: 4, mean: 4 })
  })

  it("takes the middle two for an even count", () => {
    const summary = summarise(Float64Array.of(4, 1, 3, 2))
    expect(summary.median).toBe(2.5)
    expect(summary.min).toBe(1)
    expect(summary.max).toBe(4)
    expect(summary.mean).toBe(2.5)
    // Linear interpolation between order statistics, as d3.quantile.
    expect(summary.q1).toBeCloseTo(1.75)
    expect(summary.q3).toBeCloseTo(3.25)
  })

  it("reads quartiles off an odd count exactly", () => {
    expect(summarise(Float64Array.of(5, 1, 4, 2, 3))).toEqual({
      n: 5,
      min: 1,
      q1: 2,
      median: 3,
      q3: 4,
      max: 5,
      mean: 3,
    })
  })

  it("skips NaN and leaves its input alone", () => {
    const input = Float64Array.of(3, NaN, 1)
    const summary = summarise(input)
    expect(summary.n).toBe(2)
    expect(summary.median).toBe(2)
    expect([...input]).toEqual([3, NaN, 1])
  })
})
