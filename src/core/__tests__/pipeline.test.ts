import { describe, expect, it } from "vitest"

import { buildStore } from "../model/build.ts"
import { readDelimitedRows } from "../parse/delimited.ts"
import { dateToFractionalYear } from "../parse/dates.ts"
import { ingest } from "../parse/ingest.ts"
import { detectMapping } from "../parse/schema.ts"
import { applyFilters, emptyFilters, intersectTypologies } from "../query/filters.ts"
import { Selection } from "../query/Selection.ts"
import { buildGeometry, rowLookup } from "../render/geometry.ts"
import { buildPalette } from "../render/palette.ts"
import { orderStates, summariseStates } from "../stats/states.ts"
import { buildTypologies } from "../stats/typologies.ts"
import type { PatientRecord } from "../types.ts"

const TSV = [
  "FINNGENID\tstage\tage\tdate\tdisease_duration",
  "P1\ta\t25\t1969\t40",
  "P1\tb\t53\t1997\t40",
  "P1\tc\t65\t2009\t40",
  "P2\ta\t30\t1980\t20",
  "P2\tc\t50\t2000\t20",
  "P3\ta\t20\t1990\t35",
  "P3\tb\t40\t2010\t35",
  "P3\tc\t55\t2025\t35",
].join("\n")

describe("delimited parsing", () => {
  it("sniffs tabs and reads every row", () => {
    const rows = readDelimitedRows(TSV)
    expect(rows).toHaveLength(9)
    expect(rows[0]).toEqual(["FINNGENID", "stage", "age", "date", "disease_duration"])
    expect(rows[1]).toEqual(["P1", "a", "25", "1969", "40"])
  })

  it("handles quoted fields containing the delimiter and escaped quotes", () => {
    const csv = 'id,label\n1,"a,b"\n2,"say ""hi"""\n'
    const rows = readDelimitedRows(csv)
    expect(rows[1]).toEqual(["1", "a,b"])
    expect(rows[2]).toEqual(["2", 'say "hi"'])
  })

  it("strips a BOM so the first header is not corrupted", () => {
    const rows = readDelimitedRows("﻿FINNGENID\tstage\nP1\ta")
    expect(rows[0]?.[0]).toBe("FINNGENID")
  })

  it("reads a final row with no trailing newline", () => {
    expect(readDelimitedRows("a\tb\n1\t2")).toHaveLength(2)
  })
})

describe("dates", () => {
  it("treats a bare year as a year, not a timestamp", () => {
    expect(dateToFractionalYear("1969")).toBe(1969)
  })

  it("parses ISO and European orders differently", () => {
    expect(dateToFractionalYear("1997-06-10")).toBeCloseTo(1997.44, 1)
    expect(dateToFractionalYear("10-06-1997")).toBeCloseTo(1997.44, 1)
  })

  it("returns null rather than throwing on junk", () => {
    expect(dateToFractionalYear("not a date")).toBeNull()
  })
})

describe("column detection", () => {
  it("maps the canonical FinnGen headers", () => {
    const rows = readDelimitedRows(TSV)
    const [headers = [], ...body] = rows
    const candidate = detectMapping({ headers, rows: body })

    expect(candidate?.mapping).toEqual({
      patientId: "FINNGENID",
      state: "stage",
      age: "age",
      date: "date",
      diseaseDuration: "disease_duration",
    })
  })

  it("maps headers the original hard-coding would have missed", () => {
    const text = [
      "patient_id,event,ageAtEvent,event_date",
      "x1,healthy,20,2000-01-01",
      "x1,sick,30,2010-01-01",
      "x2,healthy,25,2001-01-01",
      "x2,sick,35,2011-01-01",
    ].join("\n")

    const [headers = [], ...body] = readDelimitedRows(text)
    const candidate = detectMapping({ headers, rows: body })

    expect(candidate?.mapping.patientId).toBe("patient_id")
    expect(candidate?.mapping.state).toBe("event")
    expect(candidate?.mapping.age).toBe("ageAtEvent")
    expect(candidate?.mapping.date).toBe("event_date")
  })
})

