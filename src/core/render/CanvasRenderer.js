import { paintGeometry } from "./paint2d.ts";
import { RendererError } from "./Renderer.ts";
/**
 * Canvas2D backend — the control in the experiment, and the fallback where
 * WebGL2 is unavailable.
 *
 * It consumes the same `Geometry` as the GPU path, so a like-for-like comparison
 * is one enum change. The drawing itself lives in `paint2d.ts`, which the
 * small-multiples grid shares — that view paints the same geometry into a
 * sub-rectangle with its own row ordering per panel.
 */
export class CanvasRenderer {
    canvas;
    kind = "canvas2d";
    ctx;
    geometry = null;
    overlay = null;
    highlight = null;
    focus = null;
    dpr = 1;
    width = 1;
    height = 1;
    /** stateId → row; replaced whole on every reorder, including mid-animation. */
    rows = new Float32Array();
    constructor(canvas) {
        this.canvas = canvas;
        const ctx = canvas.getContext("2d", { alpha: true, desynchronized: true });
        if (ctx === null)
            throw new RendererError("Canvas2D is not available");
        this.ctx = ctx;
    }
    resize(width, height, dpr) {
        this.dpr = dpr;
        this.width = Math.max(1, Math.round(width * dpr));
        this.height = Math.max(1, Math.round(height * dpr));
        if (this.canvas.width !== this.width || this.canvas.height !== this.height) {
            this.canvas.width = this.width;
            this.canvas.height = this.height;
        }
    }
    /** The same lookup the GPU path samples from a texture; here it is just an array. */
    setRowLookup(rows) {
        this.rows = rows;
    }
    setGeometry(geometry) {
        this.geometry = geometry;
    }
    setOverlayGeometry(geometry) {
        this.overlay = geometry;
    }
    setHighlightGeometry(geometry) {
        this.highlight = geometry;
    }
    setFocusGeometry(geometry) {
        this.focus = geometry;
    }
    draw(view) {
        const { ctx } = this;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, this.width, this.height);
        // A faded bulk layer is opaque in a pre-mixed colour, so crossings land on
        // the same value instead of stacking. See `ViewState.bulkFade`.
        const fading = view.bulkFade > 0;
        this.paint(this.geometry, view, fading ? 1 : view.opacity, view.lineWidth, view.bulkFade);
        // The hovered cluster's members, over the flattened field and under the
        // spine they belong to.
        if (view.highlightOpacity > 0) {
            this.paint(this.highlight, view, view.highlightOpacity, view.lineWidth, 0);
        }
        // Canvas2D gets spine thickness for free — unlike WebGL, `lineWidth` works.
        this.paint(this.overlay, view, view.overlayOpacity, view.overlayWidth, view.overlayFade);
        // The one being pointed at, over a layer the same frame has pushed back.
        this.paint(this.focus, view, view.overlayOpacity, view.overlayWidth, 0);
    }
    paint(geometry, view, opacity, lineWidth, fade) {
        paintGeometry(this.ctx, geometry, {
            target: { x: 0, y: 0, width: this.width, height: this.height },
            xDomain: view.xDomain,
            rows: this.rows,
            rowCount: view.rowCount,
            marginY: view.marginY * this.dpr,
            opacity,
            lineWidth: lineWidth * this.dpr,
            fade,
            background: view.background,
        });
    }
    /**
     * Canvas2D cannot answer this from what it drew — there is no id buffer to read
     * back. The chart falls back to the CPU `SegmentIndex` when this returns `null`.
     */
    pickAt() {
        return null;
    }
    dispose() {
        this.geometry = null;
        this.overlay = null;
        this.highlight = null;
        this.focus = null;
    }
}
