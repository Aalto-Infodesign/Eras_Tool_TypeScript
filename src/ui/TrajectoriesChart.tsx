import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { useEras } from "../app/store.ts"
import { SegmentIndex } from "../core/render/picking.ts"
import type { ViewState } from "../core/render/Renderer.ts"
import { ChartGrid } from "./ChartGrid.tsx"
import { LumpLayer } from "./LumpLayer.tsx"
import { StateBoxPlots } from "./StateBoxPlots.tsx"
import { TrajectoryOverlay } from "./TrajectoryOverlay.tsx"
import { useAnimatedView } from "./useAnimatedView.ts"
import { useChartLayers } from "./useChartLayers.ts"
import { useElementSize, useFrameClock, useRenderer } from "./useRenderer.ts"

const MARGIN_Y = 16
/** GPU picking tolerance, in CSS pixels around the cursor. */
const PICK_RADIUS_PX = 4
/** CPU fallback tolerance, normalised: 1 = one state row / the whole x range. */
const PICK_RADIUS_DATA = 0.35
/**
 * Above this, the CPU spatial index costs more to build than hover is worth
 * (~190ms at 1.4M segments) and its buckets are too dense to query in a frame.
 * The GPU path has no such ceiling, so this only ever bites in Canvas2D mode.
 */
const CPU_PICK_LIMIT = 200_000
/**
 * Above this many segments the view stops animating and lands directly.
 *
 * A transition redraws the whole bulk layer every frame, so its cost scales with
 * what is on screen — and past a point the move stutters, which reads worse than
 * no move at all. Segments rather than patients because that is what the draw
 * actually pays for, and it is the number the stats line already reports.
 */
const MAX_ANIMATED_SEGMENTS = 50_000

