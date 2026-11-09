import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"

import { useEras } from "../app/store.ts"
import { clusterMembers, medoidPatients } from "../core/cluster/medoids.ts"
import { TOP_CLUSTER_LIMIT, type TypologyClusters } from "../core/cluster/types.ts"
import { buildGeometry, type Geometry, type GeometryOptions } from "../core/render/geometry.ts"
import { mixToward, paintGeometry } from "../core/render/paint2d.ts"
import { buildPalette, packedRgb } from "../core/render/palette.ts"
import { SegmentIndex } from "../core/render/picking.ts"
import { panelTypologies, repeatedSteps, sequenceLabels } from "../core/stats/silhouettes.ts"
import type { TrajectoryStore, Typology } from "../core/types.ts"
import { StateDots } from "./StateDots.tsx"
import { createHoverSettler, HIGHLIGHT_OPACITY } from "./hover.ts"
import { exportMemberships } from "./quickExport.ts"
import { useAnimatedScalar } from "./useAnimatedView.ts"
import { useClusterRun } from "./useClusterRun.ts"

/**
 * One small chart per typology, each along its own sequence.
 *
 * The overlay view is right while a few typologies are in play — they share a
 * cohort and a time axis, and seeing them in one frame is the point. Past a
 * handful it stops separating: paths cross on shared rows, and the slope of any
 * one sequence, which is what you are comparing, is buried in the others.
 *
 * Splitting them up buys the thing the shared frame cannot give: **each panel
 * gets one row per step of its own sequence**. Not one per state — per *step*,
 * so a sequence that revisits a state gets a second rule for the second visit
 * rather than sending the line back up. Every trajectory is then strictly
 * descending, every panel is a pure diagonal, and the only thing that varies is
 * the slope: how long that cohort took to walk its path. That is the comparison
 * the view exists for, and it is the reading a global row order cannot express —
 * which is also why it is the right shape for loops later.
 *
 * Two things are held constant so the slopes are comparable at all: the x
 * domain, and the **pitch between rows**. Panels are top-aligned and every row
 * is the same number of pixels below the last, so a four-step panel is a shorter
 * ladder than a seven-step one rather than a stretched one — otherwise a short
 * sequence spread over the same height would read as the shallowest path on
 * screen when it may be the steepest.
 *
 * The grid carries the full layer stack, not a reduced one. Medoid spines are
 * drawn per panel over their own cohort's hairlines, and pointing at one lifts
 * its members out the same way the single chart does — a cluster is a group
 * *within* one typology, so a panel is exactly the frame it belongs in. Without
 * that the spines were only ever readable one typology at a time, which is the
 * one thing this view exists not to make you do.
 *
 * Three canvases, not one per panel: browsers cap the number of live contexts,
 * and a grid of hundreds would also mean a resize observer and a draw loop
 * each. The panels are rectangles of shared contexts, which is exactly what
 * `paint2d` was extracted for.
 *
 * **Every** typology gets a panel, and only the rows in view cost anything. The
 * grid is sized for all of them, but geometry is built for a panel only once
 * its row scrolls near the viewport (and kept, up to `PANEL_CACHE`), the DOM
 * holds buttons for those rows alone, and the canvases cover just that window
 * of rows rather than the whole grid — which at a few hundred rows would be
 * past the browser's canvas size limit anyway. Scrolling inside the window is
 * the compositor's; the layers repaint only when the window has to move, and
 * it moves `OVERSCAN_ROWS` ahead so that is once every few rows, not per row.
 *
 * Three rather than one because the layers change on completely different
 * clocks, and the expensive one changes least:
 *
 * | canvas | holds | repaints when |
 * |---|---|---|
 * | rules | the ladders and their labels | the layout does |
 * | lines | every panel's cohort | the selection or the opacity does |
 * | spines | medoids, and the hovered cluster's members | the pointer does |
 *
 * Folded into one context, pointing at a spine repainted a million hairlines to
 * change a few hundred — which is what made this view stutter. Separated, a
 * hover touches only the cheap layer, and dimming the field underneath is a CSS
 * opacity on an element the compositor already holds rather than a repaint at
 * all.
 */

const PANEL_GAP = 12
const PANEL_TOP = 10
/**
 * Columns, and with them how much room each panel gets.
 *
 * A few typologies do not need to be small: at four or fewer the grid goes to
 * two columns, which buys enough height for a wider row pitch and enough width
 * to label the rows — at which point a panel is a readable chart rather than a
 * thumbnail. Past that the point is comparing shapes, and four across gets more
 * of them on screen than any of them deserves individually.
 */
const DETAILED_LIMIT = 4
const DETAILED_COLUMNS = 2
const COMPACT_COLUMNS = 4
/** Constant across panels — this is what makes two slopes comparable. */
const DETAILED_PITCH = 34
const COMPACT_PITCH = 20
/** Room for the row labels, only taken when there is room to read them. */
const LABEL_WIDTH = 116
/** Below the last row: the label strip. */
const FOOTER = 20
/**
 * Rows painted beyond each edge of the viewport. The window only moves once the
 * viewport leaves it, and then re-centres — so this is also how many rows you
 * can scroll before anything is repainted.
 */
const OVERSCAN_ROWS = 2
/** Rows assumed before the viewport has been measured. */
const INITIAL_ROWS = 6
/**
 * Panels whose geometry is kept after scrolling off, so scrolling back is free.
 * Never fewer than are on screen; least recently shown go first.
 */
const PANEL_CACHE = 160
/** Spine hit tolerance, in rows. A panel's rows are its steps. */
const PICK_RADIUS_ROWS = 0.35
const SPINE_OPACITY = 0.95
/**
 * Thinner than the single chart's spines, and for the same reason the panels
 * are smaller: at a quarter of the width a 2.5px line is a quarter of the
 * distance between two rows, so a handful of them closed the ladder up.
 */
const SPINE_WIDTH = 1.4
/** The hovered spine, and every other one, while one is being pointed at. */
const SPINE_FOCUS_WIDTH = 2.6
const SPINE_DIMMED_OPACITY = 0.22
/**
 * A typology's spines are drawn in one after another when its result lands
 * during a run, biggest cluster first: this far apart, each fading in over
 * `SPINE_DRAW_IN_MS`. Only final medoids are ever drawn — the stagger is in the
 * showing, not in the clustering, which hands over a typology's medoids together.
 */
