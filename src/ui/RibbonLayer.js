import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useMemo } from "react";
/**
 * PARKED — not mounted by the chart. The aggregate reading is `LumpLayer` now.
 *
 * This draws a group's median path with a size-scaled half-width, which is a
 * different object from a lump: it follows one group across all of its states
 * rather than collapsing one state *pair*. It is kept, with its builder in
 * `core/render/ribbons.ts` and their tests, because it is the natural shape for
 * a clustered grouping to take if clustering comes back.
 *
 * The aggregated reading: one shape per group instead of one line per patient.
 *
 * Ribbons live in SVG rather than on the canvas because there are at most a few
 * dozen of them — the exact opposite of the individuals layer. At that count DOM
 * is the cheaper choice and it brings hover, click and crisp edges for free,
 * which is the same split that keeps the hairline layer on the GPU.
 */
export function RibbonLayer({ ribbons, width, height, marginY, xDomain, rowCount, palette, selected, onToggle, }) {
    const project = useMemo(() => {
        const [x0, x1] = xDomain;
        const span = Math.max(x1 - x0, 1e-6);
        const usable = Math.max(height - 2 * marginY, 1);
        const rowHeight = usable / Math.max(rowCount, 1);
        return {
            x: (value) => ((value - x0) / span) * width,
            y: (row) => marginY + (row + 0.5) * rowHeight,
            rowHeight,
        };
    }, [xDomain, width, height, marginY, rowCount]);
    const shapes = useMemo(() => ribbons.map((ribbon) => ({
        ribbon,
        body: ribbonPath(ribbon, project),
        spread: spreadPath(ribbon, project),
        color: palette.css[ribbon.index % palette.css.length] ?? "#888",
    })), [ribbons, project, palette]);
    if (width === 0 || height === 0 || ribbons.length === 0)
        return null;
    return (_jsx("svg", { className: "chart__ribbons", width: width, height: height, children: shapes.map(({ ribbon, body, spread, color }) => {
            const isSelected = selected.has(ribbon.index);
            const isDimmed = selected.size > 0 && !isSelected;
            return (_jsxs("g", { className: "ribbon", "data-selected": isSelected, opacity: isDimmed ? 0.18 : 1, onPointerDown: (event) => {
                    event.stopPropagation();
                    onToggle(ribbon.index);
                }, children: [_jsx("path", { d: spread, fill: color, opacity: 0.12 }), _jsx("path", { d: body, fill: color, opacity: 0.72, stroke: color, strokeWidth: 0.5 }), _jsx("title", { children: `${ribbon.label} · ${ribbon.size.toLocaleString()} patients` })] }, ribbon.index));
        }) }));
}
/** Median path, thickened vertically by half-width (in row units). */
function ribbonPath(ribbon, project) {
    const top = [];
    const bottom = [];
    for (let k = 0; k < ribbon.x.length; k++) {
        const x = project.x(ribbon.x[k]);
        const row = ribbon.row[k];
        const half = ribbon.halfWidth[k] * project.rowHeight;
        top.push(`${x.toFixed(1)},${(project.y(row) - half).toFixed(1)}`);
        bottom.push(`${x.toFixed(1)},${(project.y(row) + half).toFixed(1)}`);
    }
    bottom.reverse();
    return `M${top.join("L")}L${bottom.join("L")}Z`;
}
/** The 25th–75th percentile arrival window at each state. */
function spreadPath(ribbon, project) {
    const low = [];
    const high = [];
    for (let k = 0; k < ribbon.x.length; k++) {
        const y = project.y(ribbon.row[k]);
        low.push(`${project.x(ribbon.spreadLow[k]).toFixed(1)},${y.toFixed(1)}`);
        high.push(`${project.x(ribbon.spreadHigh[k]).toFixed(1)},${y.toFixed(1)}`);
    }
    high.reverse();
    return `M${low.join("L")}L${high.join("L")}Z`;
}
