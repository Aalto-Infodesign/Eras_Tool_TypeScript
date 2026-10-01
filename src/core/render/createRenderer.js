import { CanvasRenderer } from "./CanvasRenderer.ts";
import { WebGLRenderer } from "./WebGLRenderer.ts";
/** Falls back to Canvas2D when WebGL2 is unavailable or the context is lost. */
export function createRenderer(canvas, preferred) {
    if (preferred === "canvas2d")
        return new CanvasRenderer(canvas);
    try {
        return new WebGLRenderer(canvas);
    }
    catch (error) {
        console.warn("WebGL2 unavailable, falling back to Canvas2D:", error);
        return new CanvasRenderer(canvas);
    }
}
