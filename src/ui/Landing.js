import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState } from "react";
import { useEras } from "../app/store.ts";
import { PathExplorerDialog } from "./PathExplorer.tsx";
/**
 * The one step between the upload and the charts.
 *
 * Either go straight in, or walk the path explorer first: stepping through the
 * cohort before seeing any chart is a way of saying what you expect to find —
 * which paths you think matter, how many people you think took them — and of
 * having that checked against the data before the overview can suggest an
 * answer. Whatever path the walk ends on is the selection the charts open with,
 * so setting expectations is also where the analysis starts.
 */
export function Landing() {
    const fileName = useEras((s) => s.fileName);
    const cohortSize = useEras((s) => s.cohortSize);
    const stateCount = useEras((s) => s.visibleStates.length);
    const typologyCount = useEras((s) => s.typologies.length);
    const openWorkspace = useEras((s) => s.openWorkspace);
    const reset = useEras((s) => s.reset);
    const [isExploring, setExploring] = useState(false);
    return (_jsxs("main", { className: "app__empty landing", children: [_jsxs("h1", { className: "app__title", children: ["ERAS Tool ", _jsx("span", { children: "\u00B7 TS" })] }), _jsxs("p", { className: "landing__file", children: [_jsx("b", { children: fileName }), " \u00B7 ", cohortSize.toLocaleString(), " patients \u00B7", " ", stateCount.toLocaleString(), " states \u00B7 ", typologyCount.toLocaleString(), " typologies"] }), _jsxs("div", { className: "landing__choices", children: [_jsxs("button", { type: "button", className: "landing__choice landing__choice--primary", onClick: openWorkspace, autoFocus: true, children: [_jsx("span", { className: "landing__choice-title", children: "Create visualization" }), _jsx("span", { className: "landing__choice-text", children: "Open the charts on the whole cohort." })] }), _jsxs("button", { type: "button", className: "landing__choice", onClick: () => setExploring(true), children: [_jsx("span", { className: "landing__choice-title", children: "Set expectations" }), _jsx("span", { className: "landing__choice-text", children: "Walk the cohort one state at a time first, and open the charts on the path you expect to matter." })] })] }), _jsx("button", { type: "button", className: "button button--tiny landing__back", onClick: reset, children: "\u2190 Use a different file" }), isExploring && (_jsx(PathExplorerDialog, { open: true, 
                // Every way out — the button, Escape, the backdrop — goes on to the
                // charts, carrying the walk as the selection. Coming back here would
                // only ask the same question again.
                onClose: openWorkspace, closeLabel: "Create visualization \u2192" }))] }));
}