describe("store construction", () => {
  const { store } = ingest(TSV, "demo.tsv")

  it("lays patients out in CSR order", () => {
    expect(store.patientCount).toBe(3)
    expect(store.eventCount).toBe(8)
    expect(Array.from(store.offsets)).toEqual([0, 3, 5, 8])
    expect(store.ids.at(0)).toBe("P1")
    expect(store.ids.at(2)).toBe("P3")
  })

  it("interns states and keeps event columns aligned", () => {
    expect(store.stateNames).toEqual(["a", "b", "c"])
    expect(Array.from(store.stateIds)).toEqual([0, 1, 2, 0, 2, 0, 1, 2])
    expect(Array.from(store.ages)).toEqual([25, 53, 65, 30, 50, 20, 40, 55])
  })

  it("computes durations within a patient and zeroes the last event", () => {
    // P1: 1997-1969 = 28, 2009-1997 = 12, last = 0
    expect(Array.from(store.durations.slice(0, 3))).toEqual([28, 12, 0])
    // P2 spans two events only
    expect(Array.from(store.durations.slice(3, 5))).toEqual([20, 0])
  })

  it("never lets a duration straddle two patients", () => {
    for (let p = 0; p < store.patientCount; p++) {
      const last = (store.offsets[p + 1] as number) - 1
      expect(store.durations[last]).toBe(0)
    }
  })

  it("reads the declared disease duration", () => {
    expect(Array.from(store.diseaseDuration)).toEqual([40, 20, 35])
  })

  it("records extents across every event", () => {
    expect(store.extents.age).toEqual([20, 65])
    expect(store.extents.maxTrajectoryLength).toBe(3)
  })
})

describe("json ingest", () => {
  it("accepts the wide per-patient shape", () => {
    const json = JSON.stringify([
      {
        FINNGENID: "J1",
        trajectory: ["a", "b"],
        SwitchEventAge: [10, 20],
        years: [2000, 2010],
        diseaseDuration: 10,
      },
    ])
    const { store } = ingest(json, "demo.json")
    expect(store.patientCount).toBe(1)
    expect(store.ids.at(0)).toBe("J1")
    expect(Array.from(store.durations)).toEqual([10, 0])
  })

  it("renames personSourceValue on every record, not just the first", () => {
    const json = JSON.stringify([
      { personSourceValue: "A", trajectory: ["a"], SwitchEventAge: [1], years: [2000] },
      { personSourceValue: "B", trajectory: ["a"], SwitchEventAge: [1], years: [2000] },
    ])
    const { store } = ingest(json, "demo.json")
    expect([store.ids.at(0), store.ids.at(1)]).toEqual(["A", "B"])
  })
})

describe("stats", () => {
  const { store } = ingest(TSV, "demo.tsv")

  it("counts each patient once per state even on revisits", () => {
    const records: PatientRecord[] = [
      { id: "R", trajectory: ["a", "b", "a"], switchEventAge: [1, 2, 3], years: [1, 2, 3], diseaseDuration: 2 },
    ]
    const summaries = summariseStates(buildStore(records))
    expect(summaries.find((s) => s.name === "a")?.population).toBe(1)
  })

  it("orders states by frequency at each successive position", () => {
    const order = orderStates(summariseStates(store))
    expect(order.map((id) => store.stateNames[id])).toEqual(["a", "b", "c"])
  })

  it("groups identical sequences and sorts by size", () => {
    const typologies = buildTypologies(store)
    expect(typologies.map((t) => t.key)).toEqual(["a-b-c", "a-c"])
    expect(typologies[0]?.size).toBe(2)
    expect(Array.from(typologies[0]?.patients ?? [])).toEqual([0, 2])
    expect(typologies[0]?.share).toBeCloseTo(2 / 3)
  })

  it("does not merge different sequences that share a hash bucket", () => {
    // Same states, different order — must stay distinct.
    const records: PatientRecord[] = [
      { id: "X", trajectory: ["a", "b"], switchEventAge: [1, 2], years: [1, 2], diseaseDuration: 1 },
      { id: "Y", trajectory: ["b", "a"], switchEventAge: [1, 2], years: [1, 2], diseaseDuration: 1 },
    ]
    expect(buildTypologies(buildStore(records))).toHaveLength(2)
  })
})

describe("filtering", () => {
  const { store } = ingest(TSV, "demo.tsv")

  it("starts with everything visible", () => {
    const selection = new Selection(store.patientCount)
    expect(selection.count).toBe(3)
    expect(selection.isEverything).toBe(true)
  })

  it("filters on disease duration without allocating a new dataset", () => {
    const selection = new Selection(store.patientCount)
    const buffer = selection.mask

    applyFilters(store, { ...emptyFilters, diseaseDuration: { min: 30, max: 45 } }, selection)

    expect(selection.mask).toBe(buffer) // same buffer, rewritten in place
    expect(selection.count).toBe(2)
    expect(Array.from(selection.indices())).toEqual([0, 2])
  })

  it("requires a patient's whole span to sit inside the date window", () => {
    const selection = new Selection(store.patientCount)
    applyFilters(store, { ...emptyFilters, year: { min: 1975, max: 2005 } }, selection)
    expect(Array.from(selection.indices())).toEqual([1]) // only P2 (1980–2000)
  })

  it("inverts a filter when asked", () => {
    const selection = new Selection(store.patientCount)
    applyFilters(
      store,
      {
        ...emptyFilters,
        diseaseDuration: { min: 30, max: 45 },
        inverted: { diseaseDuration: true },
      },
      selection,
    )
    expect(Array.from(selection.indices())).toEqual([1])
  })

  it("intersects with a typology selection", () => {
    const selection = new Selection(store.patientCount)
    applyFilters(store, emptyFilters, selection)
    const typologies = buildTypologies(store)
    const abc = typologies.find((t) => t.key === "a-b-c")

    intersectTypologies(selection, [abc?.patients ?? new Uint32Array()])
    expect(Array.from(selection.indices())).toEqual([0, 2])
  })

  it("reports the event count a selection will draw", () => {
    const selection = new Selection(store.patientCount)
    applyFilters(store, { ...emptyFilters, diseaseDuration: { min: 15, max: 25 } }, selection)
    expect(selection.eventCount(store)).toBe(2) // P2 only
  })
})

