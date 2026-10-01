import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useMemo, useState } from "react";
import { useEras } from "../app/store.ts";
import { FilterDistribution } from "./FilterDistribution.tsx";
import { Panel } from "./Panel.tsx";
import { RangeSlider } from "./RangeSlider.tsx";
import { StackedLines } from "./StackedLines.tsx";
const LABELS = {
    age: "Age",
    year: "Calendar year",
    diseaseDuration: "Disease duration",
    duration: "Segment duration",
};
/** Terse enough for a chip and for the collapsed header. */
const SHORT = {
    age: "age",
    year: "year",
    diseaseDuration: "disease",
    duration: "segment",
};
const CHART_WIDTH = 246;
const DISTRIBUTION_HEIGHT = 44;
const STACKED_HEIGHT = 120;
export function FiltersPanel() {
    const store = useEras((s) => s.store);
    const filters = useEras((s) => s.filters);
    const distributions = useEras((s) => s.distributions);
    const selection = useEras((s) => s.selection);
    const selectionVersion = useEras((s) => s.selectionVersion);
    const cohortSize = useEras((s) => s.cohortSize);
    const setFilters = useEras((s) => s.setFilters);
    const resetFilter = useEras((s) => s.resetFilter);
    const toggleInverted = useEras((s) => s.toggleInverted);
    const axis = useEras((s) => s.axis);
    const xDomainOverride = useEras((s) => s.xDomainOverride);
    const fitXDomain = useEras((s) => s.fitXDomain);
    const resetXDomain = useEras((s) => s.resetXDomain);
    const bounds = useMemo(() => {
        if (store === null)
            return null;
        return {
            age: store.extents.age,
            year: store.extents.year,
            diseaseDuration: store.extents.diseaseDuration,
            duration: store.extents.duration,
        };
    }, [store]);
    const active = useMemo(() => Object.keys(LABELS).filter((key) => filters[key] !== null), [filters]);
    if (store === null || selection === null || bounds === null || distributions === null)
        return null;
    return (_jsxs(Panel, { title: "Filters", count: _jsxs("span", { children: [active.length > 0 && _jsx("em", { className: "panel__badge", children: active.length }), selection.count.toLocaleString(), " / ", cohortSize.toLocaleString()] }, selectionVersion), 
        /*
         * The chips are the filter's memory, so they live in the summary slot
         * rather than in the body: once a range is placed, the panel can be
         * collapsed and what is still cutting the data stays legible — with its
         * two verbs, invert and drop, on the summary itself. One row that scrolls
         * sideways rather than a wrapping block, so folding the panel away buys a
         * fixed amount of column back however many filters are on.
         */
        summary: active.length > 0 ? (_jsx("ul", { className: "chips", children: active.map((key) => {
                const range = filters[key];
                const inverted = filters.inverted[key] === true;
                return (_jsxs("li", { className: "chip", "data-inverted": inverted, children: [_jsx("button", { type: "button", className: "chip__invert", title: inverted ? "Filtering outside this range" : "Filter outside this range", onClick: () => toggleInverted(key), children: inverted ? "◑" : "◐" }), _jsxs("span", { className: "chip__label", children: [SHORT[key], " ", inverted && "∉ ", range.min.toFixed(0), "\u2013", range.max.toFixed(0)] }), _jsx("button", { type: "button", className: "chip__remove", title: "Drop this filter", onClick: () => resetFilter(key), children: "\u2715" })] }, key));
            }) })) : undefined, children: [_jsxs("div", { className: "filters__axis", children: [_jsx("button", { type: "button", className: "button", disabled: selection.count === 0, title: `Zoom the ${axis === "age" ? "age" : "calendar"} axis onto the patients in view`, onClick: fitXDomain, children: "Fit axis to selection" }), xDomainOverride !== null && (_jsx("button", { type: "button", className: "button button--tiny", title: "Back to the full dataset extent", onClick: resetXDomain, children: "\u21BA" }))] }), xDomainOverride !== null && (_jsxs("p", { className: "filters__axis-note", children: ["x axis: ", xDomainOverride[0].toFixed(1), " \u2013 ", xDomainOverride[1].toFixed(1)] })), _jsx(StackedLines, { width: CHART_WIDTH, height: STACKED_HEIGHT }), Object.keys(LABELS).map((key) => (_jsx(FilterControl, { name: key, label: LABELS[key], bounds: bounds[key], value: filters[key], inverted: filters.inverted[key] === true, distribution: distributions[key], onChange: (next) => setFilters({ [key]: next }), onInvert: () => toggleInverted(key), onReset: () => resetFilter(key) }, key)))] }));
}
function FilterControl({ name, label, bounds, value, inverted, distribution, onChange, onInvert, onReset, }) {
    /*
     * The handles' live position, which the distribution masks against. It is not
     * the committed range: a commit re-runs the filter and every layer behind it,
     * so the mask would lag the pointer by however long that takes.
     *
     * `null` outside a drag, so the committed range takes over again — a preview
     * that outlived its drag would survive a reset and leave the mask where the
     * handles no longer are.
     */
    const [preview, setPreview] = useState(null);
    const [hoverX, setHoverX] = useState(null);
    const committed = value === null ? bounds : [value.min, value.max];
    const shown = preview ?? committed;
    const curves = useMemo(() => {
        if ("start" in distribution) {
            return [
                { distribution: distribution.start, className: "distribution--start", label: "starts" },
                { distribution: distribution.end, className: "distribution--end", label: "ends" },
            ];
        }
        return [{ distribution, className: "distribution--single", label: "count" }];
    }, [distribution]);
    const isActive = value !== null;
    return (_jsxs("div", { className: "filter", "data-active": isActive, "data-inverted": inverted, children: [_jsxs("div", { className: "filter__head", children: [_jsx("label", { children: label }), _jsxs("span", { className: "filter__value", children: [shown[0].toFixed(1), " \u2013 ", shown[1].toFixed(1)] }), _jsx("button", { type: "button", className: "button button--tiny", "data-selected": inverted, title: "Keep what falls outside the range instead", onClick: onInvert, children: "\u25D0" }), _jsx("button", { type: "button", className: "button button--tiny", disabled: !isActive, title: "Reset this filter", onClick: onReset, children: "\u21BA" })] }), _jsx(FilterDistribution, { curves: curves, bounds: bounds, selection: shown, width: CHART_WIDTH, height: DISTRIBUTION_HEIGHT, inverted: inverted, hoverX: hoverX }), _jsx(RangeSlider, { bounds: bounds, value: value === null ? null : [value.min, value.max], width: CHART_WIDTH, inverted: inverted, onChange: (next) => onChange({ min: next[0], max: next[1] }), onPreview: setPreview, onHoverX: setHoverX }), curves.length > 1 && (_jsxs("p", { className: "filter__legend", children: [_jsx("span", { className: "distribution--start", children: "\u2014 starts" }), _jsx("span", { className: "distribution--end", children: "\u2014 ends" }), _jsx("em", { children: name === "age" ? "patient age span" : "patient calendar span" })] }))] }));
}
