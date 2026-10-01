import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { clusterStale, focusedTypologyOf, useEras } from "../app/store.ts"
import type { Geometry } from "../core/render/geometry.ts"
import { SegmentIndex } from "../core/render/picking.ts"
import type { Palette } from "../core/render/palette.ts"
import type { ViewState } from "../core/render/Renderer.ts"
import { repeatedSteps } from "../core/stats/silhouettes.ts"
import { ChartGrid } from "./ChartGrid.tsx"
import { LumpLayer } from "./LumpLayer.tsx"
import { SmallMultiples } from "./SmallMultiples.tsx"
import { StateBoxPlots } from "./StateBoxPlots.tsx"
import { TrajectoryOverlay } from "./TrajectoryOverlay.tsx"
import { StateDots } from "./StateDots.tsx"
import { createHoverSettler, DIM_FADE, HIGHLIGHT_OPACITY } from "./hover.ts"
import { useAnimatedScalar, useAnimatedView } from "./useAnimatedView.ts"
import { useChartLayers } from "./useChartLayers.ts"
import { useClusterRun } from "./useClusterRun.ts"
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
/**
 * Draw budget, in milliseconds, above which the highlight lands rather than
 * fades.
 *
 * Measured rather than guessed: `useFrameClock` keeps a moving average of what
 * this scene's draws actually cost, so the ceiling calibrates itself to the
 * dataset and the machine instead of to a segment count someone picked once. A
 * fade frame is one `drawArrays` with two uniforms changed — the same draw the
 * chart already does on every view change — so if that is comfortably inside a
 * frame the animation is free, and if it is not, a stuttering fade reads worse
 * than an instant one.
 */
const FADE_FRAME_BUDGET_MS = 7
/**
 * How far the spines that are *not* being pointed at step back.
 *
 * Lighter than `DIM_FADE`: the field below is context and can go most of the way
 * out, where the other spines are the population this one belongs to and have to
 * stay countable.
 */
const SPINE_DIM_FADE = 0.68

