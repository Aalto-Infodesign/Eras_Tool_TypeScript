import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { useEras } from "../app/store.ts"
import { clusterMembers, medoidPatients } from "../core/cluster/medoids.ts"
import { TOP_CLUSTER_LIMIT } from "../core/cluster/types.ts"
import { buildGeometry, type Geometry, type GeometryOptions } from "../core/render/geometry.ts"
import { mixToward, paintGeometry } from "../core/render/paint2d.ts"
import { buildPalette, packedRgb } from "../core/render/palette.ts"
import { SegmentIndex } from "../core/render/picking.ts"
import { repeatedSteps, sequenceLabels } from "../core/stats/silhouettes.ts"
import type { Typology } from "../core/types.ts"
import { StateDots } from "./StateDots.tsx"
import { createHoverSettler, HIGHLIGHT_OPACITY } from "./hover.ts"
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
 * and a grid of twenty-four would also mean a resize observer and a draw loop
 * each. The panels are rectangles of shared contexts, which is exactly what
 * `paint2d` was extracted for.
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
/** Past this the grid is unreadable anyway, and the canvas gets silly tall. */
const MAX_PANELS = 24
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
   * biggest few, because this is the view the app opens on. A path selection can
   * name hundreds, and past `MAX_PANELS` a grid says no more than the overlay it
   * replaced.
   */
  const shown = useMemo<readonly Typology[]>(() => {
    if (selected.length === 0) return typologies.slice(0, MAX_PANELS)
    const keys = new Set(selected)
    return typologies.filter((t) => keys.has(t.key)).slice(0, MAX_PANELS)
  }, [typologies, selected])

  const hiddenCount = (selected.length === 0 ? typologies.length : selected.length) - shown.length

  /*
   * How much room a panel gets, and with it how much of its cohort is worth
   * drawing. Read off `shown` rather than off `panels`, because the geometry
   * below needs the budget it decides.
   */
  const isDetailed = shown.length <= DETAILED_LIMIT
  const budget = isDetailed ? DETAILED_BUDGET : COMPACT_BUDGET

  /**
   * Per panel: a row per step of the sequence, and geometry for the members of
   * it that survive the filters.
   *
   * `rowsFrom: "position"` puts the step index in the buffer where the state id
   * normally goes, so the row lookup is the identity and a revisited state
   * cannot collapse onto its first appearance.
   */
  const panels = useMemo(() => {
    if (store === null) return []

    return shown.map((typology) => {
      const steps = Array.from(typology.states)
      const rows = new Float32Array(steps.length)
      for (let i = 0; i < steps.length; i++) rows[i] = i

      const mask = selection?.mask ?? null
      const members: number[] = []
      for (let i = 0; i < typology.patients.length; i++) {
        const patient = typology.patients[i] as number
        if (mask === null || mask[patient] === 1) members.push(patient)
      }

      /*
       * Every nth member, when there are more than the panel can show. A stride
       * over a list in patient order is an unbiased sample of the cohort, and a
       * fixed one keeps the picture identical between repaints — a random
       * sample would reshuffle the panel every time the layout changed.
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
        geometry: buildGeometry(store, Uint32Array.from(drawn), panelOptions),
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, shown, panelOptions, selection, selectionVersion, budget])

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

    const panel = panels.findIndex((candidate) => candidate.typology.key === ref.typologyKey)
    if (panel === -1) return null

    return { panel, geometry: buildGeometry(store, Uint32Array.of(ref.medoidPatient), panelOptions) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, showSpines, pointedCluster, clusterRun, clusterVersion, panels, panelOptions])

  /** The members of the settled cluster, and which panel they belong under. */
  const highlight = useMemo<{
    panel: number
    members: Geometry
  } | null>(() => {
    if (store === null || !showSpines || hoveredCluster === null || clusterRun === null) return null

    const ref = clusterRun.clusters[hoveredCluster]
    if (ref === undefined) return null

    const panel = panels.findIndex((candidate) => candidate.typology.key === ref.typologyKey)
    if (panel === -1) return null

    const members = clusterMembers(clusterRun, [hoveredCluster], selection?.mask ?? null)
    if (members.length === 0) return null

    return { panel, members: buildGeometry(store, members, panelOptions) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    store,
    showSpines,
    hoveredCluster,
    clusterRun,
    clusterVersion,
    panels,
    selection,
    selectionVersion,
    panelOptions,
  ])

  /*
   * One height for every cell, sized to the longest sequence on screen. Panels
   * are top-aligned inside it, so the pitch is identical and a short sequence
   * simply stops early.
   */
  const rowPitch = isDetailed ? DETAILED_PITCH : COMPACT_PITCH
  const labelWidth = isDetailed ? LABEL_WIDTH : 0

  const maxSteps = panels.reduce((most, panel) => Math.max(most, panel.steps.length), 1)
  const panelHeight = PANEL_TOP + maxSteps * rowPitch + FOOTER

  const columns = Math.max(
    1,
    Math.min(
      panels.length || 1,
      isDetailed ? DETAILED_COLUMNS : COMPACT_COLUMNS,
    ),
  )
  const panelWidth = Math.floor((width - PANEL_GAP * (columns - 1)) / Math.max(columns, 1))
  const gridRows = Math.ceil(panels.length / Math.max(columns, 1))
  const height = Math.max(1, gridRows * (panelHeight + PANEL_GAP))

  /** Where a panel sits in the grid, in CSS pixels. The one definition of it. */
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
   * being drawn.
   */
  const bandOf = useCallback(
    (index: number, panel: (typeof panels)[number], dpr: number) => {
      const rect = rectOf(index)

      return {
        panelX: rect.left * dpr,
        panelY: rect.top * dpr,
        panelWidth: rect.width * dpr,
        target: {
          x: (rect.left + labelWidth) * dpr,
          y: rect.top * dpr,
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
    [rectOf, labelWidth, rowPitch, xDomain, background],
  )

  /** Sizes a layer to the grid and clears it. `null` while it is unmounted. */
  const prepare = useCallback(
    (canvas: HTMLCanvasElement | null, dpr: number): CanvasRenderingContext2D | null => {
      if (canvas === null || width === 0) return null

      const w = Math.max(1, Math.round(width * dpr))
      const h = Math.max(1, Math.round(height * dpr))

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
    [width, height],
  )

  // Layer 1 — the ladders. A rule per *step*, in that step's state colour, at a
  // fixed pitch from the top. Two visits to one state therefore get two rules of
  // the same colour, which is what tells you the sequence came back.
  useEffect(() => {
    const dpr = window.devicePixelRatio || 1
    const ctx = prepare(rulesRef.current, dpr)
    if (ctx === null) return

    ctx.lineWidth = dpr

    panels.forEach((panel, index) => {
      const band = bandOf(index, panel, dpr)

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
  }, [panels, prepare, bandOf, rowPitch, labelWidth, palette])

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
   */
  useEffect(() => {
    const dpr = window.devicePixelRatio || 1
    const ctx = prepare(linesRef.current, dpr)
    if (ctx === null) return

    panels.forEach((panel, index) => {
      paintGeometry(ctx, panel.geometry, {
        ...bandOf(index, panel, dpr),
        opacity: lineOpacity,
        lineWidth: dpr,
        rowColors: panel.steps.map((state) => lineColors[state] ?? "currentColor"),
      })
    })
  }, [panels, prepare, bandOf, lineOpacity, lineColors])

  // Layer 3 — the summaries, and whatever is being pointed at. Cheap by
  // construction: a handful of spines per panel, and one cluster's members.
  useEffect(() => {
    const dpr = window.devicePixelRatio || 1
    const ctx = prepare(spinesRef.current, dpr)
    if (ctx === null) return

    panels.forEach((panel, index) => {
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
      paintGeometry(ctx, spines[index] ?? null, {
        ...band,
        opacity: focusSpine === null ? SPINE_OPACITY : SPINE_DIMMED_OPACITY,
        lineWidth: SPINE_WIDTH * dpr,
        rowColors: colors,
      })

      if (focusSpine !== null && focusSpine.panel === index) {
        paintGeometry(ctx, focusSpine.geometry, {
          ...band,
          opacity: SPINE_OPACITY,
          lineWidth: SPINE_FOCUS_WIDTH * dpr,
          rowColors: colors,
        })
      }
    })
  }, [panels, spines, lit, focus, focusSpine, prepare, bandOf, palette])

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
      const panel = panels[index]
      const pick = spineIndex[index]
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
    [panels, spineIndex, clusterRun, labelWidth, xDomain, rowPitch],
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

  if (store === null || panels.length === 0) return null

  return (
    <div className="multiples">
      <div className="multiples__grid" style={{ height }}>
        {/*
          * Three layers, one grid. Only the middle one carries the cost, and it
          * is the one a hover never touches: the dim is a composited opacity on
          * an element whose pixels the browser already has.
          */}
        <canvas ref={rulesRef} className="multiples__canvas" style={{ width, height }} />
        <canvas
          ref={linesRef}
          className="multiples__canvas multiples__canvas--lines"
          style={{ width, height, opacity: dimmed ? DIM_ELEMENT_OPACITY : 1 }}
        />
        <canvas ref={spinesRef} className="multiples__canvas" style={{ width, height }} />

        {/* Labels and hit areas as DOM, over one canvas of pixels. */}
        {panels.map((panel, index) => {
          const rect = rectOf(index)
          const onSpine = focusSpine?.panel === index
          return (
            <button
              key={panel.typology.key}
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
              title={
                onSpine
                  ? "Open this typology with that cluster isolated"
                  : `${panel.typology.key} — click to open it alone, full size`
              }
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
                  />
                  <span className="multiples__steps">
                    {isDetailed ? panel.typology.key : `${panel.steps.length} steps`}
                  </span>
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
          )
        })}
      </div>

      {hiddenCount > 0 && (
        <p className="multiples__more">
          +{hiddenCount.toLocaleString()} more — a grid past {MAX_PANELS} panels is no more
          readable than the overlay it replaced.
        </p>
      )}
    </div>
  )
}
