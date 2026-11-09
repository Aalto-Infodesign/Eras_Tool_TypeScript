import { useEffect, useRef } from "react"

import { useEras } from "../app/store.ts"
import { buildPalette, type Palette } from "../core/render/palette.ts"
import type { TrajectoryStore } from "../core/types.ts"

/**
 * Every individual in the cohort as one cell of a full-screen grid.
 *
 * The level of detail follows from how much screen each individual gets, in
 * device pixels:
 *
 * - `lines`  — a cell of at least LINE_MIN_CSS px: the individual's trajectory
 *              as a short strip, one coloured segment per event.
 * - `blocks` — 1 px up to that: a square in the colour of the last state.
 * - `pixels` — under 1 px: several individuals share a pixel, which takes the
 *              average of their colours.
 *
 * The base layer is painted once into an `ImageData` (one write per pixel, no
 * per-shape canvas calls) and only repainted on resize or a new store. The
 * pointer only touches a second, overlay canvas: a ring on the snapped cell,
 * a magnified lens when cells are too small to aim at, and the FinnGen id.
 * Snapping is arithmetic on the grid, so it costs the same at any cohort size.
 */

const LINE_MIN_CSS = 6
const MAX_CELL_CSS = 24
const LENS_CELLS = 11 // odd, so the snapped cell sits in the middle
const LENS_SIZE_CSS = 132
const MAX_DPR = 2 // a 5K retina buffer at full dpr is ~60 MB of ImageData

type Mode = "lines" | "blocks" | "pixels"

interface Layout {
  readonly mode: Mode
  /** Device px per cell side. 1 in `pixels` mode. */
  readonly cell: number
  /** Individuals per cell. Above 1 only in `pixels` mode. */
  readonly perCell: number
  readonly cols: number
  readonly rows: number
  /** Device px offset that centres the grid. */
  readonly x0: number
  readonly y0: number
}

interface Hit {
  readonly col: number
  readonly row: number
  /** Range in sorted order, `[start, end)`. */
  readonly start: number
  readonly end: number
}

function computeLayout(n: number, width: number, height: number, dpr: number): Layout | null {
  if (n <= 0 || width <= 0 || height <= 0) return null

  const side = Math.sqrt((width * height) / n)
  if (side >= 1) {
    const maxCell = Math.round(MAX_CELL_CSS * dpr)
    const capped = side > maxCell
    let cell = Math.min(Math.floor(side), maxCell)
    let cols = Math.floor(width / cell)
    let rows = Math.ceil(n / cols)
    while (cell > 1 && rows * cell > height) {
      cell--
      cols = Math.floor(width / cell)
      rows = Math.ceil(n / cols)
    }
    if (rows * cell <= height) {
      // A capped cell leaves room to spare: keep the window's proportions
      // rather than one long row.
      if (capped) {
        cols = Math.min(cols, Math.ceil(Math.sqrt((n * width) / height)))
        rows = Math.ceil(n / cols)
      }
      return {
        mode: cell >= LINE_MIN_CSS * dpr ? "lines" : "blocks",
        cell,
        perCell: 1,
        cols,
        rows,
        x0: Math.floor((width - cols * cell) / 2),
        y0: Math.floor((height - rows * cell) / 2),
      }
    }
  }

  const perCell = Math.ceil(n / (width * height))
  const cols = width
  const rows = Math.ceil(Math.ceil(n / perCell) / cols)
  return { mode: "pixels", cell: 1, perCell, cols, rows, x0: 0, y0: Math.floor((height - rows) / 2) }
}

/** State of an individual's last event, `-1` for an empty trajectory. */
function lastState(store: TrajectoryStore, p: number): number {
  const end = store.offsets[p + 1] ?? 0
  const start = store.offsets[p] ?? 0
  return end > start ? (store.stateIds[end - 1] ?? -1) : -1
}

/**
 * Individuals ordered by last state (stable counting sort), so the field reads
 * as bands of colour instead of noise. `order[slot] = patient`.
 */
function sortByLastState(store: TrajectoryStore): Uint32Array {
  const n = store.patientCount
  const buckets = store.stateNames.length + 1 // last bucket: empty trajectories
  const counts = new Uint32Array(buckets + 1)
  const keys = new Uint32Array(n)
  for (let p = 0; p < n; p++) {
    const s = lastState(store, p)
    const key = s < 0 ? buckets - 1 : s
    keys[p] = key
    counts[key + 1]!++
  }
  for (let k = 0; k < buckets; k++) counts[k + 1]! += counts[k]!
  const order = new Uint32Array(n)
  for (let p = 0; p < n; p++) order[counts[keys[p]!]!++] = p
  return order
}

