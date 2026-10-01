import { jsx as _jsx, Fragment as _Fragment, jsxs as _jsxs } from "react/jsx-runtime";
import { useMemo } from "react";
/** Thickness of the range bar, in CSS pixels (the original's `strokeWidth={3}`). */
const BAR_HEIGHT = 5;
/** Half-height of a whisker's end cap. */
const CAP_HEIGHT = 4;
/** Width of the median tick. */
const MEDIAN_WIDTH = 1.5;
/** Gap between a bar's end and its extent label. */
const LABEL_GAP = 4;
/**
 * Extent labels sit *below* the rule, where the row's own label sits above it.
 *
 * They used to share the centre line, which was fine when a row was a state and
 * its label lived in the margin. On a ladder of steps the row label is on the
 * rule itself, and a bar that starts near the left edge put its `42y` straight
 * through the state's name. Splitting them vertically is the only arrangement
 * that cannot collide, whatever the domain does.
 */
const LABEL_BELOW = 11;
/**
 * Below this row pitch the labels would run into the neighbouring rows, so the
 * glyph keeps the bar and drops the text. A long sequence is exactly the case
 * where the rows are tight and the numbers are least readable anyway.
 */
const MIN_PITCH_FOR_LABELS = 30;
/**
 * One range-and-median glyph per row — the original's `BoxPlot`, per *visit*.
 *
 * The glyph reads as: how early and how late this step is reached, by whom.
 *
 * - the **bar** spans the drawn patients' min → max arrival at this step, with a
 *   tick at their median;
 * - the **whiskers** run from the bar's ends out to where the *whole cohort*
 *   reaches that state, capped at each extreme.
 *
 * That second part is the point, and it is what the rewrite had lost twice over.
 * It puts the typology inside the population it was drawn from, so a sequence
 * that arrives at `c` unusually late says so against everyone else who ever
 * reached `c`, rather than silently rescaling to itself.
 *
 * Rows are steps now, not states, and the stats are built per step for the same
 * reason the rules are: a sequence that returns to a state reaches it at two
 * different times, and pooling both visits into one glyph would put the same bar
 * on both rules and deny the only thing worth seeing there.
 *
 * Note that the original computes `q1`/`q3` in its five-number summary and then
 * never draws them — its bar is the min→max extent, not the interquartile box
 * the name suggests. That is reproduced here; the quartiles are carried on
 * `StateStats` and are what a true box would need.
 */
export function StateBoxPlots({ width, height, marginY, xDomain, rowOf, rowStates, byPosition, stats, reference, axis, palette, }) {
    const project = useMemo(() => {
        const [x0, x1] = xDomain;
        const span = Math.max(x1 - x0, 1e-6);
        const usable = Math.max(height - 2 * marginY, 1);
        const rowHeight = usable / Math.max(rowStates.length, 1);
        return {
            x: (value) => ((value - x0) / span) * width,
            y: (row) => marginY + (row + 0.5) * rowHeight,
            pitch: rowHeight,
        };
    }, [xDomain, width, height, marginY, rowStates.length]);
    if (width === 0 || height === 0 || rowStates.length === 0)
        return null;
    const showLabels = project.pitch >= MIN_PITCH_FOR_LABELS;
    const unit = axis === "age" ? "y" : "";
    return (_jsx("svg", { className: "chart__boxplots", width: width, height: height, "aria-hidden": "true", children: rowStates.map((state, index) => {
            const stat = stats[index];
            if (stat === undefined || stat === null)
                return null;
            const row = byPosition ? index : (rowOf[state] ?? index);
            const color = palette.css[state] ?? "currentColor";
            const min = project.x(stat.min);
            const max = project.x(stat.max);
            const full = reference[index];
            return (_jsxs("g", { className: "boxplot", transform: `translate(0 ${project.y(row).toFixed(1)})`, children: [full != null && (_jsxs(_Fragment, { children: [_jsx(Whisker, { from: project.x(full.min), to: min, color: color }), _jsx(Whisker, { from: project.x(full.max), to: max, color: color })] })), _jsx("rect", { className: "boxplot__bar", x: min, width: Math.max(max - min, 0.5), y: -BAR_HEIGHT / 2, height: BAR_HEIGHT, fill: color }), _jsx("rect", { className: "boxplot__median", x: project.x(stat.median) - MEDIAN_WIDTH / 2, width: MEDIAN_WIDTH, y: -BAR_HEIGHT / 2, height: BAR_HEIGHT }), showLabels && (_jsxs(_Fragment, { children: [_jsx("text", { className: "boxplot__label", x: min, y: LABEL_BELOW, textAnchor: "start", fill: color, children: `${stat.min.toFixed(0)}${unit}` }), _jsx("text", { className: "boxplot__label", x: Math.min(max + LABEL_GAP, width - 2), y: LABEL_BELOW, textAnchor: "end", fill: color, children: `${stat.max.toFixed(0)}${unit}` })] }))] }, index));
        }) }));
}
/** One side: a thin line out to the cohort's extreme, capped there. */
function Whisker({ from, to, color, }) {
    if (Math.abs(from - to) < 0.5)
        return null;
    return (_jsxs("g", { className: "boxplot__whisker", children: [_jsx("line", { x1: from, x2: to, y1: 0, y2: 0, stroke: color }), _jsx("rect", { x: from - 0.25, width: 0.5, y: -CAP_HEIGHT / 2, height: CAP_HEIGHT, fill: color })] }));
}
