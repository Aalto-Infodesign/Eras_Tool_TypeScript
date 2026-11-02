import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useCallback, useRef, useState } from "react";
import { useEras } from "../app/store.ts";
import { MAPPING_SUMMARY_ENABLED, TEMPLATES_ENABLED } from "@app/features.ts";
import { Panel } from "./Panel.tsx";
const TEMPLATES = [
    { label: "Demo · 100", url: "/data/data_semilinear_dates.json" },
    { label: "Medium · 25k", url: "/data/data_25k.json" },
    { label: "Stress · 250k", url: "/data/generated/data_250k.json" },
    // Left out of the build (see `LOCAL_ONLY` in the Vite config), so offered
    // only where it exists.
    ...(import.meta.env.DEV ? [{ label: "Stress · 1M", url: "/data/generated/data_1m.json" }] : []),
];
/**
 * The loader as a side panel, once a dataset is open. The file name rides in
 * the header so it stays visible folded, and so does a load error: a failed
 * replace leaves the old data on screen, which must not pass for success.
 */
export function DataPanel() {
    const fileName = useEras((s) => s.fileName);
    const error = useEras((s) => s.error);
    return (_jsx(Panel, { title: "Data", count: fileName ?? undefined, defaultOpen: true, className: "panel--data", summary: error !== null ? _jsx("p", { className: "loader__error", children: error }) : undefined, children: _jsx(FileLoader, { showError: false }) }));
}
/**
 * Upload, drop, or pick a sample. On its own on the empty screen before
 * anything is loaded, and inside `DataPanel` after.
 */
export function FileLoader({ showError = true, }) {
    const status = useEras((s) => s.status);
    const error = useEras((s) => s.error);
    const mapping = useEras((s) => s.mapping);
    const loadFile = useEras((s) => s.loadFile);
    const loadUrl = useEras((s) => s.loadUrl);
    const inputRef = useRef(null);
    const [isDragging, setDragging] = useState(false);
    const [isSample, setSample] = useState(false);
    const onDrop = useCallback((event) => {
        event.preventDefault();
        setDragging(false);
        const file = event.dataTransfer.files[0];
        if (file !== undefined)
            void loadFile(file);
    }, [loadFile]);
    return (_jsxs("section", { className: `loader ${isDragging ? "loader--dragging" : ""}`, onDragOver: (e) => {
            e.preventDefault();
            setDragging(true);
        }, onDragLeave: () => setDragging(false), onDrop: onDrop, children: [_jsxs("div", { className: "loader__row", children: [!isSample && (_jsx("button", { type: "button", className: "button button--primary button--tiny", onClick: () => inputRef.current?.click(), disabled: status === "loading", children: status === "loading" ? "Loading…" : "Upload dataset" })), _jsx("input", { ref: inputRef, type: "file", accept: ".tsv,.csv,.txt,.json", hidden: true, onChange: (event) => {
                            const file = event.target.files?.[0];
                            if (file !== undefined)
                                void loadFile(file);
                        } }), !isSample && (_jsx("button", { type: "button", className: "button button--tiny", onClick: () => setSample(true), disabled: status === "loading", children: "Try sample" }, "sample")), isSample && (_jsx("div", { className: "loader__templates", children: TEMPLATES_ENABLED &&
                            TEMPLATES.map((template) => (_jsx("button", { type: "button", className: "button button--tiny", onClick: () => void loadUrl(template.url), disabled: status === "loading", children: template.label }, template.url))) })), showError && error !== null && _jsx("p", { className: "loader__error", children: error }), mapping !== null && MAPPING_SUMMARY_ENABLED === true && _jsx(MappingSummary, {})] }), isSample && (_jsx("button", { type: "button", className: "button button--primary landing__back button--tiny", onClick: () => setSample(false), disabled: status === "loading", children: "\u2190 Back" }, "sample back"))] }));
}
/**
 * Shows which column was read as what. The original hard-coded these names, so
 * a file with different headers produced an empty chart and no explanation —
 * making the mapping visible is most of the fix.
 */
function MappingSummary() {
    const mapping = useEras((s) => s.mapping);
    if (mapping === null)
        return null;
    const entries = Object.entries(mapping.mapping).filter(([, column]) => column !== null);
    const isUncertain = mapping.confidence < 0.5;
    return (_jsxs("div", { className: `mapping ${isUncertain ? "mapping--uncertain" : ""}`, children: [_jsxs("span", { className: "mapping__title", children: ["Columns ", isUncertain && _jsx("em", { children: "\u00B7 low confidence, please check" })] }), _jsx("ul", { className: "mapping__list", children: entries.map(([role, column]) => (_jsxs("li", { children: [_jsx("span", { className: "mapping__role", children: role }), _jsx("span", { className: "mapping__column", children: column })] }, role))) }), mapping.notes.map((note) => (_jsx("p", { className: "mapping__note", children: note }, note)))] }));
}
