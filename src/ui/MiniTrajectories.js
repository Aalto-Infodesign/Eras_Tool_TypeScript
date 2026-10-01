import { jsx as _jsx } from "react/jsx-runtime";
import { useEffect, useMemo, useState } from "react";
import { useEras } from "../app/store.ts";
import { xDomainOf } from "../core/query/extent.ts";
import { buildGeometry } from "../core/render/geometry.ts";
import { paintGeometry } from "../core/render/paint2d.ts";
import { buildPalette } from "../core/render/palette.ts";
import { panelTypologies } from "../core/stats/silhouettes.ts";
import { strideIndices } from "../core/util/sample.ts";
import { useElementSize } from "./useRenderer.ts";
/** The grid's first panels, at most — a thumbnail of the grid, not the grid. */
const MINI_PANELS = 6;
/** Trajectories drawn per panel. At this size more lines are the same pixels again. */
const MINI_BUDGET = 200;
const MINI_GAP = 6;
/** Above and below the rungs, inside each panel. */
const MINI_MARGIN = 4;
/**
 * A floor under the store's line opacity. The main chart's default suits a
 * field of thousands; a panel of two hundred at that alpha is barely there, and
 * a thumbnail has to read at a glance.
 */
const MINI_MIN_OPACITY = 0.45;
/**
 * The Trajectories view in miniature, for the View panel while the Sankey has
 * the main area.
 *
 * It reproduces what swapping would show rather than a generic picture of the
 * data: the one typology on its own steps when exactly one is selected, else
 * the first panels of the small-multiples grid — the same `panelTypologies`
 * rule, so the thumbnail and the grid cannot disagree about which typologies
 * lead. Drawn the way the grid draws: each panel a ladder of its own steps at
 * one shared pitch, top-aligned, with the duration filter dropping the segments
 * the real view drops.
 *
 * One 2D canvas, painted in device pixels with `paintGeometry` — never a second
 * WebGL context, which the main chart may be holding, and never `useChartLayers`,
 * which would build the full bulk geometry for a few hundred pixels. Each panel
 * draws a fixed-stride sample of its live members, so the picture is stable
 * between repaints.
 */
export function MiniTrajectories() {
    const store = useEras((s) => s.store);
    const typologies = useEras((s) => s.typologies);
    const selected = useEras((s) => s.selectedTypologies);
    const selection = useEras((s) => s.selection);
    const selectionVersion = useEras((s) => s.selectionVersion);
    const axis = useEras((s) => s.axis);
    const xDomainOverride = useEras((s) => s.xDomainOverride);
    const opacity = useEras((s) => s.opacity);
    const durationRange = useEras((s) => s.filters.duration);
    // Elements, not refs: the panel body remounts every time it is unfolded.
    const [host, setHost] = useState(null);
    const [canvas, setCanvas] = useState(null);
    // The host's content box — the frame less its padding — is what the canvas
    // fills, so the picture is sized from it rather than from the frame's height.
    const { width, height } = useElementSize(host);
    const stateCount = store?.stateNames.length ?? 0;
    const palette = useMemo(() => buildPalette(stateCount), [stateCount]);
    const xDomain = useMemo(() => xDomainOf(store, axis, xDomainOverride), [store, axis, xDomainOverride]);
    const options = useMemo(() => ({
        axis,
        color: { kind: "state", palette },
        durationRange,
        rowsFrom: "position",
    }), [axis, palette, durationRange]);
    const panels = useMemo(() => {
        if (store === null)
            return [];
        const shown = selected.length === 1
            ? panelTypologies(typologies, selected, 1)
            : panelTypologies(typologies, selected, MINI_PANELS);
        const mask = selection?.mask ?? null;
        return shown.map((typology) => {
            const live = [];
            for (let i = 0; i < typology.patients.length; i++) {
                const patient = typology.patients[i];
                if (mask === null || mask[patient] === 1)
                    live.push(patient);
            }
            const picks = strideIndices(live.length, MINI_BUDGET);
            const sample = Uint32Array.from(picks, (i) => live[i]);
            const rows = new Float32Array(typology.states.length);
            for (let i = 0; i < rows.length; i++)
                rows[i] = i;
            return { typology, rows, geometry: buildGeometry(store, sample, options) };
        });
    }, 
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [store, typologies, selected, selection, selectionVersion, options]);
    useEffect(() => {
        if (canvas === null || width === 0 || height === 0)
            return;
        const dpr = window.devicePixelRatio || 1;
        const w = Math.max(1, Math.round(width * dpr));
        const h = Math.max(1, Math.round(height * dpr));
        // Assigning either one reallocates the backing store even when unchanged.
        if (canvas.width !== w)
            canvas.width = w;
        if (canvas.height !== h)
            canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (ctx === null)
            return;
        // `paintGeometry` works in device pixels, so no DPR transform: one under it
        // would scale every target, margin and line width a second time.
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, w, h);
        if (panels.length === 0)
            return;
        const columns = panels.length === 1 ? 1 : panels.length <= 4 ? 2 : 3;
        const gridRows = Math.ceil(panels.length / columns);
        const cellWidth = (width - MINI_GAP * (columns - 1)) / columns;
        const cellHeight = (height - MINI_GAP * (gridRows - 1)) / gridRows;
        // One pitch for every panel, as the grid does: a short sequence is a shorter
        // ladder, not a stretched one, so the slopes stay comparable.
        let maxSteps = 1;
        for (const panel of panels)
            maxSteps = Math.max(maxSteps, panel.typology.states.length);
        const pitch = Math.max(1, (cellHeight - 2 * MINI_MARGIN) / maxSteps);
        panels.forEach((panel, index) => {
            const left = (index % columns) * (cellWidth + MINI_GAP);
            const top = Math.floor(index / columns) * (cellHeight + MINI_GAP);
            const steps = panel.typology.states;
            const target = {
                x: left * dpr,
                y: top * dpr,
                width: cellWidth * dpr,
                height: (2 * MINI_MARGIN + steps.length * pitch) * dpr,
            };
            // The ladder: a rule per step in that step's colour.
            ctx.lineWidth = dpr;
            ctx.globalAlpha = 0.28;
            for (let row = 0; row < steps.length; row++) {
                const y = (top + MINI_MARGIN + (row + 0.5) * pitch) * dpr;
                ctx.strokeStyle = palette.css[steps[row]] ?? "#fff";
                ctx.beginPath();
                ctx.moveTo(target.x, y);
                ctx.lineTo(target.x + target.width, y);
                ctx.stroke();
            }
            paintGeometry(ctx, panel.geometry, {
                target,
                xDomain,
                rows: panel.rows,
                rowCount: steps.length,
                marginY: MINI_MARGIN * dpr,
                opacity: Math.max(opacity, MINI_MIN_OPACITY),
                lineWidth: dpr,
                fade: 0,
                background: [0, 0, 0],
                rowColors: Array.from(steps, (state) => palette.css[state] ?? "currentColor"),
            });
        });
        ctx.globalAlpha = 1;
    }, [canvas, width, height, panels, palette, xDomain, opacity]);
    return (_jsx("div", { ref: setHost, className: "viewswitch__canvas", children: _jsx("canvas", { ref: setCanvas }) }));
}