export function TrajectoriesChart(): React.JSX.Element {
  const axis = useEras((s) => s.axis)
  const rendererKind = useEras((s) => s.rendererKind)
  const opacity = useEras((s) => s.opacity)
  const layers = useEras((s) => s.layers)
  const clusterRun = useClusterRun()
  const toggleCluster = useEras((s) => s.toggleCluster)
  const setHoveredPatient = useEras((s) => s.setHoveredPatient)
  const setHoveredCluster = useEras((s) => s.setHoveredCluster)
  const togglePatient = useEras((s) => s.togglePatient)

  const {
    bulk,
    overlay,
    highlight,
    highlightCount,
    isIsolated,
    linesDrawn,
    lumps,
    medoidCount,
    rowStats,
    rowReference,
    rowOf: targetRowOf,
    rowStates,
    rowLabels,
    byPosition,
    mode,
    geometryOptions,
    statePalette,
    buildMs,
    xDomain: targetXDomain,
  } = useChartLayers()

  /*
   * Everything below draws from here, canvas and SVG alike, so the rules, the
   * box plots and the density field move as one. `useChartLayers` keeps feeding
   * the *target*; nothing it builds depends on the tweened value.
   */
  const {
    xDomain,
    rows: rowOf,
    isAnimating,
  } = useAnimatedView(targetXDomain, targetRowOf, {
    enabled: (bulk?.segmentCount ?? 0) <= MAX_ANIMATED_SEGMENTS,
    // Switching between age and calendar changes what an x value *is*, so the
    // old and new domains are not two points on one scale to travel between.
    xUnits: axis,
  })

  // Elements, not refs: both views mount their own container, and the effects
  // below have to follow the one that is actually on screen. See `useRenderer`.
  const [container, setContainer] = useState<HTMLDivElement | null>(null)
  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null)

  const size = useElementSize(container)
  const renderer = useRenderer(canvas, rendererKind)
  const frame = useFrameClock()

  /**
   * CPU fallback index — only for the Canvas2D backend, which cannot read a
   * segment id back out of what it drew. Built off the critical path and skipped
   * entirely above `CPU_PICK_LIMIT`.
   */
  const needsCpuIndex =
    rendererKind === "canvas2d" &&
    bulk !== null &&
    bulk.segmentCount > 0 &&
    bulk.segmentCount <= CPU_PICK_LIMIT

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
      setIndex(SegmentIndex.build(bulk, rowStates.length, targetXDomain, targetRowOf))
    })

    return () => {
      cancelled = true
      if (typeof cancelIdleCallback === "function") cancelIdleCallback(handle as number)
      else window.clearTimeout(handle as number)
    }
  }, [needsCpuIndex, bulk, rowStates.length, targetXDomain, targetRowOf])

  /**
   * Hit-testing for the spines.
   *
   * Always a CPU index, and always affordable: the medoid layer is capped at
   * `TOP_CLUSTER_LIMIT` spines of a handful of segments each, so this is a few
   * thousand entries where the bulk index would be a million — which is why
   * that one is idle-scheduled and skipped above a ceiling and this one is just
   * built. It also works identically on both backends, where the GPU pick reads
   * back only what is in the *bulk* buffer and so could never see the overlay.
   */
  const medoidIndex = useMemo(() => {
    if (overlay === null || overlay.segmentCount === 0 || rowStates.length === 0) return null
    return SegmentIndex.build(overlay, rowStates.length, targetXDomain, targetRowOf)
  }, [overlay, rowStates.length, targetXDomain, targetRowOf])

  useEffect(() => {
    renderer?.setGeometry(bulk)
  }, [renderer, bulk])

  const baseFade = linesDrawn && (overlay !== null || layers.lumps) ? 1 - opacity : 0

  /*
   * How far into the highlight the chart is, 0 to 1 — one number driving both
   * halves of it, so the field receding and the members arriving are the same
   * gesture rather than two that happen to start together.
   */
  const focus = useAnimatedScalar(
    highlight === null ? 0 : 1,
    frame.ref.current <= FADE_FRAME_BUDGET_MS,
  )

  /*
   * The members stay uploaded until the fade is over.
   *
   * Clearing the slot the moment the pointer leaves would give the fade-out
   * nothing to fade — the layer would vanish and the field would come back up
   * behind it. At `highlightOpacity` 0 the pass is skipped anyway, so holding
   * one cluster's geometry costs nothing but says what to draw on the way down.
   */
  const [lit, setLit] = useState<{ members: Geometry; spine: Geometry } | null>(null)

  useEffect(() => {
    if (highlight !== null) setLit(highlight)
    else if (focus === 0) setLit(null)
  }, [highlight, focus])

  useEffect(() => {
    renderer?.setOverlayGeometry(overlay)
  }, [renderer, overlay])

  useEffect(() => {
    renderer?.setHighlightGeometry(lit?.members ?? null)
  }, [renderer, lit])

  useEffect(() => {
    renderer?.setFocusGeometry(lit?.spine ?? null)
  }, [renderer, lit])

  useEffect(() => {
    renderer?.setRowLookup(rowOf)
  }, [renderer, rowOf])

  const background = useBackgroundColor(container)

  /*
   * The hairlines step back whenever something is drawn over them, and further
   * still while a cluster is being pointed at — including when the bulk *is* the
   * spine layer, where dimming the other spines is what separates the one under
   * the cursor from the thousand beside it.
   */

  const view = useMemo<ViewState>(
    () => ({
      xDomain,
      rowCount: rowStates.length,
      marginY: MARGIN_Y,
      /*
       * With the hairlines off, whatever is in the bulk slot is a summary — a
       * thousand spines where the bulk has a million lines, so alpha stacking
       * has nothing left to stack and a low opacity would only make them hard
       * to see. The control bar disables the slider to say so.
       */
      opacity: linesDrawn ? opacity : 1,
      lineWidth: linesDrawn ? 1 : 2,
      /*
       * The slider still runs in the same direction — low is faint either way —
       * but it now picks how far the colour is mixed into the background rather
       * than how much alpha each line carries, so crossings stop accumulating
       * and the layer reads as one sheet under whatever is above it.
       */
      bulkFade: baseFade + (Math.max(baseFade, DIM_FADE) - baseFade) * focus,
      background,
      overlayOpacity: 0.95,
      overlayWidth: 2.5,
      /*
       * Dimming the field alone was enough while there were far more hairlines
       * than spines. It is not when a typology has many clusters and few members:
       * what recedes is thin, and a wall of spines at full strength buries the
       * one being asked about.
       */
      overlayFade: SPINE_DIM_FADE * focus,
      highlightOpacity: HIGHLIGHT_OPACITY * focus,
    }),
    [xDomain, rowStates.length, opacity, linesDrawn, baseFade, focus, background],
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
      if (rowStates.length === 0) return null

      const [x0, x1] = xDomain
      const x = x0 + (px / rect.width) * (x1 - x0)

      const usable = Math.max(rect.height - 2 * MARGIN_Y, 1)
      const row = ((py - MARGIN_Y) / usable) * rowStates.length - 0.5

      return { x, row }
    },
    [xDomain, rowStates.length],
  )

  /**
   * GPU first: one scissored draw plus a `readPixels` of a few hundred pixels,
   * independent of how many trajectories are on screen.
   *
   * With spines over the hairlines, the interaction belongs to the spines
   * alone. Picking one line out of a quarter-million was never a useful answer
   * — the thing under the cursor is whichever of several thousand overlapping
   * trajectories happened to be drawn last — whereas picking a spine names a
   * cluster, which is a group you can then isolate, read and export. So when
   * the overlay is up, the bulk underneath is not hit-tested at all.
   */
  const pickPatient = useCallback(
    (clientX: number, clientY: number): number | null => {
      const element = container
      // Hit-testing a moving chart answers for where things were, not where the
      // pointer is; hover simply pauses for the few hundred ms of a transition.
      if (element === null || isAnimating) return null

      const rect = element.getBoundingClientRect()
      const localX = clientX - rect.left
      const localY = clientY - rect.top
      const point = toDataSpace(localX, localY, rect)

      if (overlay !== null) {
        if (medoidIndex === null || point === null) return null
        return medoidIndex.pick(point.x, point.row, PICK_RADIUS_DATA)?.patient ?? null
      }

      if (bulk === null) return null

      if (renderer !== null) {
        const segment = renderer.pickAt(localX, localY, view, PICK_RADIUS_PX)
        if (segment !== null) return bulk.segmentPatient[segment] ?? null
      }

      if (index === null || point === null) return null
      return index.pick(point.x, point.row, PICK_RADIUS_DATA)?.patient ?? null
    },
    [bulk, overlay, medoidIndex, renderer, view, index, toDataSpace, isAnimating, container],
  )

  /**
   * Whether a pick lands on the spine layer, which is what makes a hit mean a
   * *cluster* rather than a person.
   *
   * `clusterOfPatient` answers for any patient, not only for medoids, so
   * without this a hairline under the cursor would isolate whatever cluster its
   * owner happens to sit in — a reading nobody asked for, off a line nobody can
   * aim at. Spines are pickable when they are over the hairlines, or when they
   * are the only line-shaped layer and so are the bulk themselves.
   */
  const pickingSpines =
    layers.medoids && medoidCount > 0 && (overlay !== null || !linesDrawn) && clusterRun !== null

  const clusterAt = useCallback(
    (patient: number | null): number | null => {
      if (patient === null || !pickingSpines || clusterRun === null) return null
      const cluster = clusterRun.clusterOfPatient[patient] ?? -1
      return cluster >= 0 ? cluster : null
    },
    [pickingSpines, clusterRun],
  )

  // Settled rather than applied per frame: see `createHoverSettler`.
  const settler = useMemo(
    () => createHoverSettler<number | null>(setHoveredCluster),
    [setHoveredCluster],
  )

  useEffect(() => () => settler.cancel(), [settler])

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
        const patient = pickPatient(point.x, point.y)
        // The trace follows the pointer; the cluster waits for it to stop.
        setHoveredPatient(patient)
        settler.queue(clusterAt(patient))
      })
    },
    [pickPatient, setHoveredPatient, settler, clusterAt],
  )

  const handlePointerLeave = useCallback(() => {
    setHoveredPatient(null)
    // Leaving is unambiguous, so it lands at once rather than after the settle.
    settler.cancel()
    setHoveredCluster(null)
  }, [setHoveredPatient, settler, setHoveredCluster])

  useEffect(
    () => () => {
      if (rafHandle.current !== 0) cancelAnimationFrame(rafHandle.current)
    },
    [],
  )

  const handleClick = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const patient = pickPatient(event.clientX, event.clientY)
      if (patient === null) return

      /*
       * On the spine layer a click means its *cluster*, not its patient. The
       * medoid is a real person, but what it is standing there for is the
       * group — so clicking isolates that group, which scopes the hairlines to
       * its members and reveals its row in the cluster panel. Pinning the one
       * trajectory, which is all a click used to do, is the less useful of the
       * two readings and the one the overlay already gives on hover.
       */
      const cluster = clusterAt(patient)
      if (cluster !== null) {
        toggleCluster(cluster)
        return
      }

      togglePatient(patient)
    },
    [pickPatient, togglePatient, clusterAt, toggleCluster],
  )

  if (mode === "multiples") {
    return (
      <div className="chart">
        {/*
         * The grid keeps the container so the width measurement and the
         * background sampling are the same ones the overlay view uses; only
         * what is drawn inside it changes.
         */}
        <div ref={setContainer} className="chart__surface chart__surface--grid">
          <SmallMultiples
            width={size.width}
            opacity={opacity}
            xDomain={xDomain}
            options={geometryOptions}
            background={background}
          />
        </div>
        <ChartStats
          rowCount={rowStates.length}
          isIsolated={isIsolated}
          segmentCount={bulk?.segmentCount ?? 0}
          lumpCount={lumps.length}
          medoidCount={medoidCount}
          highlightCount={highlightCount}
          rowStates={rowStates}
          rowLabels={rowLabels}
          palette={statePalette}
          buildMs={buildMs}
          frameRef={frame.ref}
          indexing={false}
        />
      </div>
    )
  }

  return (
    <div className="chart">
      <div
        ref={setContainer}
        className="chart__surface"
        onPointerMove={handlePointerMove}
        onPointerLeave={handlePointerLeave}
        onPointerDown={handleClick}
      >
        <canvas ref={setCanvas} className="chart__canvas" />

        <ChartGrid
          width={size.width}
          height={size.height}
          marginY={MARGIN_Y}
          xDomain={xDomain}
          rowOf={rowOf}
          rowStates={rowStates}
          rowLabels={rowLabels}
          byPosition={byPosition}
          palette={statePalette}
        />

        {/*
         * Back on the ladder, where they had quietly stopped rendering: the old
         * gate was `!byPosition`, and every single-typology chart is a ladder
         * now, so the condition was never true again.
         */}
        <StateBoxPlots
          width={size.width}
          height={size.height}
          marginY={MARGIN_Y}
          xDomain={xDomain}
          rowOf={rowOf}
          rowStates={rowStates}
          byPosition={byPosition}
          stats={rowStats}
          reference={rowReference}
          axis={axis}
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
            rowCount={rowStates.length}
            palette={statePalette}
          />
        )}

        <TrajectoryOverlay
          width={size.width}
          height={size.height}
          marginY={MARGIN_Y}
          xDomain={xDomain}
          rowOf={rowOf}
          rowCount={rowStates.length}
          byPosition={byPosition}
          palette={statePalette}
        />
      </div>

      <ChartStats
        rowCount={rowStates.length}
        isIsolated={isIsolated}
        segmentCount={bulk?.segmentCount ?? 0}
        lumpCount={lumps.length}
        medoidCount={medoidCount}
        highlightCount={highlightCount}
        rowStates={rowStates}
        rowLabels={rowLabels}
        palette={statePalette}
        buildMs={buildMs}
        frameRef={frame.ref}
        indexing={needsCpuIndex && index === null}
      />
    </div>
  )
}

