import { useEffect, useRef, useState } from "react"

import { createRenderer } from "../core/render/createRenderer.ts"
import type { RendererKind, TrajectoryRenderer } from "../core/render/Renderer.ts"

export interface Size {
  readonly width: number
  readonly height: number
}

/**
 * Creates (and recreates on backend change) a renderer bound to a canvas.
 *
 * Takes the *element*, not a ref to it. A ref object is referentially stable, so
 * an effect that depends on it never re-runs — which is fine while the element
 * outlives the component and silently wrong the moment it does not. Switching to
 * the small-multiples view unmounts this canvas and switching back mounts a new
 * one; with a ref in the dependency list the renderer stayed bound to the
 * detached original and the chart went blank until a reload. The element is
 * delivered by a callback ref, so React tells us when it changes.
 */
export function useRenderer(
  canvas: HTMLCanvasElement | null,
  kind: RendererKind,
): TrajectoryRenderer | null {
  const [renderer, setRenderer] = useState<TrajectoryRenderer | null>(null)

  useEffect(() => {
    if (canvas === null) {
      setRenderer(null)
      return
    }

    const instance = createRenderer(canvas, kind)
    setRenderer(instance)

    return () => {
      instance.dispose()
      setRenderer(null)
    }
  }, [canvas, kind])

  return renderer
}

/**
 * Element size in CSS pixels, kept live by a ResizeObserver.
 *
 * Takes the element for the same reason `useRenderer` does: a ref object never
 * changes identity, so the observer would stay attached to whichever element
 * happened to be mounted first.
 */
export function useElementSize(element: HTMLElement | null): Size {
  const [size, setSize] = useState<Size>({ width: 0, height: 0 })

  useEffect(() => {
    if (element === null) {
      setSize({ width: 0, height: 0 })
      return
    }

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
  }, [element])

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
