import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEras } from "./store.ts";
import { FileLoader } from "../ui/FileLoader.tsx";
import { Landing } from "../ui/Landing.tsx";
import { SankeyChart } from "../ui/SankeyChart.tsx";
import { SettingsModal } from "../ui/SettingsModal.tsx";
import { SideColumn } from "../ui/SideColumn.tsx";
import { TrajectoriesChart } from "../ui/TrajectoriesChart.tsx";
export function App() {
    const status = useEras((s) => s.status);
    const hasData = useEras((s) => s.store !== null);
    const workspaceOpen = useEras((s) => s.workspaceOpen);
    const view = useEras((s) => s.view);
    return (_jsx("div", { className: "app", children: hasData && !workspaceOpen ? (_jsx(Landing, {})) : hasData ? (_jsxs("main", { className: "app__main", children: [_jsx(SideColumn, {}), _jsx("section", { className: "app__chart", children: _jsx("div", { className: "app__view", children: view === "sankey" ? _jsx(SankeyChart, {}) : _jsx(TrajectoriesChart, {}) }, view) }), _jsx(SettingsModal, {})] })) : (
        // No header: once a dataset is open the loader is the Data side panel,
        // so before then it is the whole screen.
        _jsxs("main", { className: "app__empty", children: [_jsxs("h1", { className: "app__title", children: ["ERAS Tool ", _jsx("span", { children: "\u00B7 TS" })] }), _jsx("p", { children: status === "loading"
                        ? "Parsing…"
                        : "Drop a TSV, CSV or JSON file, or load one of the sample datasets." }), _jsx(FileLoader, {})] })) }));
}
