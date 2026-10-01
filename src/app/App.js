import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEras } from "./store.ts";
import { ControlBar } from "../ui/ControlBar.tsx";
import { FileLoader } from "../ui/FileLoader.tsx";
import { SankeyChart } from "../ui/SankeyChart.tsx";
import { SettingsModal } from "../ui/SettingsModal.tsx";
import { SideColumn } from "../ui/SideColumn.tsx";
import { TrajectoriesChart } from "../ui/TrajectoriesChart.tsx";
export function App() {
    const status = useEras((s) => s.status);
    const hasData = useEras((s) => s.store !== null);
    const view = useEras((s) => s.view);
    return (_jsxs("div", { className: "app", children: [_jsxs("header", { className: "app__header", children: [_jsxs("h1", { children: ["ERAS Tool ", _jsx("span", { children: "\u00B7 TS" })] }), _jsx(FileLoader, {})] }), hasData ? (_jsxs("main", { className: "app__main", children: [_jsx(SideColumn, {}), _jsxs("section", { className: "app__chart", children: [_jsx(ControlBar, {}), _jsx("div", { className: "app__view", children: view === "sankey" ? _jsx(SankeyChart, {}) : _jsx(TrajectoriesChart, {}) }, view)] }), _jsx(SettingsModal, {})] })) : (_jsx("main", { className: "app__empty", children: _jsx("p", { children: status === "loading"
                        ? "Parsing…"
                        : "Drop a TSV, CSV or JSON file, or load one of the sample datasets." }) }))] }));
}