function ChartStats({
  rowCount,
  isIsolated,
  segmentCount,
  lumpCount,
  medoidCount,
  highlightCount,
  rowStates,
  rowLabels,
  palette,
  buildMs,
  frameRef,
  indexing,
}: {
  rowCount: number
  isIsolated: boolean
  segmentCount: number
  lumpCount: number
  medoidCount: number
  highlightCount: number
  rowStates: readonly number[]
  rowLabels: readonly string[]
  palette: Palette
  buildMs: number
  frameRef: React.RefObject<number>
  indexing: boolean
}): React.JSX.Element {
  const layers = useEras((s) => s.layers)
  const staleClusters = useEras(clusterStale)
  const selection = useEras((s) => s.selection)
  const cohortSize = useEras((s) => s.cohortSize)
  const selectionVersion = useEras((s) => s.selectionVersion)
  const clearClusters = useEras((s) => s.clearClusters)
  const selectedTypologies = useEras((s) => s.selectedTypologies)
  const clearTypologies = useEras((s) => s.clearTypologies)
  const focused = focusedTypologyOf(selectedTypologies)

  // Sampled on a timer, not per frame, so the readout never drives the render loop.
  // const [frameMs, setFrameMs] = useState(0)
  // useEffect(() => {
  //   const id = setInterval(() => setFrameMs(frameRef.current), 500)
  //   return () => clearInterval(id)
  // }, [frameRef])

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
      {staleClusters && (
        <span
          className="chart__stats-stale"
          title="States changed since the run — re-cluster from the States or Clusters panel"
        >
          clusters out of date
        </span>
      )}
      {/* <span>
        geometry <b>{buildMs.toFixed(1)}ms</b>
      </span>
      <span>
        draw <b>{frameMs.toFixed(2)}ms</b>
      </span> */}
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
      {highlightCount > 0 && (
        <span className="chart__stats-hover">
          <b>{highlightCount.toLocaleString()}</b> in this cluster
        </span>
      )}
      {focused !== null && (
        <TypologyChip
          label={focused}
          states={rowStates}
          labels={rowLabels}
          palette={palette}
          onClear={clearTypologies}
        />
      )}
      {isIsolated && (
        <button
          type="button"
          className="chart__stats-isolated"
          title="Stop isolating and show the whole selection again"
          onClick={() => clearClusters()}
        >
          isolated ✕
        </button>
      )}
      {/* <span className="chart__stats-kind">{rendererKind}</span> */}
      {indexing && <span className="chart__stats-pending">indexing…</span>}
    </div>
  )
}

