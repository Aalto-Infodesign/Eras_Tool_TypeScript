import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { memo } from "react";
/** Drawing space. The browser scales the viewBox to whatever `size` asks for. */
const VIEWBOX = 100;
const PADDING = 12;
/**
 * One typology as its shape.
 *
 * The glyph is the same picture as the chart behind it, shrunk: x is the step
 * along the trajectory, y is the state's row in the *current* ordering, colour
 * is the same palette. So reordering the rows restacks every card, which is what
 * makes the "order states" button legible — you can see what it did.
 *
 * Kept as SVG rather than canvas because a card is a dozen elements and there
 * are only ever a screenful of them mounted (the list is windowed). That buys
 * hit-testing, a `<title>`, and CSS transitions on the geometry for free.
 *
 * Memoised on the props: a reorder changes `rows` and re-renders every mounted
 * glyph, but a selection or a scroll changes neither and re-renders none.
 */
export const SilhouetteGlyph = memo(function SilhouetteGlyph({ states, rows, rowCount, palette, maxSteps, size, }) {
    // `maxSteps - 1` gaps between `maxSteps` points; a one-state dataset has none,
    // and dividing by it would put every point at infinity.
    const gaps = Math.max(maxSteps - 1, 1);
    const usable = VIEWBOX - PADDING * 2;
    const band = VIEWBOX / (rowCount + 1);
    const x = (step) => PADDING + (step / gaps) * usable;
    const y = (state) => ((rows[state] ?? 0) + 1) * band;
    return (_jsxs("svg", { className: "glyph", viewBox: `0 0 ${VIEWBOX} ${VIEWBOX}`, width: size, height: size, children: [_jsx("g", { className: "glyph__links", children: Array.from(states, (state, i) => {
                    const next = states[i + 1];
                    if (next === undefined)
                        return null;
                    return (_jsx("line", { x1: x(i), y1: y(state), x2: x(i + 1), y2: y(next), stroke: palette[state] ?? "currentColor" }, i));
                }) }), _jsx("g", { className: "glyph__nodes", children: Array.from(states, (state, i) => (_jsx("circle", { cx: x(i), cy: y(state), r: 5, fill: palette[state] ?? "currentColor" }, i))) })] }));
});
