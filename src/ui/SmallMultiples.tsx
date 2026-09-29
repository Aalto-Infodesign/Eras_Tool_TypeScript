import { useEffect, useMemo, useRef, useState } from "react"

import { useEras } from "../app/store.ts"
import { buildGeometry, type GeometryOptions } from "../core/render/geometry.ts"
import { buildPalette } from "../core/render/palette.ts"
import { paintGeometry } from "../core/render/paint2d.ts"
import type { Typology } from "../core/types.ts"

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
 * One canvas, not one per panel: browsers cap the number of live contexts, and
 * a grid of them would also mean a resize observer and a draw loop each. The
 * panels are rectangles of a single context, which is exactly what `paint2d`
 * was extracted for.
 */

const MIN_PANEL = 200
const PANEL_GAP = 12
/** Constant across panels — this is what makes two slopes comparable. */
const ROW_PITCH = 20
const PANEL_TOP = 10
/** Below the last row: the label strip. */
const FOOTER = 20
/** Past this the grid is unreadable anyway, and the canvas gets silly tall. */
const MAX_PANELS = 24

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
  const focusTypology = useEras((s) => s.focusTypology)

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [hovered, setHovered] = useState<number | null>(null)

  const palette = useMemo(
    () => buildPalette(store?.stateNames.length ?? 0),
    [store?.stateNames.length],
  )

  /*
   * What gets a panel. The selection when there is one — that is the case this
   * view exists for — and otherwise the biggest few, so the mode is readable
   * the moment it is switched on rather than showing an empty grid.
   */
  const shown = useMemo<readonly Typology[]>(() => {
    const keys = new Set(selected)
    const chosen = keys.size > 0 ? typologies.filter((t) => keys.has(t.key)) : typologies
    return chosen.slice(0, MAX_PANELS)
  }, [typologies, selected])

  const hiddenCount = (selected.length > 0 ? selected.length : typologies.length) - shown.length

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

      return {
        typology,
        steps,
        rows,
        size: members.length,
        geometry: buildGeometry(store, Uint32Array.from(members), {
          ...options,
          rowsFrom: "position",
        }),
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, shown, options, selection, selectionVersion])

  /*
   * One height for every cell, sized to the longest sequence on screen. Panels
   * are top-aligned inside it, so the pitch is identical and a short sequence
   * simply stops early.
   */
  const maxSteps = panels.reduce((most, panel) => Math.max(most, panel.steps.length), 1)
  const panelHeight = PANEL_TOP + maxSteps * ROW_PITCH + FOOTER

  const columns = Math.max(1, Math.floor((width + PANEL_GAP) / (MIN_PANEL + PANEL_GAP)))
  const panelWidth = Math.floor((width - PANEL_GAP * (columns - 1)) / Math.max(columns, 1))
  const gridRows = Math.ceil(panels.length / Math.max(columns, 1))
  const height = Math.max(1, gridRows * (panelHeight + PANEL_GAP))

  const rectOf = (
    index: number,
  ): { left: number; top: number; width: number; height: number } => ({
    left: (index % columns) * (panelWidth + PANEL_GAP),
    top: Math.floor(index / columns) * (panelHeight + PANEL_GAP),
    width: panelWidth,
    height: panelHeight,
  })

  useEffect(() => {
    const canvas = canvasRef.current
    if (canvas === null || width === 0 || store === null) return

    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.max(1, Math.round(width * dpr))
    canvas.height = Math.max(1, Math.round(height * dpr))

    const ctx = canvas.getContext("2d")
    if (ctx === null) return
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, canvas.width, canvas.height)

    panels.forEach((panel, index) => {
      const rect = rectOf(index)
      const target = {
        x: rect.left * dpr,
        y: rect.top * dpr,
        width: rect.width * dpr,
        height: rect.height * dpr,
      }

      // A rule per *step*, in that step's state colour, at a fixed pitch from
      // the top. Two visits to one state therefore get two rules of the same
      // colour, which is what tells you the sequence came back.
      ctx.lineWidth = dpr
      for (let row = 0; row < panel.steps.length; row++) {
        const y = target.y + (PANEL_TOP + (row + 0.5) * ROW_PITCH) * dpr
        ctx.globalAlpha = 0.28
        ctx.strokeStyle = palette.css[panel.steps[row] as number] ?? "#fff"
        ctx.beginPath()
        ctx.moveTo(target.x, y)
        ctx.lineTo(target.x + target.width, y)
        ctx.stroke()
      }
      ctx.globalAlpha = 1

      /*
       * `paintGeometry` spreads `rowCount` rows across the height it is given,
       * so the band it is handed is exactly the ladder: top margin, then the
       * steps at the shared pitch. The footer sits below it, untouched.
       */
      paintGeometry(ctx, panel.geometry, {
        target: { ...target, height: (PANEL_TOP * 2 + panel.steps.length * ROW_PITCH) * dpr },
        xDomain,
        rows: panel.rows,
        rowCount: panel.steps.length,
        marginY: PANEL_TOP * dpr,
        opacity,
        lineWidth: dpr,
        fade: 0,
        background,
        /*
         * The source→target blend, which the GPU gets per vertex for free and
         * the 2D painter otherwise approximates with a step at the midpoint.
         * Here every segment on a row descends to the next one, so the
         * transition is a function of y and one gradient per step reproduces it
         * exactly. See `PaintOptions.rowColors`.
         */
        rowColors: panel.steps.map((state) => palette.css[state] ?? "currentColor"),
      })
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panels, width, height, columns, panelWidth, panelHeight, xDomain, opacity, background, palette, store])

  if (store === null || panels.length === 0) return null

  return (
    <div className="multiples">
      <div className="multiples__grid" style={{ height }}>
        <canvas ref={canvasRef} className="multiples__canvas" style={{ width, height }} />

        {/* Labels and hit areas as DOM, over one canvas of pixels. */}
        {panels.map((panel, index) => {
          const rect = rectOf(index)
          return (
            <button
              key={panel.typology.key}
              type="button"
              className="multiples__panel"
              data-hovered={hovered === index}
              style={{
                left: rect.left,
                top: rect.top,
                width: rect.width,
                height: rect.height,
              }}
              title={`${panel.typology.key} — click to open it on its own steps`}
              onPointerEnter={() => setHovered(index)}
              onPointerLeave={() => setHovered((current) => (current === index ? null : current))}
              onClick={() => focusTypology(panel.typology.key)}
            >
              {/*
               * Under the ladder, not over it: a caption belongs where the eye
               * lands after reading the shape, and a header pushed every panel's
               * first row down by its own height.
               */}
              <span className="multiples__foot" style={{ height: FOOTER }}>
                <span className="multiples__key">
                  {panel.steps.map((state, step) => (
                    <span
                      key={step}
                      className="multiples__swatch"
                      style={{ background: palette.css[state] }}
                      title={store.stateNames[state]}
                    />
                  ))}
                  <span className="multiples__steps">{panel.steps.length} steps</span>
                </span>
                <span className="multiples__size">{panel.size.toLocaleString()}</span>
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
