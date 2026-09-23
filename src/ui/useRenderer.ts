import { useEffect, useRef, useState } from "react"

import { createRenderer } from "../core/render/createRenderer.ts"
import type { RendererKind, TrajectoryRenderer } from "../core/render/Renderer.ts"

export interface Size {
  readonly width: number
  readonly height: number
}

/** Creates (and recreates on backend change) a renderer bound to a canvas. */
export function useRenderer(
  canvasRef: React.RefObject<HTMLCanvasElement | null>,
  kind: RendererKind,
): TrajectoryRenderer | null {
  const [renderer, setRenderer] = useState<TrajectoryRenderer | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (canvas === null) return

    const instance = createRenderer(canvas, kind)
    setRenderer(instance)

    return () => {
      instance.dispose()
      setRenderer(null)
    }
  }, [canvasRef, kind])

  return renderer
}

/** Element size in CSS pixels, kept live by a ResizeObserver. */
export function useElementSize(ref: React.RefObject<HTMLElement | null>): Size {
  const [size, setSize] = useState<Size>({ width: 0, height: 0 })

  useEffect(() => {
    const element = ref.current
    if (element === null) return

    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect
      if (rect === undefined) return
      setSize((previous) =>
        previous.width === rect.width && previous.height === rect.height
          ? previous
          : { width: rect.width, height: rect.height },
      )
    })

    observer.observe(element)
    return () => observer.disconnect()
  }, [ref])

  return size
}

/**
 * Rolling frame time of the draw loop.
 *
 * Reported through a ref rather than state so the HUD can sample it without
 * re-rendering the chart on every frame — the mistake that makes most FPS
 * counters cost more than the thing they measure.
 */
export function useFrameClock(): {
  readonly ref: React.RefObject<number>
  mark(ms: number): void
} {
  const ref = useRef(0)
  return {
    ref,
    mark(ms: number) {
      // Exponential moving average; stable enough to read, quick to react.
      ref.current = ref.current === 0 ? ms : ref.current * 0.9 + ms * 0.1
    },
  }
}