const SPINE_STAGGER_MS = 120
const SPINE_DRAW_IN_MS = 280
/**
 * How far the hairline layer recedes while a cluster is highlighted.
 *
 * A CSS opacity on the canvas element, not a repaint: the compositor already
 * holds those pixels, so the whole field steps back for free and its density
 * structure — which is the reason it is drawn at all — survives intact, where
 * mixing every line toward the background would flatten it.
 */
const DIM_ELEMENT_OPACITY = 0.26
/**
 * Trajectories drawn per panel, before sampling.
 *
 * A compact panel is a few hundred pixels across and a hundred tall. Past this,
 * more trajectories are not more information — they are the same pixels drawn
 * again, at full cost, and the biggest typologies are exactly the ones the grid
 * opens on. Sampled by a fixed stride so the picture is stable between
 * repaints, and the footer says when it is a sample.
 */
const DETAILED_BUDGET = 4000
const COMPACT_BUDGET = 1200
/**
 * How long the pointer rests on a compact card before the grid is labelled
 * against it. Long enough that sweeping across the grid does not flash labels
 * on every card it crosses, short enough to read as a response to the hover.
 */
const REFERENCE_DELAY_MS = 180

interface Props {
  readonly width: number
  readonly opacity: number
  readonly xDomain: readonly [number, number]
  readonly options: GeometryOptions
  readonly background: readonly [number, number, number]
}