/** Palette as ABGR words, ready to drop into a little-endian `Uint32Array` view. */
function packedPalette(palette: Palette, stateCount: number): Uint32Array {
  const out = new Uint32Array(stateCount + 1)
  for (let s = 0; s < stateCount; s++) {
    const i = s * 4
    out[s] =
      (255 << 24) |
      ((palette.bytes[i + 2] ?? 128) << 16) |
      ((palette.bytes[i + 1] ?? 128) << 8) |
      (palette.bytes[i] ?? 128)
  }
  out[stateCount] = (255 << 24) | (128 << 16) | (128 << 8) | 128 // empty trajectory
  return out
}

function paint(
  image: ImageData,
  layout: Layout,
  store: TrajectoryStore,
  order: Uint32Array,
  colors: Uint32Array,
): void {
  const px = new Uint32Array(image.data.buffer)
  px.fill(0)
  const width = image.width
  const n = store.patientCount
  const empty = colors.length - 1
  const { cell, cols, x0, y0, perCell } = layout

  const colorOf = (p: number): number => {
    const s = lastState(store, p)
    return colors[s < 0 ? empty : s] ?? 0
  }

  if (layout.mode === "pixels") {
    const slots = Math.ceil(n / perCell)
    for (let slot = 0; slot < slots; slot++) {
      let r = 0
      let g = 0
      let b = 0
      const start = slot * perCell
      const end = Math.min(n, start + perCell)
      for (let k = start; k < end; k++) {
        const c = colorOf(order[k]!)
        r += c & 0xff
        g += (c >>> 8) & 0xff
        b += (c >>> 16) & 0xff
      }
      const m = end - start
      const x = x0 + (slot % cols)
      const y = y0 + Math.floor(slot / cols)
      px[y * width + x] =
        ((255 << 24) | (Math.round(b / m) << 16) | (Math.round(g / m) << 8) | Math.round(r / m)) >>> 0
    }
    return
  }

  if (layout.mode === "blocks") {
    const inner = cell >= 3 ? cell - 1 : cell // 1 px gutter once there is room for it
    for (let slot = 0; slot < n; slot++) {
      const c = colorOf(order[slot]!)
      const left = x0 + (slot % cols) * cell
      const top = y0 + Math.floor(slot / cols) * cell
      for (let dy = 0; dy < inner; dy++) {
        const row = (top + dy) * width + left
        px.fill(c, row, row + inner)
      }
    }
    return
  }

  // lines: the trajectory as a strip, events in order, equal widths.
  const gap = Math.max(1, Math.round(cell * 0.25))
  const w = cell - gap
  const h = Math.max(1, Math.round(cell * 0.2))
  const padTop = Math.floor((cell - h) / 2)
  for (let slot = 0; slot < n; slot++) {
    const p = order[slot]!
    const e0 = store.offsets[p] ?? 0
    const len = (store.offsets[p + 1] ?? e0) - e0
    const left = x0 + (slot % cols) * cell + Math.floor(gap / 2)
    const top = y0 + Math.floor(slot / cols) * cell + padTop
    for (let x = 0; x < w; x++) {
      const c =
        len > 0 ? (colors[store.stateIds[e0 + Math.floor((x * len) / w)] ?? empty] ?? 0) : colors[empty]!
      for (let dy = 0; dy < h; dy++) px[(top + dy) * width + left + x] = c
    }
  }
}

function hitTest(layout: Layout, n: number, dx: number, dy: number): Hit | null {
  const col = Math.floor((dx - layout.x0) / layout.cell)
  const row = Math.floor((dy - layout.y0) / layout.cell)
  if (col < 0 || row < 0 || col >= layout.cols || row >= layout.rows) return null
  const start = (row * layout.cols + col) * layout.perCell
  if (start >= n) return null
  return { col, row, start, end: Math.min(n, start + layout.perCell) }
}

