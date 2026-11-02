import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useMemo, useState } from "react";
import { focusedTypologyOf, useEras } from "../app/store.ts";
import { clusterMembers } from "../core/cluster/medoids.ts";
import { isolatedClusters, patientIdsCsv, patientRecordsJson, pipelineFailures, STEP_BITS, survivorCounts, survivors, } from "../core/query/pipeline.ts";
import { download } from "./download.ts";
import { LABELS } from "./FiltersPanel.tsx";
import { Panel } from "./Panel.tsx";
import { useClusterRun } from "./useClusterRun.ts";
/** The id column's name when the file did not say: the original's hardcoded one. */
const DEFAULT_ID_HEADER = "FINNGENID";
/**
 * Build & export: how the chart's patients were arrived at, as a chain, with
 * every link exportable.
 *
 * The original's Pipeline panel was a node graph of the derived-data stages,
 * each reporting how many patients survive to it. This keeps that reading —
 * one count per stage, top to bottom — but as a list in the column, in the order
 * the user applied the steps rather than the order the code happens to run
 * them. The last link is what is on screen, so exporting it is exporting the
 * visualization's individuals.
 */
export function PipelinePanel() {
    const store = useEras((s) => s.store);
    const baseStore = useEras((s) => s.baseStore);
    const fileName = useEras((s) => s.fileName);
    const mapping = useEras((s) => s.mapping);
    const filters = useEras((s) => s.filters);
    const selectionVersion = useEras((s) => s.selectionVersion);
    const typologies = useEras((s) => s.typologies);
    const selectedTypologies = useEras((s) => s.selectedTypologies);
    const pathSteps = useEras((s) => s.pathSteps);
    const expectations = useEras((s) => s.expectations);
    const activeExpectations = useEras((s) => s.activeExpectations);
    const selectedClusters = useEras((s) => s.selectedClusters);
    const view = useEras((s) => s.view);
    const order = useEras((s) => s.pipelineOrder);
    const clusterRun = useClusterRun();
    const clusterVersion = useEras((s) => s.clusterVersion);
    const resetFilter = useEras((s) => s.resetFilter);
    const resetStates = useEras((s) => s.resetStates);
    const clearTypologies = useEras((s) => s.clearTypologies);
    const clearClusters = useEras((s) => s.clearClusters);
    const [format, setFormat] = useState("ids");
    // Computed here rather than through `isolatedClustersOf`: a selector that
    // builds a new array on every call never settles.
    const isolated = useMemo(() => isolatedClusters(clusterRun, selectedClusters, view === "trajectories" ? focusedTypologyOf(selectedTypologies) : null), [clusterRun, selectedClusters, view, selectedTypologies]);
    /*
     * One exhaustive scan for every bit, then one pass to charge each patient to
     * the first link that cuts them. Re-run on every selection change, so it
     * follows a drag — the same order of cost as the filter scan itself.
     */
    const chain = useMemo(() => {
        if (store === null)
            return null;
        const keys = new Set(selectedTypologies);
        const chosen = selectedTypologies.length > 0
            ? typologies.filter((typology) => keys.has(typology.key)).map((t) => t.patients)
            : null;
        const members = isolated.length > 0 && clusterRun !== null ? clusterMembers(clusterRun, isolated, null) : null;
        const failures = pipelineFailures(store, filters, chosen, members);
        const rows = [...(filters.removedStates.length > 0 ? ["removedStates"] : []), ...order];
        const counts = survivorCounts(failures, rows.map((row) => STEP_BITS[row]));
        return { failures, rows, counts };
        // `selectionVersion` stands for the masks the scan mirrors; `clusterVersion`
        // for a run that streams in without changing identity.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [store, filters, typologies, selectedTypologies, isolated, clusterRun, clusterVersion, order, selectionVersion]);
    const links = useMemo(() => {
        if (store === null || chain === null)
            return [];
        const names = (states) => Array.from(states, (state) => store.stateNames[state] ?? String(state));
        const describe = (row) => {
            switch (row) {
                case "source":
                    return { label: "Dataset", detail: fileName ?? "" };
                case "removedStates":
                    return { label: "Removed states", detail: names(filters.removedStates).join(", ") };
                case "typologies": {
                    const saved = expectations
                        .filter((expectation) => activeExpectations.includes(expectation.id))
                        .map((expectation) => expectation.name);
                    if (saved.length > 0 || pathSteps.length > 0) {
                        const walk = pathSteps.length > 0 ? [names(pathSteps).join(" → ")] : [];
                        return { label: "Path", detail: [...saved, ...walk].join(" ∪ ") };
                    }
                    if (selectedTypologies.length === 1) {
                        const typology = typologies.find((t) => t.key === selectedTypologies[0]);
                        return {
                            label: "Typology",
                            detail: typology === undefined ? "" : names(typology.states).join(" → "),
                        };
                    }
                    return { label: "Typologies", detail: `${selectedTypologies.length} chosen` };
                }
                case "clusters":
                    return {
                        label: "Clusters",
                        detail: `${isolated.length} isolated in ${selectedTypologies[0] ?? ""}`,
                    };
                default: {
                    const range = filters[row];
                    const inverted = filters.inverted[row] === true;
                    return {
                        label: LABELS[row],
                        detail: range === null
                            ? ""
                            : `${inverted ? "outside " : ""}${range.min.toFixed(1)} – ${range.max.toFixed(1)}`,
                    };
                }
            }
        };
        const out = [{ row: "source", ...describe("source"), count: store.patientCount, cut: 0, bits: 0 }];
        let bits = 0;
        chain.rows.forEach((row, i) => {
            bits |= STEP_BITS[row];
            const count = chain.counts[i];
            const above = out[out.length - 1].count;
            out.push({ row, ...describe(row), count, cut: above - count, bits });
        });
        return out;
    }, [
        store,
        chain,
        fileName,
        filters,
        expectations,
        activeExpectations,
        pathSteps,
        selectedTypologies,
        typologies,
        isolated,
    ]);
    if (store === null || baseStore === null || chain === null)
        return null;
    const total = store.patientCount;
    const final = links[links.length - 1];
    const idHeader = mapping?.mapping.patientId ?? DEFAULT_ID_HEADER;
    const exportLink = (link, index) => {
        // The dataset link is the file as loaded; every later one reads the store
        // the chart draws, removed states spliced out of each trajectory.
        const source = link.row === "source" ? baseStore : store;
        const patients = survivors(link.row === "source" ? new Uint8Array(total) : chain.failures, link.bits);
        const base = (fileName ?? "eras").replace(/\.[^.]+$/, "");
        const name = `${base}-${String(index).padStart(2, "0")}-${slug(link.label)}-${patients.length}`;
        if (format === "ids") {
            download(`${name}.csv`, patientIdsCsv(source, patients, idHeader), "text/csv");
        }
        else {
            download(`${name}.json`, patientRecordsJson(source, patients, idHeader), "application/json");
        }
    };
    const drop = (row) => {
        if (row === "removedStates")
            resetStates();
        else if (row === "typologies")
            clearTypologies();
        else if (row === "clusters")
            clearClusters();
        else if (row !== "source")
            resetFilter(row);
    };
    return (_jsxs(Panel, { title: "Build & export", count: _jsxs("span", { children: [final.count.toLocaleString(), " / ", total.toLocaleString()] }, selectionVersion), children: [_jsxs("div", { className: "pipeline__format", role: "group", "aria-label": "Export format", children: [_jsx("span", { children: "Export as" }), _jsx("button", { type: "button", className: "button button--tiny", "data-selected": format === "ids", title: "One id per line, to join back onto the source data", onClick: () => setFormat("ids"), children: "IDs \u00B7 csv" }), _jsx("button", { type: "button", className: "button button--tiny", "data-selected": format === "records", title: "Whole trajectories, in a JSON this tool loads back in", onClick: () => setFormat("records"), children: "Records \u00B7 json" })] }), _jsx("ol", { className: "pipeline", children: links.map((link, index) => {
                    const isLast = index === links.length - 1;
                    return (_jsxs("li", { className: "pipeline__step", "data-last": isLast, "data-source": index === 0, children: [_jsx("span", { className: "pipeline__dot", "aria-hidden": "true" }), _jsxs("div", { className: "pipeline__body", children: [_jsxs("div", { className: "pipeline__head", children: [_jsx("span", { className: "pipeline__label", children: link.label }), _jsx("span", { className: "pipeline__count", children: link.count.toLocaleString() })] }), _jsxs("div", { className: "pipeline__meta", children: [_jsxs("span", { className: "pipeline__detail", title: link.detail, children: [isLast && index > 0 ? "on screen · " : "", link.detail] }), link.cut > 0 && _jsxs("span", { className: "pipeline__cut", children: ["\u2212", link.cut.toLocaleString()] })] }), _jsx("div", { className: "pipeline__bar", "aria-hidden": "true", children: _jsx("span", { style: { width: `${total === 0 ? 0 : (link.count / total) * 100}%` } }) })] }), _jsxs("div", { className: "pipeline__actions", children: [_jsx("button", { type: "button", className: "button button--tiny", disabled: link.count === 0, title: `Export the ${link.count.toLocaleString()} individuals at this step`, "aria-label": `Export ${link.label}`, onClick: () => exportLink(link, index), children: "\u2913" }), _jsx("button", { type: "button", className: "button button--tiny", title: "Drop this step", "aria-label": `Drop ${link.label}`, "aria-hidden": index === 0, tabIndex: index === 0 ? -1 : undefined, style: index === 0 ? { visibility: "hidden" } : undefined, onClick: () => drop(link.row), children: "\u2715" })] })] }, link.row));
                }) }), links.length === 1 && (_jsx("p", { className: "pipeline__empty", children: "Nothing narrows the cohort yet. Filters, typology picks, paths and isolated clusters appear here as you apply them." }))] }));
}
const slug = (label) => label.toLowerCase().replace(/[^a-z0-9]+/g, "-");