export function TrajectoriesChart(): React.JSX.Element {
  const stateOrder = useEras((s) => s.visibleStates)
  const axis = useEras((s) => s.axis)
  const rendererKind = useEras((s) => s.rendererKind)
  const opacity = useEras((s) => s.opacity)
  const layers = useEras((s) => s.layers)
  const setHoveredPatient = useEras((s) => s.setHoveredPatient)
  const togglePatient = useEras((s) => s.togglePatient)

  const {
    bulk,
    overlay,
    lumps,
    medoidCount,
    stateStats,
    populationStats,
    rowOf: targetRowOf,
    statePalette,
    buildMs,
    xDomain: targetXDomain,
  } = useChartLayers()

  /*
   * Everything below draws from here, canvas and SVG alike, so the rules, the
   * box plots and the density field move as one. `useChartLayers` keeps feeding
   * the *target*; nothing it builds depends on the tweened value.
   */
  const { xDomain, rows: rowOf, isAnimating } = useAnimatedView(targetXDomain, targetRowOf, {
    enabled: (bulk?.segmentCount ?? 0) <= MAX_ANIMATED_SEGMENTS,
    // Switching between age and calendar changes what an x value *is*, so the
    // old and new domains are not two points on one scale to travel between.
    xUnits: axis,
  })

  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  const size = useElementSize(containerRef)
  const renderer = useRenderer(canvasRef, rendererKind)
  const frame = useFrameClock()

  /**
   * CPU fallback index — only for the Canvas2D backend, which cannot read a
   * segment id back out of what it drew. Built off the critical path and skipped
   * entirely above `CPU_PICK_LIMIT`.
   */
  const needsCpuIndex =
    rendererKind === "canvas2d" && bulk !== null && bulk.segmentCount > 0 && bulk.segmentCount <= CPU_PICK_LIMIT

  const [index, setIndex] = useState<SegmentIndex | null>(null)
  useEffect(() => {
    if (!needsCpuIndex || bulk === null) {
      setIndex(null)
      return
    }

    let cancelled = false
    const schedule =
      typeof requestIdleCallback === "function"
        ? requestIdleCallback
        : (cb: () => void) => window.setTimeout(cb, 0)

    const handle = schedule(() => {
      if (cancelled) return
      setIndex(SegmentIndex.build(bulk, stateOrder.length, targetXDomain, targetRowOf))
    })

    return () => {
      cancelled = true
      if (typeof cancelIdleCallback === "function") cancelIdleCallback(handle as number)
      else window.clearTimeout(handle as number)
    }
  }, [needsCpuIndex, bulk, stateOrder.length, targetXDomain, targetRowOf])

  useEffect(() => {
    renderer?.setGeometry(bulk)
  }, [renderer, bulk])

  useEffect(() => {
    renderer?.setOverlayGeometry(overlay)
  }, [renderer, overlay])

  useEffect(() => {
    renderer?.setRowLookup(rowOf)
  }, [renderer, rowOf])

  const background = useBackgroundColor(containerRef)

  const view = useMemo<ViewState>(
    () => ({
      xDomain,
      rowCount: stateOrder.length,
      marginY: MARGIN_Y,
      /*
       * With the hairlines off, whatever is in the bulk slot is a summary — a
       * thousand spines where the bulk has a million lines, so alpha stacking
       * has nothing left to stack and a low opacity would only make them hard
       * to see. The control bar disables the slider to say so.
       */
      opacity: layers.lines ? opacity : 1,
      lineWidth: layers.lines ? 1 : 2,
      /*
       * The hairlines step back whenever something is drawn over them. The
       * slider still runs in the same direction — low is faint either way — but
       * it now picks how far the colour is mixed into the background rather
       * than how much alpha each line carries, so crossings stop accumulating
       * and the layer reads as one sheet under the overlay.
       */
      bulkFade: layers.lines && (layers.medoids || layers.lumps) ? 1 - opacity : 0,
      background,
      overlayOpacity: 0.95,
      overlayWidth: 2.5,
    }),
    [xDomain, stateOrder.length, opacity, layers, background],
  )

  useEffect(() => {
    if (renderer === null || size.width === 0 || size.height === 0) return

    renderer.resize(size.width, size.height, window.devicePixelRatio || 1)

    const t0 = performance.now()
    renderer.draw(view)
    frame.mark(performance.now() - t0)
  }, [renderer, size.width, size.height, view, bulk, rowOf, frame])

  const toDataSpace = useCallback(
    (px: number, py: number, rect: DOMRect): { x: number; row: number } | null => {
      if (stateOrder.length === 0) return null

      const [x0, x1] = xDomain
      const x = x0 + (px / rect.width) * (x1 - x0)

      const usable = Math.max(rect.height - 2 * MARGIN_Y, 1)
      const row = ((py - MARGIN_Y) / usable) * stateOrder.length - 0.5

      return { x, row }
    },
    [xDomain, stateOrder.length],
  )

  /**
   * GPU first: one scissored draw plus a `readPixels` of a few hundred pixels,
   * independent of how many trajectories are on screen.
   */
  const pickPatient = useCallback(
    (clientX: number, clientY: number): number | null => {
      const element = containerRef.current
      // Hit-testing a moving chart answers for where things were, not where the
      // pointer is; hover simply pauses for the few hundred ms of a transition.
      if (element === null || bulk === null || isAnimating) return null

      const rect = element.getBoundingClientRect()
      const localX = clientX - rect.left
      const localY = clientY - rect.top

      if (renderer !== null) {
        const segment = renderer.pickAt(localX, localY, view, PICK_RADIUS_PX)
        if (segment !== null) return bulk.segmentPatient[segment] ?? null
      }

      if (index === null) return null
      const point = toDataSpace(localX, localY, rect)
      if (point === null) return null
      return index.pick(point.x, point.row, PICK_RADIUS_DATA)?.patient ?? null
    },
    [bulk, renderer, view, index, toDataSpace, isAnimating],
  )

  // Hover is coalesced to one pick per animation frame: a pointer fires many more
  // move events than there are frames, and every extra pick is a GPU round-trip.
  const pendingPick = useRef<{ x: number; y: number } | null>(null)
  const rafHandle = useRef(0)

  const handlePointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      pendingPick.current = { x: event.clientX, y: event.clientY }
      if (rafHandle.current !== 0) return

      rafHandle.current = requestAnimationFrame(() => {
        rafHandle.current = 0
        const point = pendingPick.current
        if (point === null) return
        setHoveredPatient(pickPatient(point.x, point.y))
      })
    },
    [pickPatient, setHoveredPatient],
  )

  useEffect(
    () => () => {
      if (rafHandle.current !== 0) cancelAnimationFrame(rafHandle.current)
    },
    [],
  )

  const handleClick = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const patient = pickPatient(event.clientX, event.clientY)
      if (patient !== null) togglePatient(patient)
    },
    [pickPatient, togglePatient],
  )

  return (
    <div className="chart">
      <div
        ref={containerRef}
        className="chart__surface"
        onPointerMove={handlePointerMove}
        onPointerLeave={() => setHoveredPatient(null)}
        onPointerDown={handleClick}
      >
        <canvas ref={canvasRef} className="chart__canvas" />

        <ChartGrid
          width={size.width}
          height={size.height}
          marginY={MARGIN_Y}
          xDomain={xDomain}
          rowOf={rowOf}
          palette={statePalette}
        />

        <StateBoxPlots
          width={size.width}
          height={size.height}
          marginY={MARGIN_Y}
          xDomain={xDomain}
          rowOf={rowOf}
          stats={stateStats}
          population={populationStats}
          palette={statePalette}
        />

        {layers.lumps && (
          <LumpLayer
            lumps={lumps}
            width={size.width}
            height={size.height}
            marginY={MARGIN_Y}
            xDomain={xDomain}
            rowOf={rowOf}
            rowCount={stateOrder.length}
            palette={statePalette}
          />
        )}

        <TrajectoryOverlay
          width={size.width}
          height={size.height}
          marginY={MARGIN_Y}
          xDomain={xDomain}
          rowOf={rowOf}
          palette={statePalette}
        />
      </div>

      <ChartStats
        rowCount={stateOrder.length}
        segmentCount={bulk?.segmentCount ?? 0}
        lumpCount={lumps.length}
        medoidCount={medoidCount}
        buildMs={buildMs}
        frameRef={frame.ref}
        indexing={needsCpuIndex && index === null}
      />
    </div>
  )
}

