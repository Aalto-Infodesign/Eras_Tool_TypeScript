import { useEffect, useMemo, useRef, useState } from "react"

import { useEras } from "../app/store.ts"
import { clusterMembers } from "../core/cluster/medoids.ts"
import { createHoverSettler } from "./hover.ts"
import { useClusterRun } from "./useClusterRun.ts"

type OrderMode = "start" | "end" | "duration"

/** How near, in CSS pixels, the pointer has to be to a medoid row to catch it. */
const PICK_PX = 5

/**
 * The four weights the preview is drawn at.
 *
 * The same hierarchy as the chart, in greyscale: the field is context, the
 * spines are the summary of it, and what the pointer is asking about comes
 * forward while everything else steps back. Only the third of these is new —
 * without it a medoid row is one hairline among a quarter of a million, which is
 * not a thing anyone can aim at.
 */
const FIELD = 0.3
const FIELD_DIMMED = 0.08
const MEMBER = 0.5
const MEDOID_DIMMED = 0.28

const ORDERS: readonly { value: OrderMode; label: string }[] = [
  { value: "start", label: "start" },
  { value: "end", label: "end" },
  { value: "duration", label: "duration" },
]

/**
 * One horizontal line per patient — where their trajectory starts and ends —
 * stacked vertically and sortable by either end or by disease duration.
 *
 * It answers a question the chart deliberately cannot: the chart stacks patients
 * by *state*, so it says nothing about how the cohort is distributed in time.
 * Sorted by start, this is the recruitment curve; sorted by duration, it is the
 * survival-style shape of the cohort. Re-sorting is the whole interaction, which
 * is why the original made the order a control rather than a setting.
 *
 * Canvas rather than the original's three.js: at one line per patient the draw is
 * a tight loop of `moveTo`/`lineTo` with no geometry to build, and it drops a
 * WebGL context that would otherwise compete with the main chart's.
 */