export function CohortGrid(): React.JSX.Element | null {
  const store = useEras((s) => s.store)
  const baseRef = useRef<HTMLCanvasElement>(null)
  const overlayRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const base = baseRef.current
    const overlay = overlayRef.current
    const bctx = base?.getContext("2d")
    const octx = overlay?.getContext("2d")
    if (!store || !base || !overlay || !bctx || !octx) return

    const n = store.patientCount
    const stateCount = store.stateNames.length
    const palette = buildPalette(stateCount)
    const colors = packedPalette(palette, stateCount)
    const order = sortByLastState(store)

    let dpr = 1
    let layout: Layout | null = null
    let pointer: { x: number; y: number } | null = null // device px
    let frame = 0

    const styles = getComputedStyle(base)
    const text = styles.getPropertyValue("--text").trim() || "#eee"
    const bg = styles.getPropertyValue("--bg").trim() || "#111"
    const font = styles.fontFamily || "system-ui, sans-serif"

    const drawOverlay = (): void => {
      frame = 0
      octx.clearRect(0, 0, overlay.width, overlay.height)
      if (!layout || !pointer) return
      const hit = hitTest(layout, n, pointer.x, pointer.y)
      if (!hit) return

      const { cell } = layout
      const cx = layout.x0 + hit.col * cell
      const cy = layout.y0 + hit.row * cell

      // Small cells: a nearest-neighbour lens of the surrounding cells,
      // read straight from the (undimmed) base canvas.
      const small = cell < LINE_MIN_CSS * dpr
      const lensSize = Math.round(LENS_SIZE_CSS * dpr)
      let lensX = 0
      let lensY = 0
      if (small) {
        const half = Math.floor(LENS_CELLS / 2)
        const src = LENS_CELLS * cell
        lensX = Math.min(pointer.x + 16 * dpr, overlay.width - lensSize - 8 * dpr)
        lensY = Math.max(8 * dpr, pointer.y - lensSize - 16 * dpr)
        octx.imageSmoothingEnabled = false
        octx.fillStyle = bg
        octx.fillRect(lensX, lensY, lensSize, lensSize)
        octx.drawImage(base, cx - half * cell, cy - half * cell, src, src, lensX, lensY, lensSize, lensSize)
        const zoom = lensSize / src
        octx.strokeStyle = text
        octx.lineWidth = Math.max(1, dpr)
        octx.strokeRect(lensX, lensY, lensSize, lensSize)
        octx.strokeRect(lensX + half * cell * zoom, lensY + half * cell * zoom, cell * zoom, cell * zoom)
      }

      // The snapped cell itself, redrawn at full strength with a ring.
      octx.drawImage(base, cx, cy, cell, cell, cx, cy, cell, cell)
      octx.strokeStyle = text
      octx.lineWidth = Math.max(1, dpr)
      const ring = Math.max(2 * dpr, cell * 0.15)
      octx.strokeRect(cx - ring, cy - ring, cell + 2 * ring, cell + 2 * ring)

      // Label.
      const p = order[hit.start]!
      const count = hit.end - hit.start
      const state = lastState(store, p)
      const events = (store.offsets[p + 1] ?? 0) - (store.offsets[p] ?? 0)
      const lines =
        count > 1
          ? [`${store.ids.at(p)} +${(count - 1).toLocaleString()} more`, `${count.toLocaleString()} individuals in this pixel`]
          : [
              store.ids.at(p),
              `${events} event${events === 1 ? "" : "s"} · last: ${state >= 0 ? store.stateNames[state] : "—"}`,
            ]
      const size = 12 * dpr
      octx.font = `600 ${size}px ${font}`
      const pad = 6 * dpr
      const lineH = size * 1.35
      const boxW = Math.max(...lines.map((l) => octx.measureText(l).width)) + pad * 2
      const boxH = lines.length * lineH + pad * 2 - (lineH - size)
      let bx = small ? lensX : pointer.x + 14 * dpr
      let by = small ? lensY + lensSize + 6 * dpr : pointer.y + 14 * dpr
      bx = Math.min(Math.max(bx, 4 * dpr), overlay.width - boxW - 4 * dpr)
      by = Math.min(Math.max(by, 4 * dpr), overlay.height - boxH - 4 * dpr)
      octx.globalAlpha = 0.92
      octx.fillStyle = bg
      octx.fillRect(bx, by, boxW, boxH)
      octx.globalAlpha = 1
      octx.fillStyle = text
      octx.textBaseline = "top"
      lines.forEach((l, i) => {
        if (i === 1) octx.font = `400 ${size}px ${font}`
        octx.fillText(l, bx + pad, by + pad + i * lineH)
      })
    }
    const schedule = (): void => {
      if (!frame) frame = requestAnimationFrame(drawOverlay)
    }

    const resize = (): void => {
      dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR)
      const w = Math.round(base.clientWidth * dpr)
      const h = Math.round(base.clientHeight * dpr)
      if (w === 0 || h === 0) return
      base.width = overlay.width = w
      base.height = overlay.height = h
      layout = computeLayout(n, w, h, dpr)
      if (!layout) return
      const image = bctx.createImageData(w, h)
      paint(image, layout, store, order, colors)
      bctx.putImageData(image, 0, 0)
      schedule()
    }

    const onMove = (e: PointerEvent): void => {
      // Leave buttons, inputs and dialogs to themselves.
      const target = e.target as Element | null
      if (target?.closest("button, a, input, select, textarea, dialog, [role='dialog']")) {
        pointer = null
      } else {
        const r = overlay.getBoundingClientRect()
        pointer = { x: (e.clientX - r.left) * dpr, y: (e.clientY - r.top) * dpr }
      }
      schedule()
    }
    const onLeave = (): void => {
      pointer = null
      schedule()
    }

    const observer = new ResizeObserver(resize) // fires once on observe
    observer.observe(base)
    window.addEventListener("pointermove", onMove)
    document.documentElement.addEventListener("pointerleave", onLeave)

    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      window.removeEventListener("pointermove", onMove)
      document.documentElement.removeEventListener("pointerleave", onLeave)
    }
  }, [store])

  if (!store) return null
  return (
    <div className="cohort-grid" aria-hidden="true">
      <canvas ref={baseRef} className="cohort-grid__base" />
      <canvas ref={overlayRef} className="cohort-grid__overlay" />
    </div>
  )
}
