import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useEras } from "../app/store.ts";
import { Panel } from "./Panel.tsx";
/**
 * The pipeline's cost, itemised.
 *
 * The original scattered `console.time` probes through the hooks; collecting
 * them into a visible panel is what makes "is this change faster?" answerable
 * without a profiler open.
 */
export function PerfHud() {
    const timings = useEras((s) => s.timings);
    const reshapeTimings = useEras((s) => s.reshapeTimings);
    const store = useEras((s) => s.store);
    const cohortSize = useEras((s) => s.cohortSize);
    const format = useEras((s) => s.mapping?.source ?? null);
    if (store === null || timings.length === 0)
        return null;
    const total = timings.reduce((sum, t) => sum + t.ms, 0);
    const slowest = Math.max(...timings.map((t) => t.ms));
    return (_jsxs(Panel, { title: "Ingest", count: `${total.toFixed(0)}ms`, className: "panel--hud", children: [_jsxs("dl", { className: "hud__facts", children: [_jsxs("div", { children: [_jsx("dt", { children: "Patients" }), _jsxs("dd", { children: [cohortSize.toLocaleString(), cohortSize < store.patientCount && (_jsxs("em", { children: [" \u2212", (store.patientCount - cohortSize).toLocaleString()] }))] })] }), _jsxs("div", { children: [_jsx("dt", { children: "Events" }), _jsx("dd", { children: store.eventCount.toLocaleString() })] }), _jsxs("div", { children: [_jsx("dt", { children: "States" }), _jsx("dd", { children: store.stateNames.length })] }), _jsxs("div", { children: [_jsx("dt", { children: "Memory" }), _jsx("dd", { children: formatBytes(storeBytes(store)) })] })] }), _jsx("ul", { className: "hud__timings", children: timings.map((timing) => (_jsxs("li", { children: [_jsx("span", { className: "hud__label", children: timing.label }), _jsx("span", { className: "hud__bar", style: { width: `${(timing.ms / slowest) * 100}%` } }), _jsxs("span", { className: "hud__ms", children: [timing.ms.toFixed(1), "ms"] })] }, timing.label))) }), reshapeTimings.length > 0 && (_jsxs(_Fragment, { children: [_jsxs("p", { className: "hud__note", children: ["re-derived after removing states \u00B7", " ", _jsxs("b", { children: [reshapeTimings.reduce((sum, t) => sum + t.ms, 0).toFixed(0), "ms"] })] }), _jsx("ul", { className: "hud__timings", children: reshapeTimings.map((timing) => (_jsxs("li", { children: [_jsx("span", { className: "hud__label", children: timing.label }), _jsx("span", { className: "hud__bar hud__bar--reshape", style: { width: `${(timing.ms / slowest) * 100}%` } }), _jsxs("span", { className: "hud__ms", children: [timing.ms.toFixed(1), "ms"] })] }, timing.label))) })] })), format !== null && _jsxs("p", { className: "hud__note", children: ["column mapping: ", format] })] }));
}
function storeBytes(store) {
    return (store.ids.bytes.byteLength +
        store.ids.offsets.byteLength +
        store.diseaseDuration.byteLength +
        store.offsets.byteLength +
        store.stateIds.byteLength +
        store.ages.byteLength +
        store.years.byteLength +
        store.durations.byteLength +
        store.eventPatient.byteLength);
}
function formatBytes(bytes) {
    if (bytes < 1024)
        return `${bytes} B`;
    if (bytes < 1024 * 1024)
        return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
