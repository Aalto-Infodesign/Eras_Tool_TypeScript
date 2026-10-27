import { create } from "zustand"
import { createJSONStorage, persist } from "zustand/middleware"

import { CLUSTERING_ENABLED } from "./features.ts"

/** Every panel the side column can hold. The column's own vocabulary, not the store's. */
export type PanelId =
  | "data"
  | "view"
  | "ingest"
  | "states"
  | "filters"
  | "pipeline"
  | "clusters"
  | "paths"
  | "typologies"

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
export const PANELS: readonly {
  readonly id: PanelId
  readonly title: string
  readonly required?: boolean
}[] = [
  { id: "data", title: "Data", required: true },
  { id: "view", title: "View", required: true },
  { id: "ingest", title: "Ingest" },
  { id: "states", title: "States" },
  { id: "filters", title: "Filters" },
  { id: "pipeline", title: "Build & export" },
  { id: "clusters", title: "Clusters" },
  { id: "paths", title: "Path explorer" },
  { id: "typologies", title: "Typologies" },
]

const DEFAULT_ORDER: readonly PanelId[] = PANELS.map((panel) => panel.id)
const KNOWN = new Set<string>(DEFAULT_ORDER)
const REQUIRED = new Set<PanelId>(PANELS.filter((panel) => panel.required).map((panel) => panel.id))

export function isRequired(id: PanelId): boolean {
  return REQUIRED.has(id)
}

export function isAvailable(id: PanelId): boolean {
  return id !== "clusters" || CLUSTERING_ENABLED
}

interface Layout {
  /** Every known id exactly once — hidden and pinned ones included, so unhiding puts a panel back where it was. */
  readonly order: readonly PanelId[]
  readonly hidden: readonly PanelId[]
  /** Pinned panels sit above the scrolling part of the column, in `order`. */
  readonly pinned: readonly PanelId[]
  /**
   * The fold, per panel. Held here rather than in each `Panel` because pinning
   * moves a panel into another container, which remounts it — local state would
   * spring every fold back to its default. Absent means the panel's own default.
   */
  readonly open: Readonly<Partial<Record<PanelId, boolean>>>
}

interface SidePanelsState extends Layout {
  /** The settings dialog. Not persisted: a reload should not open it. */
  readonly settingsOpen: boolean

  /** Swap with the nearest *available* neighbour, so a parked panel is never a step that does nothing. */
  move(id: PanelId, delta: -1 | 1): void
  setVisible(id: PanelId, visible: boolean): void
  togglePinned(id: PanelId): void
  setOpen(id: PanelId, open: boolean): void
  resetLayout(): void
  setSettingsOpen(open: boolean): void
}

const DEFAULT_LAYOUT: Layout = {
  order: DEFAULT_ORDER,
  hidden: [],
  pinned: ["view"],
  open: {},
}

/**
 * A stored layout is from some earlier build: drop ids that no longer exist and
 * slot new ones in after their default predecessor, so a panel added later
 * lands where it would by default rather than at the bottom of someone's saved
 * column.
 */
function sanitize(stored: Partial<Layout> | undefined): Layout {
  if (stored === undefined || stored === null) return DEFAULT_LAYOUT
  const known = (ids: unknown): PanelId[] =>
    Array.isArray(ids) ? ids.filter((id): id is PanelId => KNOWN.has(id as string)) : []

  const order = [...new Set(known(stored.order))]
  DEFAULT_ORDER.forEach((id, index) => {
    if (order.includes(id)) return
    let at = 0
    for (let i = index - 1; i >= 0; i--) {
      const position = order.indexOf(DEFAULT_ORDER[i] as PanelId)
      if (position !== -1) {
        at = position + 1
        break
      }
    }
    order.splice(at, 0, id)
  })

  return {
    order,
    hidden: Array.isArray(stored.hidden)
      ? known(stored.hidden).filter((id) => !isRequired(id))
      : DEFAULT_LAYOUT.hidden,
    pinned: Array.isArray(stored.pinned) ? known(stored.pinned) : DEFAULT_LAYOUT.pinned,
    open: typeof stored.open === "object" && stored.open !== null ? stored.open : {},
  }
}

export const useSidePanels = create<SidePanelsState>()(
  persist(
    (set) => ({
      ...DEFAULT_LAYOUT,
      settingsOpen: false,

      move(id, delta) {
        set(({ order }) => {
          const from = order.indexOf(id)
          let to = from + delta
          while (to >= 0 && to < order.length && !isAvailable(order[to] as PanelId)) to += delta
          if (from === -1 || to < 0 || to >= order.length) return {}
          const next = [...order]
          next[from] = order[to] as PanelId
          next[to] = id
          return { order: next }
        })
      },

      setVisible(id, visible) {
        if (!visible && isRequired(id)) return
        set(({ hidden }) => ({
          hidden: visible ? hidden.filter((other) => other !== id) : [...new Set([...hidden, id])],
        }))
      },

      togglePinned(id) {
        set(({ pinned }) => ({
          pinned: pinned.includes(id) ? pinned.filter((other) => other !== id) : [...pinned, id],
        }))
      },

      setOpen(id, open) {
        set((state) => ({ open: { ...state.open, [id]: open } }))
      },

      resetLayout() {
        set(DEFAULT_LAYOUT)
      },

      setSettingsOpen(settingsOpen) {
        set({ settingsOpen })
      },
    }),
    {
      name: "eras:side-panels",
      version: 1,
      // `createJSONStorage` swallows a throwing `localStorage` (private mode,
      // blocked site data): the column then just starts from the default.
      storage: createJSONStorage(() => localStorage),
      partialize: ({ order, hidden, pinned, open }): Layout => ({ order, hidden, pinned, open }),
      merge: (stored, current) => ({ ...current, ...sanitize(stored as Partial<Layout>) }),
    },
  ),
)
