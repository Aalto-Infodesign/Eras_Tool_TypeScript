import { useEffect, useMemo, useRef, useState } from "react"

import { useEras } from "../app/store.ts"

type OrderMode = "start" | "end" | "duration"

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

  const [order, setOrder] = useState<OrderMode>("start")
  const [hovered, setHovered] = useState<number | null>(null)
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

    /*
     * At most one line per device pixel row. A quarter-million lines into 150
     * CSS pixels is a quarter-million draw calls to paint the same band; striding
     * gives the identical picture for the cost of the pixels actually on screen.
     */
    const maxRows = Math.max(1, Math.round(height * dpr))
    const stride = Math.max(1, Math.ceil(rows.count / maxRows))

    context.lineWidth = 1
    context.strokeStyle = "rgba(226, 232, 245, 0.45)"
    context.beginPath()

    for (let i = 0; i < rows.count; i += stride) {
      const at = rows.sorted[i] as number
      if (selected.has(rows.index[at] as number)) continue

      const y = (i / rows.count) * height + 0.5
      context.moveTo(toX(rows.from[at] as number), y)
      context.lineTo(toX(rows.to[at] as number), y)
    }
    context.stroke()

    // Selected patients are drawn unstrided, so a selection of one never falls
    // between two sampled rows and vanishes.
    if (selected.size > 0) {
      context.strokeStyle = "hsl(200 90% 60%)"
      context.beginPath()
      for (let i = 0; i < rows.count; i++) {
        const at = rows.sorted[i] as number
        if (!selected.has(rows.index[at] as number)) continue
        const y = (i / rows.count) * height + 0.5
        context.moveTo(toX(rows.from[at] as number), y)
        context.lineTo(toX(rows.to[at] as number), y)
      }
      context.stroke()
    }

    if (hovered !== null && hovered < rows.count) {
      const at = rows.sorted[hovered] as number
      const y = (hovered / rows.count) * height + 0.5
      context.strokeStyle = "hsl(200 90% 72%)"
      context.lineWidth = 2
      context.beginPath()
      context.moveTo(toX(rows.from[at] as number), y)
      context.lineTo(toX(rows.to[at] as number), y)
      context.stroke()
    }
  }, [rows, width, height, domain, selectedPatients, hovered])

  if (store === null || rows === null) return null

  const rowAt = (clientY: number, element: HTMLElement): number | null => {
    const rect = element.getBoundingClientRect()
    const ratio = (clientY - rect.top) / rect.height
    if (ratio < 0 || ratio >= 1 || rows.count === 0) return null
    return Math.min(rows.count - 1, Math.floor(ratio * rows.count))
  }

  const hoveredPatient =
    hovered === null ? null : (rows.index[rows.sorted[hovered] as number] as number)

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
        style={{ width, height }}
        onPointerMove={(event) => {
          const row = rowAt(event.clientY, event.currentTarget)
          setHovered(row)
          setHoveredPatient(
            row === null ? null : (rows.index[rows.sorted[row] as number] as number),
          )
        }}
        onPointerLeave={() => {
          setHovered(null)
          setHoveredPatient(null)
        }}
        onPointerDown={() => {
          if (hoveredPatient !== null) togglePatient(hoveredPatient)
        }}
      >
        <canvas ref={canvasRef} style={{ width, height }} />
      </div>

      <p className="stacked__readout">
        {hoveredPatient === null ? (
          `${rows.count.toLocaleString()} in view`
        ) : (
          <>
            <b>{store.ids.at(hoveredPatient)}</b>
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