/**
 * Which typology is on screen, as its own colour run.
 *
 * A key is a long string and the stats line is one row of small text, so the
 * chip carries the same dots the small-multiple card did — the thing you clicked
 * and the thing that says where you are look alike. `StateDots` owns the reveal,
 * which is what keeps the two identical.
 */
function TypologyChip({
  label,
  states,
  labels,
  palette,
  onClear,
}: {
  label: string
  states: readonly number[]
  labels: readonly string[]
  palette: Palette
  onClear: () => void
}): React.JSX.Element {
  const repeated = useMemo(() => repeatedSteps(states), [states])

  return (
    <button
      type="button"
      className="chart__stats-isolated chart__stats-chip"
      aria-label={`${label} — back to the grid`}
      onClick={onClear}
    >
      <StateDots
        states={states}
        labels={labels}
        repeated={repeated}
        palette={palette}
        hint="click to go back to the grid"
      />
      <span aria-hidden="true">✕</span>
    </button>
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
function useBackgroundColor(element: HTMLElement | null): readonly [number, number, number] {
  const [color, setColor] = useState<readonly [number, number, number]>([0, 0, 0])

  useEffect(() => {
    if (element === null) return

    const parsed = getComputedStyle(element)
      .backgroundColor.match(/[\d.]+/g)
      ?.slice(0, 3)
      .map(Number)

    if (parsed?.length === 3) {
      setColor([
        (parsed[0] as number) / 255,
        (parsed[1] as number) / 255,
        (parsed[2] as number) / 255,
      ])
    }
  }, [element])

  return color
}
