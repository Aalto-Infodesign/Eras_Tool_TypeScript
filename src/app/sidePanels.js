import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { CLUSTERING_ENABLED } from "./features.ts";
/**
 * The column's default reading order — what it was when this was hardcoded in
 * `App` — and the names the settings list shows.
 *
 * `clusters` stays in the list when clustering is parked, so a layout saved with
 * it on survives the flip; `isAvailable` says whether to show it.
 *
 * `required` panels can be moved, pinned and folded but not hidden: Data is the
 * only way to load another file, and View the only on-screen way to swap the
 * main chart.
 */
export const PANELS = [
    { id: "data", title: "Data", required: true },
    { id: "view", title: "View", required: true },
    { id: "ingest", title: "Ingest" },
    { id: "states", title: "States" },
    { id: "filters", title: "Filters" },
    { id: "pipeline", title: "Build & export" },
    { id: "clusters", title: "Clusters" },
    { id: "paths", title: "Path explorer" },
    { id: "typologies", title: "Typologies" },
];
const DEFAULT_ORDER = PANELS.map((panel) => panel.id);
const KNOWN = new Set(DEFAULT_ORDER);
const REQUIRED = new Set(PANELS.filter((panel) => panel.required).map((panel) => panel.id));
export function isRequired(id) {
    return REQUIRED.has(id);
}
export function isAvailable(id) {
    return id !== "clusters" || CLUSTERING_ENABLED;
}
const DEFAULT_LAYOUT = {
    order: DEFAULT_ORDER,
    hidden: [],
    pinned: ["view"],
    open: {},
};
/**
 * A stored layout is from some earlier build: drop ids that no longer exist and
 * slot new ones in after their default predecessor, so a panel added later
 * lands where it would by default rather than at the bottom of someone's saved
 * column.
 */
function sanitize(stored) {
    if (stored === undefined || stored === null)
        return DEFAULT_LAYOUT;
    const known = (ids) => Array.isArray(ids) ? ids.filter((id) => KNOWN.has(id)) : [];
    const order = [...new Set(known(stored.order))];
    DEFAULT_ORDER.forEach((id, index) => {
        if (order.includes(id))
            return;
        let at = 0;
        for (let i = index - 1; i >= 0; i--) {
            const position = order.indexOf(DEFAULT_ORDER[i]);
            if (position !== -1) {
                at = position + 1;
                break;
            }
        }
        order.splice(at, 0, id);
    });
    return {
        order,
        hidden: Array.isArray(stored.hidden)
            ? known(stored.hidden).filter((id) => !isRequired(id))
            : DEFAULT_LAYOUT.hidden,
        pinned: Array.isArray(stored.pinned) ? known(stored.pinned) : DEFAULT_LAYOUT.pinned,
        open: typeof stored.open === "object" && stored.open !== null ? stored.open : {},
    };
}
export const useSidePanels = create()(persist((set) => ({
    ...DEFAULT_LAYOUT,
    settingsOpen: false,
    move(id, delta) {
        set(({ order }) => {
            const from = order.indexOf(id);
            let to = from + delta;
            while (to >= 0 && to < order.length && !isAvailable(order[to]))
                to += delta;
            if (from === -1 || to < 0 || to >= order.length)
                return {};
            const next = [...order];
            next[from] = order[to];
            next[to] = id;
            return { order: next };
        });
    },
    setVisible(id, visible) {
        if (!visible && isRequired(id))
            return;
        set(({ hidden }) => ({
            hidden: visible ? hidden.filter((other) => other !== id) : [...new Set([...hidden, id])],
        }));
    },
    togglePinned(id) {
        set(({ pinned }) => ({
            pinned: pinned.includes(id) ? pinned.filter((other) => other !== id) : [...pinned, id],
        }));
    },
    setOpen(id, open) {
        set((state) => ({ open: { ...state.open, [id]: open } }));
    },
    resetLayout() {
        set(DEFAULT_LAYOUT);
    },
    setSettingsOpen(settingsOpen) {
        set({ settingsOpen });
    },
}), {
    name: "eras:side-panels",
    version: 1,
    // `createJSONStorage` swallows a throwing `localStorage` (private mode,
    // blocked site data): the column then just starts from the default.
    storage: createJSONStorage(() => localStorage),
    partialize: ({ order, hidden, pinned, open }) => ({ order, hidden, pinned, open }),
    merge: (stored, current) => ({ ...current, ...sanitize(stored) }),
}));
