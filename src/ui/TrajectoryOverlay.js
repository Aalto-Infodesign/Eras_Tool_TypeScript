import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useMemo } from "react";
import { useEras } from "../app/store.ts";
/**
 * The handful of trajectories that are hovered or selected, drawn thick and
 * opaque over everything else.
 *
 * This is the split that makes the whole thing fast — the canvas draws the
 * hundreds of thousands of lines nobody interacts with individually, and SVG
 * draws the two or three that carry the interaction. The original put *every*
 * line in SVG, which meant paying interaction cost for lines that were one
 * pixel of a dense mass.
 *
 * The row lines and labels this used to carry now live in `ChartGrid`, under the
 * aggregate layers rather than over them.
 */
export function TrajectoryOverlay({ width, height, marginY, xDomain, rowOf, rowCount, byPosition, palette, }) {
    const store = useEras((s) => s.store);
    const axis = useEras((s) => s.axis);
    const hovered = useEras((s) => s.hoveredPatient);
    const selected = useEras((s) => s.selectedPatients);
    const rowHeight = useMemo(() => {
        const usable = Math.max(height - 2 * marginY, 1);
        return usable / Math.max(rowCount, 1);
    }, [height, marginY, rowCount]);
    const toPixels = useMemo(() => {
        const [x0, x1] = xDomain;
        const span = Math.max(x1 - x0, 1e-6);
        return {
            x: (value) => ((value - x0) / span) * width,
            y: (row) => marginY + (row + 0.5) * rowHeight,
        };
    }, [xDomain, width, marginY, rowHeight]);
    const highlighted = useMemo(() => {
        if (store === null)
            return [];
        const ids = hovered === null ? selected : [...selected, hovered];
        const unique = Array.from(new Set(ids));
        return unique.map((patient) => {
            const start = store.offsets[patient];
            const end = store.offsets[patient + 1];
            const xs = axis === "age" ? store.ages : store.years;
            const points = [];
            for (let e = start; e < end; e++) {
                // Focused, the row *is* the step — the same thing `buildGeometry` puts
                // in the buffer, recomputed here because the overlay reads the store.
                const row = byPosition ? e - start : rowOf[store.stateIds[e]];
                if (row < 0)
                    continue;
                points.push(`${toPixels.x(xs[e]).toFixed(1)},${toPixels.y(row).toFixed(1)}`);
            }
            return {
                patient,
                id: store.ids.at(patient),
                points: points.join(" "),
                isHovered: patient === hovered,
            };
        });
    }, [store, hovered, selected, axis, rowOf, byPosition, toPixels]);
    if (store === null || width === 0 || height === 0)
        return null;
    return (_jsxs("svg", { className: "chart__overlay", width: width, height: height, "aria-hidden": "true", children: [highlighted.map((trajectory) => (_jsxs("g", { children: [_jsx("polyline", { points: trajectory.points, className: "chart__highlight-halo", fill: "none" }), _jsx("polyline", { points: trajectory.points, className: trajectory.isHovered ? "chart__highlight chart__highlight--hovered" : "chart__highlight", fill: "none", stroke: palette.css[0] })] }, trajectory.patient))), hovered !== null && highlighted.length > 0 && (_jsx("text", { x: width - 8, y: 16, textAnchor: "end", className: "chart__hovered-label", children: store.ids.at(hovered) }))] }));
}