function ChartStats({
  rowCount,
  segmentCount,
  lumpCount,
  medoidCount,
  buildMs,
  frameRef,
  indexing,
}: {
  rowCount: number
  segmentCount: number
  lumpCount: number
  medoidCount: number
  buildMs: number
  frameRef: React.RefObject<number>
  indexing: boolean
}): React.JSX.Element {
  const rendererKind = useEras((s) => s.rendererKind)
  const layers = useEras((s) => s.layers)
  const selection = useEras((s) => s.selection)
  const cohortSize = useEras((s) => s.cohortSize)
  const selectionVersion = useEras((s) => s.selectionVersion)

  // Sampled on a timer, not per frame, so the readout never drives the render loop.
  const [frameMs, setFrameMs] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setFrameMs(frameRef.current), 500)
    return () => clearInterval(id)
  }, [frameRef])

  return (
    <div className="chart__stats">
      <span>
        {layers.medoids && (
          <>
            <b>{medoidCount.toLocaleString()}</b> medoids ·{" "}
          </>
        )}
        {layers.lumps && (
          <>
            <b>{lumpCount}</b> lumps ·{" "}
          </>
        )}
        <b>{segmentCount.toLocaleString()}</b> segments
      </span>
      <span>
        geometry <b>{buildMs.toFixed(1)}ms</b>
      </span>
      <span>
        draw <b>{frameMs.toFixed(2)}ms</b>
      </span>
      {/*
        * What the layer was *asked* to draw, beside what it drew. When the two
        * disagree — patients selected but no segments — the fault is between
        * the store and the buffers, and this says so without a debugger.
        */}
      <span key={selectionVersion}>
        <b>{(selection?.count ?? 0).toLocaleString()}</b> / {cohortSize.toLocaleString()} patients
      </span>
      <span>
        <b>{rowCount}</b> rows
      </span>
      <span className="chart__stats-kind">{rendererKind}</span>
      {indexing && <span className="chart__stats-pending">indexing…</span>}
    </div>
  )
}

/**
 * The chart surface's own background colour, as 0–1 RGB.
 *
 * Read from the element rather than hard-coded, so the fade mixes toward
 * whatever the stylesheet actually paints — the two have to agree exactly or a
 * faded layer reads as a wash of the wrong tint. Sampled once on mount: a theme
 * switch at runtime would need this to re-read, and there is no theme switch.
 */
function useBackgroundColor(
  ref: React.RefObject<HTMLElement | null>,
): readonly [number, number, number] {
  const [color, setColor] = useState<readonly [number, number, number]>([0, 0, 0])

  useEffect(() => {
    const element = ref.current
    if (element === null) return

    const parsed = getComputedStyle(element)
      .backgroundColor.match(/[\d.]+/g)
      ?.slice(0, 3)
      .map(Number)

    if (parsed?.length === 3) {
      setColor([(parsed[0] as number) / 255, (parsed[1] as number) / 255, (parsed[2] as number) / 255])
    }
  }, [ref])

  return color
}
