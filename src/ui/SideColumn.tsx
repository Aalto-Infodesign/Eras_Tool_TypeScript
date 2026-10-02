import { useMemo } from "react"

import { isAvailable, useSidePanels, type PanelId } from "../app/sidePanels.ts"
import { ClusterTable } from "./ClusterTable.tsx"
import { DataPanel } from "./FileLoader.tsx"
import { FiltersPanel } from "./FiltersPanel.tsx"
import { PanelSlotContext, type PanelSlot } from "./Panel.tsx"
import { PathExplorer } from "./PathExplorer.tsx"
import { PerfHud } from "./PerfHud.tsx"
import { StatesPanel } from "./StatesPanel.tsx"
import { TypologyList } from "./TypologyList.tsx"
import { useViewKeys, ViewSwitcher } from "./ViewSwitcher.tsx"

const COMPONENTS: Readonly<Record<PanelId, () => React.JSX.Element | null>> = {
  data: DataPanel,
  view: ViewSwitcher,
  ingest: PerfHud,
  states: StatesPanel,
  filters: FiltersPanel,
  clusters: ClusterTable,
  paths: PathExplorer,
  typologies: TypologyList,
}

/**
 * The side column, laid out as the user arranged it (`useSidePanels`).
 *
 * Pinned panels get a region of their own above the scroller rather than
 * `position: sticky` inside it: several sticky siblings at `top: 0` stack on
 * top of one another, and a pinned panel lower in the order would only stick
 * once scrolled to. Moving between the two regions remounts a panel, which is
 * why the fold lives in the layout store and not in `Panel`.
 */
export function SideColumn(): React.JSX.Element {
  useViewKeys()

  const order = useSidePanels((s) => s.order)
  const hidden = useSidePanels((s) => s.hidden)
  const pinned = useSidePanels((s) => s.pinned)
  const setSettingsOpen = useSidePanels((s) => s.setSettingsOpen)

  const { top, rest } = useMemo(() => {
    const shown = order.filter((id) => isAvailable(id) && !hidden.includes(id))
    return {
      top: shown.filter((id) => pinned.includes(id)),
      rest: shown.filter((id) => !pinned.includes(id)),
    }
  }, [order, hidden, pinned])

  return (
    <aside className="app__side">
      {top.length > 0 && (
        <div className="side__pinned">
          {top.map((id) => (
            <Slot key={id} id={id} />
          ))}
        </div>
      )}
      <div className="side__scroll">
        {rest.map((id) => (
          <Slot key={id} id={id} />
        ))}
        <button type="button" className="side__customize" onClick={() => setSettingsOpen(true)}>
          Customize panels…
        </button>
      </div>
    </aside>
  )
}

function Slot({ id }: { readonly id: PanelId }): React.JSX.Element {
  const isPinned = useSidePanels((s) => s.pinned.includes(id))
  const open = useSidePanels((s) => s.open[id])
  const togglePinned = useSidePanels((s) => s.togglePinned)
  const setOpen = useSidePanels((s) => s.setOpen)

  const slot = useMemo<PanelSlot>(
    () => ({
      pinned: isPinned,
      onTogglePinned: () => togglePinned(id),
      open,
      onOpenChange: (next) => setOpen(id, next),
    }),
    [id, isPinned, open, togglePinned, setOpen],
  )

  const Component = COMPONENTS[id]
  return (
    <PanelSlotContext.Provider value={slot}>
      <Component />
    </PanelSlotContext.Provider>
  )
}
