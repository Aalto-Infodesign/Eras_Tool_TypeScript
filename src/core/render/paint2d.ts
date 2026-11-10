import type { Geometry } from "./geometry.ts"

/**
 * Painting a `Geometry` into a rectangle of a 2D context.
 *
 * Pulled out of `CanvasRenderer` when the small-multiples view arrived: that
 * view is a grid of charts sharing one canvas, so it needs the same drawing
 * against a sub-rectangle and its own row ordering per panel. Two copies of this
 * loop would have been two places for the colour batching, the row lookup and
 * the fade to drift apart.
 *
 * The one concession to Canvas2D's cost model is here: segments are batched into
 * a single `Path2D` per source-state colour, because `stroke()` is the expensive
 * call and a per-segment gradient would mean one `createLinearGradient` per
 * line. Colour therefore steps at the midpoint rather than blending — visually
 * close at hairline widths, and it keeps the number of stroke calls at
 * `stateCount` rather than `segmentCount`. Where the rows are the steps of one
 * shared sequence, `rowColors` gets the real blend back for free; see there.
 */
export interface PaintTarget {
  /** Device pixels, relative to the canvas origin. */
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface PaintOptions {
  readonly target: PaintTarget
  readonly xDomain: readonly [number, number]
  /** `rows[stateId]` → band within this target. */
  readonly rows: Float32Array
  readonly rowCount: number
  /** Device pixels, inside `target`, above and below the bands. */
  readonly marginY: number
  readonly opacity: number
  /** Device pixels. */
  readonly lineWidth: number
  /** Mixes every colour toward `background` and draws opaque. See `ViewState`. */
  readonly fade: number
  readonly background: readonly [number, number, number]
  /**
   * Row → CSS colour. When given, segments are batched by *row* and each batch
   * is stroked with a vertical gradient between its two rows' colours, which
   * restores the true source→target blend instead of the midpoint step.
   *
   * Only correct when `positions.y` is a row index and every segment on a row
   * descends to the next one — that is, when rows are the steps of one shared
   * sequence, which is exactly the small-multiples case. Under the shared state
   * order a segment can run between any two rows, so the colour transition is
   * not a function of y and this would be wrong.
   */
  readonly rowColors?: readonly string[]
}

export function paintGeometry(
  ctx: CanvasRenderingContext2D,
  geometry: Geometry | null,
  options: PaintOptions,
): void {
  if (geometry === null || geometry.segmentCount === 0) return
  const { target, xDomain, rows, rowCount, marginY, opacity, lineWidth, fade, background } = options
  const { rowColors } = options
  if (opacity <= 0) return

  const [x0, x1] = xDomain
  const span = Math.max(x1 - x0, 1e-6)
  const xFactor = target.width / span

  const usable = Math.max(target.height - 2 * marginY, 1)
  const rowHeight = usable / Math.max(rowCount, 1)

  ctx.globalAlpha = opacity
  ctx.lineWidth = lineWidth
  ctx.lineCap = "butt"

  const { positions, colors, segmentCount } = geometry
  const yOf = (row: number): number => target.y + marginY + (row + 0.5) * rowHeight

  if (rowColors !== undefined) {
    /*
     * One path and one gradient per *step*.
     *
     * Every segment on step `i` runs from row `i` to row `i + 1`, so the colour
     * transition is a function of y alone — and because y is affine along the
     * segment, a vertical gradient between the two rows reproduces the GPU's
     * per-vertex interpolation exactly rather than approximating it. The cost is
     * one gradient per step (single digits), not one per segment.
     */
    const byRow = new Map<number, Path2D>()

    for (let s = 0; s < segmentCount; s++) {
      const p = s * 4
      const row = positions[p + 1] as number

      let path = byRow.get(row)
      if (path === undefined) {
        path = new Path2D()
        byRow.set(row, path)
      }

      path.moveTo(target.x + ((positions[p] as number) - x0) * xFactor, yOf(row))
      path.lineTo(
        target.x + ((positions[p + 2] as number) - x0) * xFactor,
        yOf(positions[p + 3] as number),
      )
    }

    Array.from(byRow).forEach(([row, path], i) => {
      const from = rowColors[row] ?? "currentColor"
      // const to = rowColors[row + 1] ?? from
      const to =
        i !== Array.from(byRow).length - 1 ? "hsl(230 16% 13%)" : (rowColors[row + 1] ?? from)

      if (from === to) {
        // A patient's single-event mark lies flat on its row, and a gradient
        // with no height to run down is a no-op the spec leaves undefined.
        ctx.strokeStyle = from
      } else {
        const gradient = ctx.createLinearGradient(0, yOf(row), 0, yOf(row + 1))
        const firstStop = i === Array.from(byRow).length - 1 ? 0.4 : 0.88
        gradient.addColorStop(firstStop, from)
        gradient.addColorStop(1, to)
        ctx.strokeStyle = gradient
      }
      ctx.stroke(path)
    })

    ctx.globalAlpha = 1
    return
  }

  const paths = new Map<number, Path2D>()
  const pathFor = (rgb: number): Path2D => {
    let path = paths.get(rgb)
    if (path === undefined) {
      path = new Path2D()
      paths.set(rgb, path)
    }
    return path
  }

  for (let s = 0; s < segmentCount; s++) {
    const p = s * 4
    const c = s * 8

    // `positions.y` is a state id; the row it sits on is a view property, and in
    // the small-multiples grid a different one in every panel.
    const ax = target.x + ((positions[p] as number) - x0) * xFactor
    const ay = yOf(rows[positions[p + 1] as number] ?? 0)
    const bx = target.x + ((positions[p + 2] as number) - x0) * xFactor
    const by = yOf(rows[positions[p + 3] as number] ?? 0)

    const mx = (ax + bx) / 2
    const my = (ay + by) / 2

    const sourceRgb =
      ((colors[c] as number) << 16) | ((colors[c + 1] as number) << 8) | (colors[c + 2] as number)
    const targetRgb =
      ((colors[c + 4] as number) << 16) |
      ((colors[c + 5] as number) << 8) |
      (colors[c + 6] as number)

    const first = pathFor(sourceRgb)
    first.moveTo(ax, ay)
    first.lineTo(mx, my)

    const second = pathFor(targetRgb)
    second.moveTo(mx, my)
    second.lineTo(bx, by)
  }

  for (const [rgb, path] of paths) {
    // Mixed once per colour rather than per segment — there are a handful of
    // states and up to a million segments.
    ctx.strokeStyle = `#${(fade > 0 ? mixToward(rgb, background, fade) : rgb)
      .toString(16)
      .padStart(6, "0")}`
    ctx.stroke(path)
  }

  ctx.globalAlpha = 1
}

/** Packed RGB mixed toward a 0–1 background colour. */
export function mixToward(
  rgb: number,
  background: readonly [number, number, number],
  fade: number,
): number {
  const mix = (channel: number, target: number): number =>
    Math.round(channel + (target * 255 - channel) * fade)

  const r = mix((rgb >> 16) & 255, background[0])
  const g = mix((rgb >> 8) & 255, background[1])
  const b = mix(rgb & 255, background[2])
  return (r << 16) | (g << 8) | b
}