export function StackedLines({ width, height }: { width: number; height: number }): React.JSX.Element | null {
  const store = useEras((s) => s.store)
  const selection = useEras((s) => s.selection)
  const selectionVersion = useEras((s) => s.selectionVersion)
  const axis = useEras((s) => s.axis)
  const selectedPatients = useEras((s) => s.selectedPatients)
  const togglePatient = useEras((s) => s.togglePatient)
  const setHoveredPatient = useEras((s) => s.setHoveredPatient)
  const showMedoids = useEras((s) => s.layers.medoids)
  const clusterRun = useClusterRun()
  const clusterVersion = useEras((s) => s.clusterVersion)
  const hoveredCluster = useEras((s) => s.hoveredCluster)
  const setHoveredCluster = useEras((s) => s.setHoveredCluster)
  const focusCluster = useEras((s) => s.focusCluster)

  const [order, setOrder] = useState<OrderMode>("start")
  const settler = useMemo(
    () => createHoverSettler<number | null>(setHoveredCluster),
    [setHoveredCluster],
  )
  useEffect(() => () => settler.cancel(), [settler])
  /**
   * The row under the pointer, stamped with the `rows` it indexes.
   *
   * A row is a position in *this* sort of *this* selection, and picking a medoid
   * replaces both: `focusCluster` narrows the selection to one typology, so
   * `rows` is rebuilt at a fraction of its size while the pointer has not moved.
   * A bare index kept from before then points past the end — `hoveredPatient`
   * came out `undefined` rather than `null`, the readout called `toFixed` on
   * nothing, and picking a spine out of the grid took the whole app down. Even
   * an index that happens to stay in range names someone else after a rebuild.
   * So a rebuild drops the hover rather than reinterpreting it, and the next
   * pointer move picks again against the new rows.
   */
  const [pointed, setPointed] = useState<{ readonly rows: unknown; readonly row: number } | null>(
    null,
  )
  const canvasRef = useRef<HTMLCanvasElement>(null)

  /**
   * Visible patients with their span, sorted. Rebuilt only when the selection or
   * the ordering changes — never on hover, which is why hover can be per-frame.
   */
  const rows = useMemo(() => {
    if (store === null || selection === null) return null

    const patients = selection.indices()
    const xs = axis === "age" ? store.ages : store.years

    const index = new Uint32Array(patients.length)
    const from = new Float32Array(patients.length)
    const to = new Float32Array(patients.length)
    const key = new Float32Array(patients.length)

    for (let i = 0; i < patients.length; i++) {
      const p = patients[i] as number
      const start = store.offsets[p] as number
      const end = store.offsets[p + 1] as number
      if (end === start) continue

      let lo = Infinity
      let hi = -Infinity
      for (let e = start; e < end; e++) {
        const v = xs[e] as number
        if (v < lo) lo = v
        if (v > hi) hi = v
      }

      index[i] = p
      from[i] = lo
      to[i] = hi
      key[i] = order === "start" ? lo : order === "end" ? hi : (store.diseaseDuration[p] as number)
    }

    // Sorting an index permutation keeps the four columns aligned without
    // materialising an object per patient.
    const sorted = Array.from({ length: patients.length }, (_, i) => i).sort(
      (a, b) => (key[a] as number) - (key[b] as number),
    )

    return { sorted, index, from, to, count: patients.length }
  }, [store, selection, selectionVersion, axis, order]) // eslint-disable-line react-hooks/exhaustive-deps

  const hovered = pointed !== null && pointed.rows === rows ? pointed.row : null

  /**
   * Which patients are cluster representatives.
   *
   * Gated on the same toggle the chart's spine layer is, so "medoids" means one
   * thing across the app: turn them off and this goes back to being a preview of
   * every individual, with every individual selectable.
   */
  const medoidMask = useMemo<Uint8Array | null>(() => {
    if (store === null || clusterRun === null || !showMedoids) return null
    const mask = new Uint8Array(store.patientCount)
    for (const ref of clusterRun.clusters) mask[ref.medoidPatient] = 1
    return mask
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, clusterRun, clusterVersion, showMedoids])

  /**
   * The rows those patients landed on, ascending — the draw list *and* the hit
   * list.
   *
   * Both need it for the same reason: a medoid is one row in a quarter of a
   * million, so the strided field pass would drop almost all of them and a
   * pointer test against every row would answer with whichever neighbour it
   * happened to land on. Sorting is free — the rows are walked in order.
   */
  const medoidRows = useMemo<Uint32Array>(() => {
    if (rows === null || medoidMask === null) return new Uint32Array()

    const out: number[] = []
    for (let i = 0; i < rows.count; i++) {
      const at = rows.sorted[i] as number
      if (medoidMask[rows.index[at] as number] === 1) out.push(i)
    }
    return Uint32Array.from(out)
  }, [rows, medoidMask])

  /** Everyone the hovered spine stands for, as a mask the draw loop can index. */
  const memberMask = useMemo<Uint8Array | null>(() => {
    if (store === null || clusterRun === null || hoveredCluster === null || !showMedoids) {
      return null
    }
    const mask = new Uint8Array(store.patientCount)
    for (const patient of clusterMembers(clusterRun, [hoveredCluster], null)) mask[patient] = 1
    return mask
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, clusterRun, clusterVersion, hoveredCluster, showMedoids])

  const domain = useMemo<readonly [number, number]>(() => {
    if (store === null) return [0, 1]
    return axis === "age" ? store.extents.age : store.extents.year
  }, [store, axis])

  useEffect(() => {
    const canvas = canvasRef.current
    if (canvas === null || rows === null || width === 0 || height === 0) return

    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.round(width * dpr)
    canvas.height = Math.round(height * dpr)

    const context = canvas.getContext("2d")
    if (context === null) return

    context.setTransform(dpr, 0, 0, dpr, 0, 0)
    context.clearRect(0, 0, width, height)

    const [lo, hi] = domain
    const span = Math.max(hi - lo, 1e-9)
    const toX = (value: number): number => ((value - lo) / span) * width

    const selected = new Set(selectedPatients)
    const dimmed = memberMask !== null

    /** One pass, one style. `y` is the row's band, `at` its column index. */
    const strokeRows = (
      style: string,
      lineWidth: number,
      stride: number,
      keep: (patient: number, row: number) => boolean,
    ): void => {
      context.strokeStyle = style
      context.lineWidth = lineWidth
      context.beginPath()

      for (let i = 0; i < rows.count; i += stride) {
        const at = rows.sorted[i] as number
        const patient = rows.index[at] as number
        if (!keep(patient, i)) continue

        const y = (i / rows.count) * height + 0.5
        context.moveTo(toX(rows.from[at] as number), y)
        context.lineTo(toX(rows.to[at] as number), y)
      }
      context.stroke()
    }

    /*
     * At most one line per device pixel row. A quarter-million lines into 150
     * CSS pixels is a quarter-million draw calls to paint the same band; striding
     * gives the identical picture for the cost of the pixels actually on screen.
     *
     * Only the field is strided. Everything above it is a handful of rows that a
     * stride would drop almost all of — which is the same reason the selection
     * has always been drawn whole.
     */
    const maxRows = Math.max(1, Math.round(height * dpr))
    const stride = Math.max(1, Math.ceil(rows.count / maxRows))

    const field = dimmed ? FIELD_DIMMED : FIELD
    strokeRows(
      `rgba(226, 232, 245, ${field})`,
      1,
      stride,
      (patient) => !selected.has(patient),
    )

    // The people the hovered spine stands for, lifted out of the field they are
    // part of — the same reading as the chart's highlight layer.
    if (memberMask !== null) {
      strokeRows(
        `rgba(226, 232, 245, ${MEMBER})`,
        1,
        1,
        (patient) => memberMask[patient] === 1 && !selected.has(patient),
      )
    }

    /*
     * The spines. Drawn from `medoidRows` rather than by testing every row,
     * because there are a few thousand of them among a quarter of a million.
     */
    if (medoidMask !== null) {
      const accent = dimmed ? MEDOID_DIMMED : 0.95
      context.strokeStyle = `rgba(178, 150, 232, ${accent})`
      context.lineWidth = 1.25
      context.beginPath()

      for (let k = 0; k < medoidRows.length; k++) {
        const i = medoidRows[k] as number
        const at = rows.sorted[i] as number
        if (selected.has(rows.index[at] as number)) continue

        const y = (i / rows.count) * height + 0.5
        context.moveTo(toX(rows.from[at] as number), y)
        context.lineTo(toX(rows.to[at] as number), y)
      }
      context.stroke()
    }

    // Selected patients are drawn unstrided, so a selection of one never falls
    // between two sampled rows and vanishes.
    if (selected.size > 0) {
      strokeRows("hsl(200 90% 60%)", 1, 1, (patient) => selected.has(patient))
    }

    if (hovered !== null && hovered < rows.count) {
      const at = rows.sorted[hovered] as number
      const y = (hovered / rows.count) * height + 0.5
      context.strokeStyle = medoidMask === null ? "hsl(200 90% 72%)" : "hsl(265 75% 82%)"
      context.lineWidth = 2
      context.beginPath()
      context.moveTo(toX(rows.from[at] as number), y)
      context.lineTo(toX(rows.to[at] as number), y)
      context.stroke()
    }
  }, [rows, width, height, domain, selectedPatients, hovered, medoidMask, medoidRows, memberMask])

  if (store === null || rows === null) return null

  /**
   * The row under the pointer — or, with medoids on, the nearest medoid row.
   *
   * A spine is the only thing worth naming here for the same reason it is in the
   * chart: picking one hairline out of a quarter of a million answers with
   * whichever row the pointer happened to land on, where picking a medoid names
   * a group you can isolate, read and export. Snapping rather than requiring a
   * direct hit, because a medoid row is a single pixel and nobody can aim at it.
   */
  const rowAt = (clientY: number, element: HTMLElement): number | null => {
    const rect = element.getBoundingClientRect()
    const ratio = (clientY - rect.top) / rect.height
    if (ratio < 0 || ratio >= 1 || rows.count === 0) return null

    const row = Math.min(rows.count - 1, Math.floor(ratio * rows.count))
    if (medoidMask === null) return row
    if (medoidRows.length === 0) return null

    // Nearest by binary search, since `medoidRows` is built in row order.
    let lo = 0
    let hi = medoidRows.length - 1
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if ((medoidRows[mid] as number) < row) lo = mid + 1
      else hi = mid
    }

    const after = medoidRows[lo] as number
    const before = medoidRows[Math.max(0, lo - 1)] as number
    const nearest = Math.abs(after - row) <= Math.abs(row - before) ? after : before

    // A tolerance in pixels, converted to rows: the band holds `count` rows in
    // `height` pixels, so how forgiving this is depends on how crowded it is.
    const tolerance = Math.max(1, (PICK_PX / Math.max(rect.height, 1)) * rows.count)
    return Math.abs(nearest - row) <= tolerance ? nearest : null
  }

  const clusterAtRow = (row: number | null): number | null => {
    if (row === null || medoidMask === null || clusterRun === null) return null
    const patient = rows.index[rows.sorted[row] as number] as number
    const cluster = clusterRun.clusterOfPatient[patient] ?? -1
    return cluster >= 0 ? cluster : null
  }

  const hoveredPatient =
    hovered === null ? null : (rows.index[rows.sorted[hovered] as number] as number)

  const hoveredRef = (() => {
    const cluster = clusterAtRow(hovered)
    return cluster === null ? undefined : clusterRun?.clusters[cluster]
  })()
  const hoveredSize = hoveredRef?.size ?? null

  return (
    <div className="stacked">
      <div className="stacked__controls">
        {ORDERS.map((option) => (
          <button
            key={option.value}
            type="button"
            className="button button--tiny"
            data-selected={order === option.value}
            onClick={() => setOrder(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>

      <div
        className="stacked__surface"
        data-picking={medoidMask !== null}
        data-on-target={hovered !== null}
        style={{ width, height }}
        onPointerMove={(event) => {
          const row = rowAt(event.clientY, event.currentTarget)
          setPointed(row === null ? null : { rows, row })
          setHoveredPatient(
            row === null ? null : (rows.index[rows.sorted[row] as number] as number),
          )
          // Settled, and shared with the chart: the same store field the chart's
          // own hover writes, so pointing at a spine here lifts that cluster's
          // members out of both views at once.
          settler.queue(clusterAtRow(row))
        }}
        onPointerLeave={() => {
          setPointed(null)
          setHoveredPatient(null)
          settler.cancel()
          setHoveredCluster(null)
        }}
        onPointerDown={() => {
          /*
           * A spine here means its cluster, as everywhere else — and it opens
           * the typology with that cluster isolated, because isolating one while
           * the chart is showing a grid of other typologies would be a change
           * you could not see. Without medoids this is the old behaviour: pin
           * the one patient.
           */
          const cluster = clusterAtRow(hovered)
          const ref = cluster === null ? undefined : clusterRun?.clusters[cluster]
          if (ref !== undefined && cluster !== null) focusCluster(ref.typologyKey, cluster)
          else if (medoidMask === null && hoveredPatient !== null) togglePatient(hoveredPatient)
        }}
      >
        <canvas ref={canvasRef} style={{ width, height }} />
      </div>

      <p className="stacked__readout">
        {hoveredPatient === null ? (
          <span>
            {rows.count.toLocaleString()} in view
            {medoidRows.length > 0 && ` · ${medoidRows.length.toLocaleString()} medoids`}
          </span>
        ) : (
          <>
            <b>{store.ids.at(hoveredPatient)}</b>
            {/* What the row stands for, when it stands for more than itself. */}
            {hoveredSize !== null && <span>{hoveredSize.toLocaleString()} in cluster</span>}
            <span>
              {(rows.from[rows.sorted[hovered as number] as number] as number).toFixed(0)} –{" "}
              {(rows.to[rows.sorted[hovered as number] as number] as number).toFixed(0)}
            </span>
          </>
        )}
      </p>
    </div>
  )
}
