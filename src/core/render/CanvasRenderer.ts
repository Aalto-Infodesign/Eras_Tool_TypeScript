import type { Geometry } from "./geometry.ts"
import { RendererError, type TrajectoryRenderer, type ViewState } from "./Renderer.ts"

/**
 * Canvas2D backend — the control in the experiment, and the fallback where
 * WebGL2 is unavailable.
 *
 * It consumes the same `Geometry` as the GPU path, so a like-for-like comparison
 * is one enum change. The one concession to Canvas2D's cost model: segments are
 * batched into a single `Path2D` per source-state colour, because `stroke()` is
 * the expensive call and a per-segment gradient would mean one
 * `createLinearGradient` per line. Colour therefore steps at the midpoint rather
 * than blending — visually close at hairline widths, and it keeps the number of
 * stroke calls at `stateCount` instead of `segmentCount`.
 */
export class CanvasRenderer implements TrajectoryRenderer {
  readonly kind = "canvas2d" as const

  private readonly ctx: CanvasRenderingContext2D
  private geometry: Geometry | null = null
  private overlay: Geometry | null = null
  private dpr = 1
  private width = 1
  private height = 1
  /** stateId → row; replaced whole on every reorder, including mid-animation. */
  private rows: Float32Array = new Float32Array()

  constructor(private readonly canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext("2d", { alpha: true, desynchronized: true })
    if (ctx === null) throw new RendererError("Canvas2D is not available")
    this.ctx = ctx
  }

  resize(width: number, height: number, dpr: number): void {
    this.dpr = dpr
    this.width = Math.max(1, Math.round(width * dpr))
    this.height = Math.max(1, Math.round(height * dpr))
    if (this.canvas.width !== this.width || this.canvas.height !== this.height) {
      this.canvas.width = this.width
      this.canvas.height = this.height
    }
  }

  /** The same lookup the GPU path samples from a texture; here it is just an array. */
  setRowLookup(rows: Float32Array): void {
    this.rows = rows
  }

  setGeometry(geometry: Geometry | null): void {
    this.geometry = geometry
  }

  setOverlayGeometry(geometry: Geometry | null): void {
    this.overlay = geometry
  }

  draw(view: ViewState): void {
    const { ctx } = this
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, this.width, this.height)

    // A faded bulk layer is opaque in a pre-mixed colour, so crossings land on
    // the same value instead of stacking. See `ViewState.bulkFade`.
    const fading = view.bulkFade > 0
    this.paint(this.geometry, view, fading ? 1 : view.opacity, view.lineWidth, view.bulkFade)
    // Canvas2D gets spine thickness for free — unlike WebGL, `lineWidth` works.
    this.paint(this.overlay, view, view.overlayOpacity, view.overlayWidth, 0)
  }

  private paint(
    geometry: Geometry | null,
    view: ViewState,
    opacity: number,
    lineWidth: number,
    fade: number,
  ): void {
    const { ctx } = this
    if (geometry === null || geometry.segmentCount === 0 || opacity <= 0) return

    const [x0, x1] = view.xDomain
    const span = Math.max(x1 - x0, 1e-6)
    const xFactor = this.width / span

    const marginY = view.marginY * this.dpr
    const usable = Math.max(this.height - 2 * marginY, 1)
    const rowHeight = usable / Math.max(view.rowCount, 1)

    ctx.globalAlpha = opacity
    ctx.lineWidth = lineWidth * this.dpr
    ctx.lineCap = "butt"

    // One sub-path per colour. Keyed on the packed RGB so states sharing a
    // colour (they do not, today) would still collapse into one stroke.
    const paths = new Map<number, Path2D>()
    const pathFor = (rgb: number): Path2D => {
      let path = paths.get(rgb)
      if (path === undefined) {
        path = new Path2D()
        paths.set(rgb, path)
      }
      return path
    }

    const { positions, colors, segmentCount } = geometry
    const rows = this.rows

    for (let s = 0; s < segmentCount; s++) {
      const p = s * 4
      const c = s * 8

      // `positions.y` is a state id; the row it sits on is a view property.
      const ax = ((positions[p] as number) - x0) * xFactor
      const ay = marginY + ((rows[positions[p + 1] as number] ?? 0) + 0.5) * rowHeight
      const bx = ((positions[p + 2] as number) - x0) * xFactor
      const by = marginY + ((rows[positions[p + 3] as number] ?? 0) + 0.5) * rowHeight

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
      ctx.strokeStyle = `#${(fade > 0 ? mixToward(rgb, view.background, fade) : rgb)
        .toString(16)
        .padStart(6, "0")}`
      ctx.stroke(path)
    }

    ctx.globalAlpha = 1
  }

  /**
   * Canvas2D cannot answer this from what it drew — there is no id buffer to read
   * back. The chart falls back to the CPU `SegmentIndex` when this returns `null`.
   */
  pickAt(): number | null {
    return null
  }

  dispose(): void {
    this.geometry = null
    this.overlay = null
  }
}

/** Packed RGB mixed toward a 0–1 background colour. */
function mixToward(rgb: number, background: readonly [number, number, number], fade: number): number {
  const mix = (channel: number, target: number): number =>
    Math.round(channel + (target * 255 - channel) * fade)

  const r = mix((rgb >> 16) & 255, background[0])
  const g = mix((rgb >> 8) & 255, background[1])
  const b = mix(rgb & 255, background[2])
  return (r << 16) | (g << 8) | b
}
