import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useMemo } from "react";
import { isAvailable, useSidePanels } from "../app/sidePanels.ts";
import { ClusterTable } from "./ClusterTable.tsx";
import { FiltersPanel } from "./FiltersPanel.tsx";
import { PanelSlotContext } from "./Panel.tsx";
import { PathExplorer } from "./PathExplorer.tsx";
import { PerfHud } from "./PerfHud.tsx";
import { StatesPanel } from "./StatesPanel.tsx";
import { TypologyList } from "./TypologyList.tsx";
import { useViewKeys, ViewSwitcher } from "./ViewSwitcher.tsx";
const COMPONENTS = {
    view: ViewSwitcher,
    ingest: PerfHud,
    states: StatesPanel,
    filters: FiltersPanel,
    clusters: ClusterTable,
    paths: PathExplorer,
    typologies: TypologyList,
};
/**
 * The side column, laid out as the user arranged it (`useSidePanels`).
 *
 * Pinned panels get a region of their own above the scroller rather than
 * `position: sticky` inside it: several sticky siblings at `top: 0` stack on
 * top of one another, and a pinned panel lower in the order would only stick
 * once scrolled to. Moving between the two regions remounts a panel, which is
 * why the fold lives in the layout store and not in `Panel`.
 */
export function SideColumn() {
    useViewKeys();
    const order = useSidePanels((s) => s.order);
    const hidden = useSidePanels((s) => s.hidden);
    const pinned = useSidePanels((s) => s.pinned);
    const setSettingsOpen = useSidePanels((s) => s.setSettingsOpen);
    const { top, rest } = useMemo(() => {
        const shown = order.filter((id) => isAvailable(id) && !hidden.includes(id));
        return {
            top: shown.filter((id) => pinned.includes(id)),
            rest: shown.filter((id) => !pinned.includes(id)),
        };
    }, [order, hidden, pinned]);
    return (_jsxs("aside", { className: "app__side", children: [top.length > 0 && (_jsx("div", { className: "side__pinned", children: top.map((id) => (_jsx(Slot, { id: id }, id))) })), _jsxs("div", { className: "side__scroll", children: [rest.map((id) => (_jsx(Slot, { id: id }, id))), _jsx("button", { type: "button", className: "side__customize", onClick: () => setSettingsOpen(true), children: "Customize panels\u2026" })] })] }));
}
function Slot({ id }) {
    const isPinned = useSidePanels((s) => s.pinned.includes(id));
    const open = useSidePanels((s) => s.open[id]);
    const togglePinned = useSidePanels((s) => s.togglePinned);
    const setOpen = useSidePanels((s) => s.setOpen);
    const slot = useMemo(() => ({
        pinned: isPinned,
        onTogglePinned: () => togglePinned(id),
        open,
        onOpenChange: (next) => setOpen(id, next),
    }), [id, isPinned, open, togglePinned, setOpen]);
    const Component = COMPONENTS[id];
    return (_jsx(PanelSlotContext.Provider, { value: slot, children: _jsx(Component, {}) }));
}
