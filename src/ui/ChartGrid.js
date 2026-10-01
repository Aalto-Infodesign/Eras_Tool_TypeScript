import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useMemo } from "react";
import { useEras } from "../app/store.ts";
/** Vertical rules every ten years, as the original's `DIV_INCREMENT`. */
const DECADE = 10;
/** Room left at the bottom for the decade labels. */
const AXIS_HEIGHT = 14;
/**
 * The chart's frame: a rule per decade with its label, and a rule per state row.
 *
 * Ported from the original `Grid.jsx`, with one unavoidable inversion. There the
 * grid was the first child of the trajectories SVG and everything drew over it;
 * here the hairlines live on a canvas, and no SVG can sit under a canvas. So the
 * grid is drawn on top at low opacity instead — visually the same reading, since
 * the rules are hairlines themselves.
 *
 * Row lines take their colour from the state palette, as in the original, which
 * is what lets a row be identified without reading its label.
 */
export function ChartGrid({ width, height, marginY, xDomain, rowOf, rowStates, rowLabels, byPosition, palette, }) {
    const store = useEras((s) => s.store);
    const stateOrder = rowStates;
    const project = useMemo(() => {
        const [x0, x1] = xDomain;
        const span = Math.max(x1 - x0, 1e-6);
        const usable = Math.max(height - 2 * marginY, 1);
        const rowHeight = usable / Math.max(stateOrder.length, 1);
        return {
            x: (value) => ((value - x0) / span) * width,
            y: (row) => marginY + (row + 0.5) * rowHeight,
        };
    }, [xDomain, width, height, marginY, stateOrder.length]);
    /**
     * Every multiple of ten inside the domain. The original asked d3 for a tick
     * count and got *about* a decade; asking for the decades themselves is both
     * simpler and what the axis actually claims to show.
     */
    const decades = useMemo(() => {
        const [x0, x1] = xDomain;
        if (!Number.isFinite(x0) || !Number.isFinite(x1) || x1 <= x0)
            return [];
        const out = [];
        for (let value = Math.ceil(x0 / DECADE) * DECADE; value <= x1; value += DECADE) {
            out.push(value);
        }
        return out;
    }, [xDomain]);
    if (store === null || width === 0 || height === 0)
        return null;
    const axisY = height - AXIS_HEIGHT;
    return (_jsxs("svg", { className: "chart__grid", width: width, height: height, "aria-hidden": "true", children: [_jsx("g", { className: "chart__decades", children: decades.map((value) => (_jsxs("g", { transform: `translate(${project.x(value).toFixed(1)} 0)`, children: [_jsx("line", { y1: 0, y2: axisY, className: "chart__decade-line" }), _jsx("text", { y: height - 4, className: "chart__decade-label", textAnchor: "middle", children: value })] }, value))) }), _jsx("g", { className: "chart__rows", children: stateOrder.map((state, index) => {
                    const row = byPosition ? index : (rowOf[state] ?? index);
                    return (_jsxs("g", { transform: `translate(0 ${project.y(row).toFixed(1)})`, children: [_jsx("line", { x1: 0, x2: width, className: "chart__rowline", stroke: palette.css[state] ?? "currentColor" }), _jsx("text", { x: 6, y: -7, className: "chart__rowlabel", fill: palette.css[state] ?? "currentColor", children: `${Math.round(row)} · ${rowLabels[index] ?? store.stateNames[state]}` })] }, index));
                }) })] }));
}