describe("geometry", () => {
  const { store } = ingest(TSV, "demo.tsv")
  const order = orderStates(summariseStates(store)).map(Number)
  const rowOf = rowLookup(store.stateNames.length, order)
  const palette = buildPalette(store.stateNames.length)

  it("emits one segment per event with source and target colours", () => {
    const selection = new Selection(store.patientCount)
    const geometry = buildGeometry(store, selection.indices(), {
      axis: "age",
      color: { kind: "state", palette },
      durationRange: null,
    })

    expect(geometry.segmentCount).toBe(store.eventCount)
    expect(geometry.positions).toHaveLength(store.eventCount * 4)

    // P1's first segment: a at 25 → b at 53, carrying *state ids*, not rows.
    const a = store.stateNames.indexOf("a")
    const b = store.stateNames.indexOf("b")
    expect(Array.from(geometry.positions.slice(0, 4))).toEqual([25, a, 53, b])
    // and it is coloured from state a to state b
    expect(Array.from(geometry.colors.slice(0, 3))).toEqual(Array.from(palette.bytes.slice(0, 3)))
    expect(Array.from(geometry.colors.slice(4, 7))).toEqual(Array.from(palette.bytes.slice(4, 7)))
  })

  it("closes each patient with a self-segment", () => {
    const selection = new Selection(store.patientCount)
    const geometry = buildGeometry(store, selection.indices(), {
      axis: "age",
      color: { kind: "state", palette },
      durationRange: null,
    })

    // P1's last event: c → c at age 65.
    const c = store.stateNames.indexOf("c")
    expect(Array.from(geometry.positions.slice(8, 12))).toEqual([65, c, 65, c])
  })

  it("only emits segments for selected patients", () => {
    const selection = new Selection(store.patientCount)
    applyFilters(store, { ...emptyFilters, diseaseDuration: { min: 15, max: 25 } }, selection)

    const geometry = buildGeometry(store, selection.indices(), {
      axis: "age",
      color: { kind: "state", palette },
      durationRange: null,
    })

    expect(geometry.segmentCount).toBe(2)
    expect(new Set(geometry.segmentPatient)).toEqual(new Set([1]))
  })

  it("carries state ids, so a reorder never touches the buffer", () => {
    const selection = new Selection(store.patientCount)
    const geometry = buildGeometry(store, selection.indices(), {
      axis: "age",
      color: { kind: "state", palette },
      durationRange: null,
    })

    // Row order is a view property now: reversing it changes the lookup and
    // leaves every vertex exactly where it was.
    const reversed = rowLookup(store.stateNames.length, [...order].reverse())

    expect(Array.from(geometry.positions)).toEqual(
      Array.from(
        buildGeometry(store, selection.indices(), {
          axis: "age",
          color: { kind: "state", palette },
          durationRange: null,
        }).positions,
      ),
    )
    expect(rowOf[order[0] as number]).toBe(0)
    expect(reversed[order[0] as number]).toBe(order.length - 1)
  })

  it("maps ids to rows through the lookup, which is what the shader samples", () => {
    // Every id in the buffer resolves to a real row under the current ordering.
    const selection = new Selection(store.patientCount)
    const geometry = buildGeometry(store, selection.indices(), {
      axis: "age",
      color: { kind: "state", palette },
      durationRange: null,
    })

    for (let i = 1; i < geometry.positions.length; i += 2) {
      const row = rowOf[geometry.positions[i] as number] as number
      expect(row).toBeGreaterThanOrEqual(0)
      expect(row).toBeLessThan(order.length)
    }
  })

  it("drops segments outside the duration window", () => {
    const selection = new Selection(store.patientCount)
    const geometry = buildGeometry(store, selection.indices(), {
      axis: "age",
      color: { kind: "state", palette },
      durationRange: { min: 0, max: 15 },
    })

    // Every retained non-final segment is inside the window.
    for (let s = 0; s < geometry.segmentCount; s++) {
      const event = geometry.segmentEvent[s] as number
      const patient = geometry.segmentPatient[s] as number
      const isLast = event === (store.offsets[patient + 1] as number) - 1
      if (!isLast) expect(store.durations[event]).toBeLessThanOrEqual(15)
    }
    expect(geometry.segmentCount).toBeLessThan(store.eventCount)
  })
})
