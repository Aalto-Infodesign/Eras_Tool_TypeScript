import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { findPath } from "../core/stats/pathTree.ts";
/**
 * The walk so far, as `a → b → c`.
 *
 * The board shows the *decisions* — a column of alternatives per step — which is
 * what you need while choosing and the wrong thing for reading back what you
 * chose: the answer is one item per column, spread across the width, with the
 * rejected options between them. This is the same path in one line, in the
 * chart's own colours, and every step is a click back to that depth.
 *
 * With counts it is also the funnel, which is the number people actually want
 * from this panel: how much of the cohort each successive step costs.
 */
export function PathFlow({ tree, pathPrefix, palette, stateNames, onStep, showCounts = false, }) {
    const root = tree.nodes[0];
    return (_jsxs("ol", { className: "flow", "aria-label": "Current path", children: [_jsx("li", { children: _jsxs("button", { type: "button", className: "flow__step flow__step--root", "data-active": pathPrefix.length === 0, title: "The whole cohort", onClick: () => onStep([]), children: ["All", showCounts && _jsx("em", { children: root.size.toLocaleString() })] }) }), pathPrefix.map((state, depth) => {
                const node = tree.nodes[findPath(tree, pathPrefix.slice(0, depth + 1))];
                const isLast = depth === pathPrefix.length - 1;
                return (_jsxs("li", { children: [_jsx("span", { className: "flow__arrow", "aria-hidden": "true", children: "\u2192" }), _jsxs("button", { type: "button", className: "flow__step", "data-active": isLast, title: node === undefined
                                ? undefined
                                : `${node.size.toLocaleString()} reach here, ${node.ends.toLocaleString()} stop here`, onClick: () => onStep(pathPrefix.slice(0, depth + 1)), children: [_jsx("span", { className: "flow__dot", style: { background: palette[state] }, "aria-hidden": "true" }), stateNames[state], showCounts && node !== undefined && _jsx("em", { children: node.size.toLocaleString() })] })] }, `${state}-${depth}`));
            })] }));
}
