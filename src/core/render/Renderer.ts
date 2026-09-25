import type { Geometry } from "./geometry.ts"

export type RendererKind = "webgl2" | "canvas2d"

export interface ViewState {
  /** Data-space x window. Narrowing it is a zoom — no geometry rebuild. */
  readonly xDomain: readonly [number, number]
  readonly rowCount: number
  /** Vertical padding in CSS pixels, above and below the band area. */
  readonly marginY: number
  /** Per-line alpha. Low values turn overplotting into a density field. */
  readonly opacity: number
  /**
   * How far the bulk layer is flattened toward `background`. `0` leaves it as
   * the density field; above that it becomes a flat backdrop.
   *
   * This is *not* the same as lowering `opacity`, and the difference is the
   * whole point. Alpha accumulates: two faint lines crossing are darker than
   * one, which is exactly what makes the density readable — and exactly what
   * ruins it as a backdrop, because the dense regions stay dark enough to
   * compete with whatever is drawn on top. Mixing the colour toward the
   * background and drawing it opaque gives every line the same value however
   * many others it crosses, so the layer reads as one faded sheet.
   */
  readonly bulkFade: number
  /** The chart's own background, as 0–1 RGB. What `bulkFade` mixes toward. */
  readonly background: readonly [number, number, number]
  readonly lineWidth: number
  /** Medoid spine layer: drawn over the bulk, opaque and thick. */
  readonly overlayOpacity: number
  /** Spine width in CSS pixels. */
  readonly overlayWidth: number
}

export interface TrajectoryRenderer {
  readonly kind: RendererKind
  /** CSS pixel size plus device pixel ratio. */
  resize(width: number, height: number, dpr: number): void
  setGeometry(geometry: Geometry | null): void
  /**
   * `rows[stateId]` → vertical band, fractional during a reorder animation.
   *
   * Kept out of the vertex buffers on purpose: this is a few dozen floats that
   * change whenever the user reorders a row, where the buffers are megabytes
   * that only change when the *data* does. Uploading it separately is what lets
   * a reorder animate without touching the geometry at all.
   */
  setRowLookup(rows: Float32Array): void
  /**
   * A second, much smaller geometry drawn on top of the bulk layer without
   * clearing it — the cluster medoid spines. Kept as its own slot so toggling
   * spines never rebuilds or re-uploads the bulk buffers.
   */
  setOverlayGeometry(geometry: Geometry | null): void
  draw(view: ViewState): void
  /**
   * Segment index under a CSS-pixel position, or `null`.
   *
   * Backends that can answer this from what they already draw (the GPU path)
   * implement it; the Canvas2D path returns `null` and the chart falls back to
   * a CPU spatial index.
   */
  pickAt(x: number, y: number, view: ViewState, radius: number): number | null
  dispose(): void
}

export class RendererError extends Error {}