export function SmallMultiples({
  width,
  opacity,
  xDomain,
  options,
  background,
}: Props): React.JSX.Element | null {
  const store = useEras((s) => s.store)
  const typologies = useEras((s) => s.typologies)
  const selected = useEras((s) => s.selectedTypologies)
  const selection = useEras((s) => s.selection)
  const selectionVersion = useEras((s) => s.selectionVersion)
  const selectTypologies = useEras((s) => s.selectTypologies)
  const focusCluster = useEras((s) => s.focusCluster)
  const showSpines = useEras((s) => s.layers.medoids)
  const clusterRun = useClusterRun()
  const clusterVersion = useEras((s) => s.clusterVersion)
  const clusterStatus = useEras((s) => s.clusterStatus)
  const hoveredCluster = useEras((s) => s.hoveredCluster)
  const setHoveredCluster = useEras((s) => s.setHoveredCluster)

  const rulesRef = useRef<HTMLCanvasElement>(null)
  const linesRef = useRef<HTMLCanvasElement>(null)
  const spinesRef = useRef<HTMLCanvasElement>(null)
  const [hovered, setHovered] = useState<number | null>(null)
  /**
   * The spine under the cursor *right now*, ahead of the settled hover.
   *
   * The two halves of the reading cost completely different things, so they run
   * on different clocks. Emphasising a spine is a repaint of the cheapest layer
   * with one extra trajectory in it, so it follows the pointer directly — the
   * mark you are aiming at should acknowledge you. Lifting its members out
   * builds geometry for a whole cluster and pushes the field back, so that waits
   * for the pointer to settle. Pointing at a spine answers immediately; asking
   * who it stands for is the question you have to hold still for.
   */
  const [pointedCluster, setPointedCluster] = useState<number | null>(null)
  /**
   * The card the compact grid is labelled against: `hovered`, once the pointer
   * has rested on it — see `ReferenceLabels`. Cleared at once on leaving, so
   * labels never outlive the hover that asked for them.
   */
  const [reference, setReference] = useState<number | null>(null)

  useEffect(() => {
    if (hovered === null) {
      setReference(null)
      return
    }
    const timer = window.setTimeout(() => setReference(hovered), REFERENCE_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [hovered])

  const palette = useMemo(
    () => buildPalette(store?.stateNames.length ?? 0),
    [store?.stateNames.length],
  )

  /*
   * Every geometry in this view is built against the panel's own steps, so the
   * options are hoisted rather than spread at three call sites — a fresh object
   * per render would rebuild all of it on every pointer move.
   */
  const panelOptions = useMemo<GeometryOptions>(
    () => ({ ...options, rowsFrom: "position" as const }),
    [options],
  )

  /*
   * The selection, in the list's own order — or, with nothing selected, the
   * biggest ones, because this is what the Trajectories view shows before
   * anything is picked. All of them: a path selection can name hundreds, and
   * the grid is windowed, so what is off screen costs nothing. The rule is
   * `panelTypologies`, shared with the View panel's mini of this grid.
   */
  const shown = useMemo<readonly Typology[]>(
    () => panelTypologies(typologies, selected, Number.POSITIVE_INFINITY),
    [typologies, selected],
  )

  /*
   * How much room a panel gets, and with it how much of its cohort is worth
   * drawing. Read off `shown` rather than off `panels`, because the geometry
   * below needs the budget it decides — and so does the window, which needs
   * the layout before it can say which panels to build.
   */
  const isDetailed = shown.length <= DETAILED_LIMIT
  const budget = isDetailed ? DETAILED_BUDGET : COMPACT_BUDGET

  /*
   * One height for every cell, sized to the longest sequence in the grid — all
   * of it, not just the rows in view, or cells would change height as you
   * scrolled. Panels are top-aligned inside it, so the pitch is identical and a
   * short sequence simply stops early.
   */
  const rowPitch = isDetailed ? DETAILED_PITCH : COMPACT_PITCH
  const labelWidth = isDetailed ? LABEL_WIDTH : 0

  const maxSteps = useMemo(
    () => shown.reduce((most, typology) => Math.max(most, typology.states.length), 1),
    [shown],
  )
  const panelHeight = PANEL_TOP + maxSteps * rowPitch + FOOTER

  const columns = Math.max(
    1,
    Math.min(shown.length || 1, isDetailed ? DETAILED_COLUMNS : COMPACT_COLUMNS),
  )
  const panelWidth = Math.floor((width - PANEL_GAP * (columns - 1)) / Math.max(columns, 1))
  const gridRows = Math.ceil(shown.length / columns)
  /** One grid row, gap included: the unit the window moves in. */
  const rowStride = panelHeight + PANEL_GAP
  const height = Math.max(1, gridRows * rowStride)

  /*
   * The window: the grid rows that are built, painted and mounted — the ones
   * in view, plus `OVERSCAN_ROWS` either side. Grid rows, not pixels, so
   * scrolling within the window is not a React render at all.
   */
  const [grid, setGrid] = useState<HTMLDivElement | null>(null)
  const [rowWindow, setRowWindow] = useState<readonly [number, number]>([0, INITIAL_ROWS - 1])
  const scroller = useRef<HTMLElement | null>(null)

  /**
   * Re-derives the window from where the grid sits in its scroller. Leaves it
   * alone while the viewport is still inside it, unless `force` — which the
   * layout asks for, since a new row height makes the old window the wrong size.
   */
  const measure = useRef<(force: boolean) => void>(() => {})
  measure.current = (force) => {
    if (grid === null || gridRows === 0) return
    const view = scroller.current
    const viewTop = view === null ? 0 : view.getBoundingClientRect().top
    const viewHeight = view === null ? window.innerHeight : view.clientHeight
    const top = viewTop - grid.getBoundingClientRect().top

    const last = gridRows - 1
    const firstVisible = Math.min(last, Math.max(0, Math.floor(top / rowStride)))
    const lastVisible = Math.min(last, Math.max(0, Math.floor((top + viewHeight) / rowStride)))

    /*
     * Always the same number of rows, slid rather than trimmed at the ends: the
     * window's height is the canvases' height, and resizing a canvas reallocates
     * its backing store — three of them, on every move.
     */
    const count = Math.min(gridRows, Math.ceil(viewHeight / rowStride) + 1 + 2 * OVERSCAN_ROWS)

    setRowWindow((current) => {
      const covers =
        current[0] <= firstVisible &&
        current[1] >= lastVisible &&
        current[1] <= last &&
        current[1] - current[0] + 1 === count
      if (covers && !force) return current
      const start = Math.max(0, Math.min(firstVisible - OVERSCAN_ROWS, gridRows - count))
      const next = [start, start + count - 1] as const
      return next[0] === current[0] && next[1] === current[1] ? current : next
    })
  }

  useLayoutEffect(() => {
    if (grid === null) return
    scroller.current = scrollParent(grid)
    const target: HTMLElement | Window = scroller.current ?? window
    const onChange = (): void => measure.current(false)

    target.addEventListener("scroll", onChange, { passive: true })
    const observer = new ResizeObserver(onChange)
    observer.observe(scroller.current ?? document.documentElement)
    return () => {
      target.removeEventListener("scroll", onChange)
      observer.disconnect()
    }
  }, [grid])

  useLayoutEffect(() => measure.current(true), [grid, rowStride, gridRows])

  const firstRow = Math.min(rowWindow[0], Math.max(0, gridRows - 1))
  const lastRow = Math.max(firstRow, Math.min(rowWindow[1], gridRows - 1))
  /** Grid index of `panels[0]`. Every index below is a grid index unless named local. */
  const first = firstRow * columns
  const end = Math.min(shown.length, (lastRow + 1) * columns)
  /** Where the canvases sit in the grid, and how much of it they cover. */
  const canvasTop = firstRow * rowStride
  const canvasHeight = Math.max(1, (lastRow - firstRow + 1) * rowStride)

  /*
   * Built panels, by typology, so a row scrolled back into view is not built
   * again. Thrown away whole when anything a panel is built from changes.
   */
  const panelCache = useRef<{ deps: readonly unknown[]; byKey: Map<string, Panel> }>({
    deps: [],
    byKey: new Map(),
  })

  /** The panels in the window, in grid order; `panels[i]` is grid index `first + i`. */
  const panels = useMemo<readonly Panel[]>(() => {
    if (store === null) return []

    const cache = panelCache.current
    const deps = [store, typologies, panelOptions, selection, selectionVersion, budget]
    if (deps.some((dep, i) => dep !== cache.deps[i])) {
      cache.deps = deps
      cache.byKey = new Map()
    }

    const mask = selection?.mask ?? null
    const out: Panel[] = []
    for (let index = first; index < end; index++) {
      const typology = shown[index] as Typology
      const panel =
        cache.byKey.get(typology.key) ?? buildPanel(store, typology, mask, budget, panelOptions)
      // Re-inserted, so the map's order is least recently shown first.
      cache.byKey.delete(typology.key)
      cache.byKey.set(typology.key, panel)
      out.push(panel)
    }

    const limit = Math.max(PANEL_CACHE, out.length)
    for (const key of cache.byKey.keys()) {
      if (cache.byKey.size <= limit) break
      cache.byKey.delete(key)
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, typologies, shown, panelOptions, selection, selectionVersion, budget, first, end])

  /**
   * One spine per cluster of each panel's own typology.
   *
   * Its own memo rather than a field of `panels`, because the two change on
   * completely different clocks: the hairlines move when the selection does,
   * while results stream in every `CLUSTER_FLUSH_MS` for the length of a run.
   * Folded together, a run would rebuild every panel's full member geometry a
   * dozen times a second. These are a handful of trajectories each.
   */
  const spines = useMemo<readonly (Geometry | null)[]>(() => {
    if (store === null || !showSpines || clusterRun === null) return []
    const mask = selection?.mask ?? null

    return panels.map((panel) => {
      const patients = medoidPatients(clusterRun, [], mask, TOP_CLUSTER_LIMIT, panel.typology.key)
      if (patients.length === 0) return null
      return buildGeometry(store, patients, panelOptions)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    store,
    panels,
    showSpines,
    clusterRun,
    clusterVersion,
    selection,
    selectionVersion,
    panelOptions,
  ])

  /**
   * Hit-testing, one index per panel.
   *
   * Affordable for the same reason the single chart's is: a panel holds a few
   * dozen spines of a handful of segments, where its hairlines are thousands.
   * Only the spines are hit-tested — picking one hairline out of a crowd names
   * a person nobody was aiming at, where picking a spine names a group.
   */
  /**
   * When each typology's spines started drawing in, in frame time.
   *
   * Read off the run's results map at every flush, so a key that is new since
   * the last one has just landed. It is stamped `NaN` — waiting — and the first
   * frame painted after that starts its draw-in: landing a result can cost a
   * frame or two, and timed from the landing the reveal could be over before
   * anything was painted. Results already there when the map is first seen —
   * opening this view mid-run or after it — are stamped `-Infinity` and simply
   * drawn; only what lands while the grid watches is drawn in. A new run is a
   * new map, and starts empty.
   *
   * A ref: the paint reads it. Drawing in is a canvas repaint per frame, never
   * a React render — re-rendering the grid every frame cost more than the
   * drawing did.
   */
  const arrivals = useRef<{
    results: ReadonlyMap<string, TypologyClusters> | null
    at: Map<string, number>
    /** Landed and shown, not yet painted: key → medoid count. */
    pending: Map<string, number>
    /** When the last draw-in under way finishes. */
    end: number
  }>({
    results: null,
    at: new Map(),
    pending: new Map(),
    end: 0,
  })
  /** Bumped when something new is waiting to draw in, to start the frame loop. */
  const [revealRequest, setRevealRequest] = useState(0)

  useEffect(() => {
    const results = clusterRun?.byTypology ?? null
    const book = arrivals.current
    if (results === null) return

    const isFresh = book.results !== results
    if (isFresh) {
      book.results = results
      book.at = new Map()
      book.pending = new Map()
    }
    // Seen for the first time with results already in: those are history.
    const live = clusterStatus === "running" && !(isFresh && results.size > 0)

    const shown = new Set(panels.map((panel) => panel.typology.key))
    let waiting = false
    for (const [key, result] of results) {
      if (book.at.has(key)) continue
      // Off screen it has nothing to draw in, so it counts as already drawn.
      const drawsIn = live && shown.has(key)
      book.at.set(key, drawsIn ? Number.NaN : -Infinity)
      if (drawsIn) {
        book.pending.set(key, result.k)
        waiting = true
      }
    }
    if (waiting) setRevealRequest((count) => count + 1)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clusterRun, clusterVersion, clusterStatus, panels])

  /**
   * A drawing-in panel's spines one by one, biggest cluster first — built on
   * first need and kept until `spines` is rebuilt, which is exactly when the
   * medoids, the mask or the geometry options change underneath them.
   */
  const spineParts = useRef<{ spines: unknown; byKey: Map<string, Geometry[]> }>({
    spines: null,
    byKey: new Map(),
  })

  const spineIndex = useMemo<readonly (SegmentIndex | null)[]>(
    () =>
      spines.map((geometry, i) => {
        const panel = panels[i]
        if (geometry === null || panel === undefined) return null
        return SegmentIndex.build(geometry, panel.steps.length, xDomain, panel.rows)
      }),
    [spines, panels, xDomain],
  )

  /**
   * The spine being pointed at, on its own — one patient's trajectory, which is
   * why this can keep up with the pointer where the members below cannot.
   */
  const focusSpine = useMemo<{ panel: number; geometry: Geometry } | null>(() => {
    if (store === null || !showSpines || pointedCluster === null || clusterRun === null) return null

    const ref = clusterRun.clusters[pointedCluster]
    if (ref === undefined) return null

    const local = panels.findIndex((candidate) => candidate.typology.key === ref.typologyKey)
    if (local === -1) return null

    return {
      panel: first + local,
      geometry: buildGeometry(store, Uint32Array.of(ref.medoidPatient), panelOptions),
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, showSpines, pointedCluster, clusterRun, clusterVersion, panels, first, panelOptions])

  /** The members of the settled cluster, and which panel they belong under. */
  const highlight = useMemo<{
    panel: number
    members: Geometry
  } | null>(() => {
    if (store === null || !showSpines || hoveredCluster === null || clusterRun === null) return null

    const ref = clusterRun.clusters[hoveredCluster]
    if (ref === undefined) return null

    const local = panels.findIndex((candidate) => candidate.typology.key === ref.typologyKey)
    if (local === -1) return null

    const members = clusterMembers(clusterRun, [hoveredCluster], selection?.mask ?? null)
    if (members.length === 0) return null

    return { panel: first + local, members: buildGeometry(store, members, panelOptions) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    store,
    showSpines,
    hoveredCluster,
    clusterRun,
    clusterVersion,
    panels,
    first,
    selection,
    selectionVersion,
    panelOptions,
  ])

  /** Where a panel sits in the grid, in CSS pixels, by grid index. The one definition of it. */
  const rectOf = useCallback(
    (index: number): { left: number; top: number; width: number; height: number } => ({
      left: (index % columns) * (panelWidth + PANEL_GAP),
      top: Math.floor(index / columns) * (panelHeight + PANEL_GAP),
      width: panelWidth,
      height: panelHeight,
    }),
    [columns, panelWidth, panelHeight],
  )

  /*
   * The hairlines under a spine layer are a backdrop, exactly as in the single
   * chart — and further back still while a cluster is being pointed at, which
   * is what makes its members legible as a subset rather than as more of the
   * same. `paintGeometry` takes the colours pre-mixed here because the gradient
   * path it uses for these panels strokes `rowColors` directly.
   */
  /*
   * The members arrive and leave on a curve rather than a switch, matching the
   * field behind them — which recedes over the same interval as a CSS
   * transition on the hairline canvas. The spine emphasis above deliberately
   * does *not* wait for this: it answers the pointer directly.
   *
   * Always enabled, unlike the single chart's: a frame here repaints the cheap
   * layer — a handful of spines and one cluster — never the hairlines.
   */
  const focus = useAnimatedScalar(highlight === null ? 0 : 1, true)

  // Held through the fade out, so there is something left to fade. See the same
  // pattern in `TrajectoriesChart`.
  const [lit, setLit] = useState<typeof highlight>(null)

  useEffect(() => {
    if (highlight !== null) setLit(highlight)
    else if (focus === 0) setLit(null)
  }, [highlight, focus])

  const hasSpines = spines.some((geometry) => geometry !== null)
  const lineFade = hasSpines ? 1 - opacity : 0
  const lineOpacity = lineFade > 0 ? 1 : opacity
  const dimmed = highlight !== null

  const lineColors = useMemo<readonly string[]>(() => {
    if (lineFade <= 0) return palette.css
    return palette.css.map((_css, state) => {
      const mixed = mixToward(packedRgb(palette, state), background, lineFade)
      return `#${mixed.toString(16).padStart(6, "0")}`
    })
  }, [palette, background, lineFade])

  /*
   * Everything a panel paints lands in the same band — top margin, then the
   * steps at the shared pitch — which is what keeps a spine on the rung its
   * members are on. Derived once per panel and handed to whichever layer is
   * being drawn. In canvas pixels, so measured from the window's top, not the
   * grid's.
   */
  const bandOf = useCallback(
    (index: number, panel: Panel, dpr: number) => {
      const rect = rectOf(index)
      const top = rect.top - canvasTop

      return {
        panelX: rect.left * dpr,
        panelY: top * dpr,
        panelWidth: rect.width * dpr,
        target: {
          x: (rect.left + labelWidth) * dpr,
          y: top * dpr,
          width: (rect.width - labelWidth) * dpr,
          height: (PANEL_TOP * 2 + panel.steps.length * rowPitch) * dpr,
        },
        xDomain,
        rows: panel.rows,
        rowCount: panel.steps.length,
        marginY: PANEL_TOP * dpr,
        fade: 0,
        background,
      }
    },
    [rectOf, canvasTop, labelWidth, rowPitch, xDomain, background],
  )

  /** Sizes a layer to the window and clears it. `null` while it is unmounted. */
  const prepare = useCallback(
    (canvas: HTMLCanvasElement | null, dpr: number): CanvasRenderingContext2D | null => {
      if (canvas === null || width === 0) return null

      const w = Math.max(1, Math.round(width * dpr))
      const h = Math.max(1, Math.round(canvasHeight * dpr))

      // Assigning either one reallocates the backing store even when the value
      // is unchanged, which the spine layer would otherwise pay on every frame
      // of a fade. `clearRect` is what is wanted there; a resize is not.
      if (canvas.width !== w) canvas.width = w
      if (canvas.height !== h) canvas.height = h

      const ctx = canvas.getContext("2d")
      if (ctx === null) return null
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.clearRect(0, 0, w, h)
      return ctx
    },
    [width, canvasHeight],
  )

  // Layer 1 — the ladders. A rule per *step*, in that step's state colour, at a
  // fixed pitch from the top. Two visits to one state therefore get two rules of
  // the same colour, which is what tells you the sequence came back.
  useEffect(() => {
    const dpr = window.devicePixelRatio || 1
    const ctx = prepare(rulesRef.current, dpr)
    if (ctx === null) return

    ctx.lineWidth = dpr

    panels.forEach((panel, local) => {
      const band = bandOf(first + local, panel, dpr)

      for (let row = 0; row < panel.steps.length; row++) {
        const y = band.panelY + (PANEL_TOP + (row + 0.5) * rowPitch) * dpr
        const color = palette.css[panel.steps[row] as number] ?? "#fff"

        ctx.globalAlpha = 0.28
        ctx.strokeStyle = color
        ctx.beginPath()
        ctx.moveTo(band.target.x, y)
        ctx.lineTo(band.panelX + band.panelWidth, y)
        ctx.stroke()

        // With two columns there is room to say which step each rule is, and
        // the ordinal is what tells a return from a duplicate.
        if (labelWidth > 0) {
          ctx.globalAlpha = 0.9
          ctx.fillStyle = color
          ctx.font = `${11 * dpr}px ui-monospace, monospace`
          ctx.textAlign = "right"
          ctx.textBaseline = "middle"
          ctx.fillText(panel.labels[row] ?? "", band.panelX + (labelWidth - 8) * dpr, y)
        }
      }
    })

    ctx.globalAlpha = 1
  }, [panels, first, prepare, bandOf, rowPitch, labelWidth, palette])

  /*
   * Layer 2 — the cohorts. The expensive one, and the one that changes least:
   * never on hover, where dimming is an opacity on the element itself.
   *
   * `rowColors` is the source→target blend, which the GPU gets per vertex for
   * free and the 2D painter otherwise approximates with a step at the midpoint.
   * Here every segment on a row descends to the next one, so the transition is a
   * function of y and one gradient per step reproduces it exactly. It also means
   * the fade has to be mixed into the colours beforehand, since that path never
   * sees `PaintOptions.fade`.
   *
   * When only the window has moved, the rows it still covers are copied across
   * rather than repainted — shifted by however far the window's top moved — and
   * only the rows that just came into it are drawn. Scrolling therefore costs
   * the rows it reveals, not the whole window. Anything else changing (a panel,
   * the colours, the layout) repaints the lot.
   */
  // Everything a painted panel's pixels depend on except where the window is.
  const linesStyle = useMemo(
    () => ({}),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [lineOpacity, lineColors, rectOf, labelWidth, rowPitch, xDomain, background],
  )
  const linesPainted = useRef<{
    canvas: HTMLCanvasElement
    style: object
    dpr: number
    top: number
    first: number
    panels: readonly Panel[]
  } | null>(null)
  const linesCopy = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const dpr = window.devicePixelRatio || 1
    const canvas = linesRef.current
    const before = linesPainted.current

    let kept: { from: number; to: number; shift: number; copy: HTMLCanvasElement } | null = null
    if (
      canvas !== null &&
      before !== null &&
      before.canvas === canvas &&
      before.style === linesStyle &&
      before.dpr === dpr
    ) {
      const from = Math.max(first, before.first)
      const to = Math.min(first + panels.length, before.first + before.panels.length)
      const shift = (before.top - canvasTop) * dpr
      // A fractional shift would resample the copy, and blur it.
      let same = to > from && Number.isInteger(shift)
      for (let index = from; same && index < to; index++) {
        same = panels[index - first] === before.panels[index - before.first]
      }
      if (same) {
        const copy = (linesCopy.current ??= document.createElement("canvas"))
        copy.width = canvas.width
        copy.height = canvas.height
        copy.getContext("2d")?.drawImage(canvas, 0, 0)
        kept = { from, to, shift, copy }
      }
    }

    const ctx = prepare(canvas, dpr)
    if (ctx === null || canvas === null) return
    if (kept !== null) ctx.drawImage(kept.copy, 0, kept.shift)

    panels.forEach((panel, local) => {
      const index = first + local
      if (kept !== null && index >= kept.from && index < kept.to) return
      paintGeometry(ctx, panel.geometry, {
        ...bandOf(index, panel, dpr),
        opacity: lineOpacity,
        lineWidth: dpr,
        rowColors: panel.steps.map((state) => lineColors[state] ?? "currentColor"),
      })
    })

    linesPainted.current = { canvas, style: linesStyle, dpr, top: canvasTop, first, panels }
  }, [panels, first, canvasTop, linesStyle, prepare, bandOf, lineOpacity, lineColors])

  // Layer 3 — the summaries, and whatever is being pointed at. Cheap by
  // construction: a handful of spines per panel, and one cluster's members.
  // `clock` places the spines still drawing in; see `arrivals`.
  const paintSpines = useCallback(
    (clock: number) => {
      const dpr = window.devicePixelRatio || 1
      const ctx = prepare(spinesRef.current, dpr)
      if (ctx === null) return

      const parts = spineParts.current
      if (parts.spines !== spines) {
        parts.spines = spines
        parts.byKey = new Map()
      }
      const mask = selection?.mask ?? null
      const drawingIn = (key: string, result: TypologyClusters): Geometry[] => {
        let geometries = parts.byKey.get(key)
        if (geometries === undefined) {
          const order = Array.from({ length: result.k }, (_, cluster) => cluster)
            .filter(
              (cluster) => mask === null || mask[result.medoidPatient[cluster] as number] === 1,
            )
            .sort((a, b) => (result.sizes[b] as number) - (result.sizes[a] as number))
          geometries = order.map((cluster) =>
            buildGeometry(
              store as TrajectoryStore,
              Uint32Array.of(result.medoidPatient[cluster] as number),
              panelOptions,
            ),
          )
          parts.byKey.set(key, geometries)
        }
        return geometries
      }

      panels.forEach((panel, local) => {
        const index = first + local
        const band = bandOf(index, panel, dpr)
        const colors = panel.steps.map((state) => palette.css[state] ?? "currentColor")

        // The cluster being pointed at, over the field it was drawn out of.
        if (lit !== null && lit.panel === index && focus > 0) {
          paintGeometry(ctx, lit.members, {
            ...band,
            opacity: HIGHLIGHT_OPACITY * focus,
            lineWidth: dpr,
            rowColors: colors,
          })
        }

        /*
         * Every spine, then the one being pointed at again on top. Without the
         * first pass stepping back, a highlighted cluster's members were the only
         * thing that changed on screen — and they sit *under* a layer of spines
         * drawn at full strength, so there was nothing to see.
         *
         * This pass answers to `focusSpine`, not to the settled highlight, which
         * is what makes aiming at a spine feel direct while the field below it
         * still waits for the pointer to stop.
         */
        const spineOpacity = focusSpine === null ? SPINE_OPACITY : SPINE_DIMMED_OPACITY
        const result = clusterRun?.byTypology.get(panel.typology.key)
        const arrived = arrivals.current.at.get(panel.typology.key) ?? -Infinity

        if (Number.isNaN(arrived)) {
          // Landed, waiting for the frame that starts its draw-in.
        } else if (
          store !== null &&
          result !== undefined &&
          clock < arrived + result.k * SPINE_STAGGER_MS + SPINE_DRAW_IN_MS
        ) {
          // Just landed: each medoid in its turn, fading up to full strength.
          drawingIn(panel.typology.key, result).forEach((geometry, i) => {
            const progress = (clock - arrived - i * SPINE_STAGGER_MS) / SPINE_DRAW_IN_MS
            if (progress <= 0) return
            paintGeometry(ctx, geometry, {
              ...band,
              opacity: spineOpacity * Math.min(1, progress),
              lineWidth: SPINE_WIDTH * dpr,
              rowColors: colors,
            })
          })
        } else {
          paintGeometry(ctx, spines[local] ?? null, {
            ...band,
            opacity: spineOpacity,
            lineWidth: SPINE_WIDTH * dpr,
            rowColors: colors,
          })
        }

        if (focusSpine !== null && focusSpine.panel === index) {
          paintGeometry(ctx, focusSpine.geometry, {
            ...band,
            opacity: SPINE_OPACITY,
            lineWidth: SPINE_FOCUS_WIDTH * dpr,
            rowColors: colors,
          })
        }
      })
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [
      panels,
      first,
      spines,
      lit,
      focus,
      focusSpine,
      prepare,
      bandOf,
      palette,
      clusterRun,
      store,
      selection,
      panelOptions,
    ],
  )

  useEffect(() => paintSpines(performance.now()), [paintSpines])

  // While something is drawing in, the spine layer repaints every frame — that
  // layer alone, straight from the frame callback. Restarted when a repaint
  // dependency changes mid-way, so it carries on rather than stopping.
  useEffect(() => {
    const book = arrivals.current
    if (book.pending.size === 0 && book.end <= performance.now()) return

    let frame = requestAnimationFrame(function tick(time) {
      for (const [key, count] of book.pending) {
        book.at.set(key, time)
        book.end = Math.max(book.end, time + count * SPINE_STAGGER_MS + SPINE_DRAW_IN_MS)
      }
      book.pending.clear()
      paintSpines(time)
      if (time < book.end) frame = requestAnimationFrame(tick)
    })
    return () => cancelAnimationFrame(frame)
  }, [revealRequest, paintSpines])

  // Settled rather than applied per move: see `createHoverSettler`.
  const settler = useMemo(
    () => createHoverSettler<number | null>(setHoveredCluster),
    [setHoveredCluster],
  )

  useEffect(() => () => settler.cancel(), [settler])

  /**
   * The cluster whose spine is under the pointer, in panel-local coordinates.
   *
   * The inverse of what the paint loop just did: strip the label gutter, put x
   * back in data units across the ladder, and turn y back into a fractional row
   * — the rules sit at `PANEL_TOP + (row + 0.5) * rowPitch`, so this is that
   * expression solved for `row`.
   */
  const clusterAt = useCallback(
    (index: number, clientX: number, clientY: number, rect: DOMRect): number | null => {
      const panel = panels[index - first]
      const pick = spineIndex[index - first]
      if (panel === undefined || pick === undefined || pick === null || clusterRun === null) {
        return null
      }

      const localX = clientX - rect.left - labelWidth
      const ladder = Math.max(rect.width - labelWidth, 1)
      if (localX < 0) return null

      const [x0, x1] = xDomain
      const x = x0 + (localX / ladder) * (x1 - x0)
      const row = (clientY - rect.top - PANEL_TOP) / rowPitch - 0.5

      const patient = pick.pick(x, row, PICK_RADIUS_ROWS)?.patient
      if (patient === undefined) return null

      const cluster = clusterRun.clusterOfPatient[patient] ?? -1
      return cluster >= 0 ? cluster : null
    },
    [panels, first, spineIndex, clusterRun, labelWidth, xDomain, rowPitch],
  )

  const handleMove = useCallback(
    (index: number, event: React.PointerEvent<HTMLButtonElement>): void => {
      const rect = event.currentTarget.getBoundingClientRect()
      const cluster = clusterAt(index, event.clientX, event.clientY, rect)
      // Set unconditionally: React bails out when the value is unchanged, which
      // is the common case while the pointer moves along one spine.
      setPointedCluster(cluster)
      settler.queue(cluster)
    },
    [clusterAt, settler],
  )

  const handleLeave = useCallback(
    (index: number): void => {
      setHovered((current) => (current === index ? null : current))
      setPointedCluster(null)
      // Leaving is unambiguous, so it lands at once rather than after a settle.
      settler.cancel()
      setHoveredCluster(null)
    },
    [settler, setHoveredCluster],
  )

  if (store === null || shown.length === 0) return null

  // The canvases sit on the window, not the grid. `top` keeps the stylesheet's
  // offset, which lines the pixels up with the DOM labels over them.
  const canvasStyle = {
    width,
    height: canvasHeight,
    top: `calc(var(--gap-small) + ${canvasTop}px)`,
  }

  return (
    <div className="multiples">
      <div ref={setGrid} className="multiples__grid" style={{ height }}>
        {/*
         * Three layers, one window. Only the middle one carries the cost, and it
         * is the one a hover never touches: the dim is a composited opacity on
         * an element whose pixels the browser already has.
         */}
        <canvas ref={rulesRef} className="multiples__canvas" style={canvasStyle} />
        <canvas
          ref={linesRef}
          className="multiples__canvas multiples__canvas--lines"
          style={{ ...canvasStyle, opacity: dimmed ? DIM_ELEMENT_OPACITY : 1 }}
        />
        <canvas ref={spinesRef} className="multiples__canvas" style={canvasStyle} />

        {/* Labels and hit areas as DOM, over one canvas of pixels — the window's only. */}
        {panels.map((panel, local) => {
          const index = first + local
          const rect = rectOf(index)
          const onSpine = focusSpine?.panel === index
          const clustered = clusterRun?.byTypology.has(panel.typology.key) === true
          return (
            <Fragment key={panel.typology.key}>
              <button
                type="button"
                className="multiples__panel"
                data-hovered={hovered === index}
                data-spine={onSpine}
                style={{
                  left: rect.left,
                  top: rect.top,
                  width: rect.width,
                  height: rect.height,
                }}
                /*
                 * No `title`: a native tooltip appears under the pointer, which is
                 * where the dots' own panel appears, so the browser covered the
                 * sequence with a worse rendering of it. The hint lives in that
                 * panel now, which is also where someone reading the run is
                 * already looking.
                 */
                aria-label={`${panel.typology.key} — open it alone, full size`}
                onPointerEnter={() => setHovered(index)}
                onPointerMove={(event) => handleMove(index, event)}
                onPointerLeave={() => handleLeave(index)}
                onClick={(event) => {
                  /*
                   * A spine under the cursor makes the click mean the cluster, not
                   * the panel — and it opens the typology *and* isolates it in one
                   * move, because isolating a cluster inside a grid of eight other
                   * panels would be a change you could not see.
                   */
                  const cluster = clusterAt(
                    index,
                    event.clientX,
                    event.clientY,
                    event.currentTarget.getBoundingClientRect(),
                  )
                  if (cluster !== null) focusCluster(panel.typology.key, cluster)
                  else selectTypologies([panel.typology.key])
                }}
              >
                {/*
                 * Under the ladder, not over it: a caption belongs where the eye
                 * lands after reading the shape, and a header pushed every panel's
                 * first row down by its own height.
                 */}
                <span className="multiples__foot" style={{ height: FOOTER }}>
                  <span className="multiples__key">
                    <StateDots
                      states={panel.steps}
                      labels={panel.labels}
                      repeated={panel.repeated}
                      palette={palette}
                      // The compact grid names the hovered card's rules beside it.
                      reveal={isDetailed}
                      hint={
                        onSpine
                          ? "click the spine to isolate that cluster"
                          : "click to open this typology full size"
                      }
                    />
                    <span className="multiples__steps">
                      {isDetailed ? panel.typology.key : `${panel.steps.length} steps`}
                    </span>{" "}
                  </span>
                  <span
                    className="multiples__size"
                    data-sampled={panel.drawn < panel.size}
                    title={
                      panel.drawn < panel.size
                        ? `${panel.size.toLocaleString()} patients — every ${Math.round(
                            panel.size / panel.drawn,
                          )}th drawn, which is as many as the panel can show`
                        : `${panel.size.toLocaleString()} patients`
                    }
                  >
                    {panel.size.toLocaleString()}
                  </span>
                </span>
              </button>
              {/*
               * Beside the card rather than in it — a button inside a button is
               * invalid — and pinned to its corner. Entering it keeps the card
               * hovered, or the button would vanish under the pointer reaching it.
               */}
              <button
                type="button"
                className="button button--tiny multiples__export"
                data-shown={hovered === index}
                style={{ left: rect.left + rect.width, top: rect.top + rect.height }}
                // disabled={!clustered || panel.size === 0}
                aria-disabled={!clustered || panel.size === 0}
                title={
                  clustered
                    ? "Export this typology's cluster memberships (TSV)"
                    : "Not clustered yet — nothing to export"
                }
                aria-label={`Export the memberships of ${panel.typology.key}`}
                onPointerEnter={() => setHovered(index)}
                onPointerLeave={() => setHovered((current) => (current === index ? null : current))}
                onClick={() => exportMemberships(panel.typology.key)}
              >
                ⤓ TSV
              </button>
            </Fragment>
          )
        })}

        {/* Detailed cards label their own rules in the gutter already. */}
        {labelWidth === 0 && reference !== null && panels[reference - first] !== undefined && (
          <ReferenceLabels
            panels={panels}
            first={first}
            reference={reference}
            rectOf={rectOf}
            rowPitch={rowPitch}
            palette={palette.css}
          />
        )}
      </div>
    </div>
  )
}

/** One card's worth of the grid: its ladder, and the cohort drawn on it. */
interface Panel {
  readonly typology: Typology
  readonly steps: readonly number[]
  readonly repeated: readonly boolean[]
  readonly labels: readonly string[]
  readonly rows: Float32Array
  /** Members passing the filters. */
  readonly size: number
  /** Of those, how many are drawn — fewer once the cohort is past `budget`. */
  readonly drawn: number
  readonly geometry: Geometry
}

/**
 * A row per step of the sequence, and geometry for the members of it that
 * survive the filters.
 *
 * `rowsFrom: "position"` in `options` puts the step index in the buffer where
 * the state id normally goes, so the row lookup is the identity and a revisited
 * state cannot collapse onto its first appearance.
 */
function buildPanel(
  store: TrajectoryStore,
  typology: Typology,
  mask: Uint8Array | null,
  budget: number,
  options: GeometryOptions,
): Panel {
  const steps = Array.from(typology.states)
  const rows = new Float32Array(steps.length)
  for (let i = 0; i < steps.length; i++) rows[i] = i

  const members: number[] = []
  for (let i = 0; i < typology.patients.length; i++) {
    const patient = typology.patients[i] as number
    if (mask === null || mask[patient] === 1) members.push(patient)
  }

  /*
   * Every nth member, when there are more than the panel can show. A stride
   * over a list in patient order is an unbiased sample of the cohort, and a
   * fixed one keeps the picture identical between repaints — a random sample
   * would reshuffle the panel every time the layout changed.
   */
  const stride = Math.max(1, Math.ceil(members.length / budget))
  const drawn = stride === 1 ? members : members.filter((_, i) => i % stride === 0)

  return {
    typology,
    steps,
    repeated: repeatedSteps(typology.states),
    labels: sequenceLabels(typology.states, store.stateNames),
    rows,
    size: members.length,
    drawn: drawn.length,
    geometry: buildGeometry(store, Uint32Array.from(drawn), options),
  }
}

/** The nearest ancestor that scrolls vertically, or `null` for the page itself. */
function scrollParent(element: HTMLElement): HTMLElement | null {
  for (let node = element.parentElement; node !== null; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node)
    if (overflowY === "auto" || overflowY === "scroll") return node
  }
  return null
}

/** Where a rule sits in its card, in CSS pixels from the card's top. */
const ruleY = (row: number, rowPitch: number): number => PANEL_TOP + (row + 0.5) * rowPitch

/**
 * The compact grid's state names, relative to the card under the pointer.
 *
 * A compact card has no room to name its rules, so the colours had to be looked
 * up — in the States panel, or by resting on the dots. Here the hovered card's
 * names stand beside it, one on each rule, and every *other* card names only
 * the rules where it differs from the hovered one, step for step. A rule left
 * unlabelled is the same state as the hovered card's at that step, so one
 * legend reads the whole grid, and what is labelled is exactly what changed.
 *
 * The legend goes on the card's left, over the neighbour's edge, where the eye
 * starts reading a rule; a first-column card has no left, so it goes right.
 * The others' labels keep off the lines: every trajectory descends left to
 * right, so a top rule's segments sit at its left end and a bottom rule's at its
 * right — each label takes the far end of its rule. The neighbour the legend
 * lies over is the exception: its labels take the end the legend leaves clear.
 */
function ReferenceLabels({
  panels,
  first,
  reference,
  rectOf,
  rowPitch,
  palette,
}: {
  readonly panels: readonly {
    readonly typology: Typology
    readonly steps: readonly number[]
    readonly labels: readonly string[]
  }[]
  /** Grid index of `panels[0]`; `reference` and `rectOf` take grid indices. */
  readonly first: number
  readonly reference: number
  readonly rectOf: (index: number) => { left: number; top: number; width: number }
  readonly rowPitch: number
  readonly palette: readonly string[]
}): React.JSX.Element {
  const hovered = panels[reference - first] as (typeof panels)[number]
  const anchor = rectOf(reference)
  const onLeft = anchor.left > 0
  // Same grid row either way: a card with something on its left is not first
  // in its row, and a first-column card has a neighbour on its right.
  const covered = onLeft ? reference - 1 : reference + 1

  return (
    <div className="multiples__labels" aria-hidden="true">
      {hovered.steps.map((state, row) => (
        <span
          key={`reference-${row}`}
          className="multiples__label multiples__label--reference"
          style={{
            top: anchor.top + ruleY(row, rowPitch),
            left: onLeft ? anchor.left - 6 : anchor.left + anchor.width + 6,
            transform: onLeft ? "translate(-100%, -50%)" : "translateY(-50%)",
            color: palette[state],
          }}
        >
          {hovered.labels[row]}
        </span>
      ))}

      {panels.map((panel, local) => {
        const index = first + local
        if (index === reference) return null
        const rect = rectOf(index)

        return panel.steps.map((state, row) => {
          if (hovered.steps[row] === state) return null
          const atEnd = index === covered ? !onLeft : row < panel.steps.length / 2
          return (
            <span
              key={`${panel.typology.key}-${row}`}
              className="multiples__label"
              style={{
                top: rect.top + ruleY(row, rowPitch),
                left: atEnd ? rect.left + rect.width - 4 : rect.left + 4,
                transform: atEnd ? "translate(-100%, -50%)" : "translateY(-50%)",
                color: palette[state],
              }}
            >
              ≠{panel.labels[row]}
            </span>
          )
        })
      })}
    </div>
  )
}
