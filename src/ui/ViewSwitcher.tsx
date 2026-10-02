import { useEffect, useId, useMemo } from "react"

import { useEras, type MainView } from "../app/store.ts"
import { buildPalette } from "../core/render/palette.ts"
import { layoutSankey } from "../core/render/sankeyLayout.ts"
import { repeatedSteps, sequenceLabels } from "../core/stats/silhouettes.ts"
import { MiniTrajectories } from "./MiniTrajectories.tsx"
import { Panel } from "./Panel.tsx"
import { SankeyBase } from "./SankeyGraphic.tsx"
import { StateDots } from "./StateDots.tsx"
import { useSankey, type SankeyData } from "./useSankey.ts"

const NAMES: Readonly<Record<MainView, string>> = {
  sankey: "Sankey",
  trajectories: "Trajectories",
}

/** The thumbnail's height, the path explorer's minimap's: the column's one picture size. */
const MINI_HEIGHT = 150
/**
 * The mini Sankey is laid out once at this size and scaled by its viewBox, so
 * the panel's width — which shifts with a scrollbar — never relays it out.
 */
const MINI_SANKEY_WIDTH = 300

/** The original's keystrokes: 1 was the Sankey ("Parallel"), 2 the trajectories. */
const KEYS: Readonly<Record<string, MainView>> = {
  Digit1: "sankey",
  Numpad1: "sankey",
  Digit2: "trajectories",
  Numpad2: "trajectories",
}

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return (
    target.isContentEditable ||
    target.closest("input, textarea, select, [contenteditable]") !== null
  )
}

/**
 * The first panel in the column: the view that is *not* in the main area, live
 * and small, and the way to swap to it.
 *
 * The reading order runs from the Sankey — every typology as one flow — down to
 * the small multiples and then to a single typology, and the two main views are
 * different *kinds* of chart rather than two readings of one selection, so which
 * one is big is a choice the store holds (`view`). Multiples-versus-single stays
 * derived: within the Trajectories view, the selection still decides.
 *
 * The thumbnail is the switch. It is one button — nothing inside it takes focus
 * or the pointer — and it shows what clicking would actually open: the Sankey
 * of the current selection, or the grid's first panels (the one typology, when
 * one is chosen). It is the only on-screen switch — the chart controls no
 * longer carry one, which is why the column will not hide this panel — and
 * 1 / 2 work from anywhere, as they did in the original.
 */
export function ViewSwitcher(): React.JSX.Element | null {
  const hasData = useEras((s) => s.store !== null)
  const view = useEras((s) => s.view)
  const setView = useEras((s) => s.setView)

  if (!hasData) return null

  const other: MainView = view === "sankey" ? "trajectories" : "sankey"

  return (
    <Panel title="View" count={NAMES[view]} defaultOpen className="panel--view">
      {other === "trajectories" ? (
        <MiniButton
          view={other}
          label="Switch to the Trajectories view — key 2"
          picture={<MiniTrajectories />}
          caption={<TrajectoriesCaption />}
          onSwap={() => setView(other)}
        />
      ) : (
        <SankeyMiniButton onSwap={() => setView(other)} />
      )}
    </Panel>
  )
}

/**
 * Keys 1 and 2 swap the main view.
 *
 * Not in `ViewSwitcher`: the side column can hide that panel, and the keys must
 * keep working with it out of sight — so the column calls this, whatever it
 * shows. Never out from under something that owns the key — a field being
 * typed in, an open dialog — and never with a modifier, which belongs to the
 * browser.
 */
export function useViewKeys(): void {
  const setView = useEras((s) => s.setView)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.repeat) return
      if (event.ctrlKey || event.metaKey || event.altKey) return
      if (isEditable(event.target) || document.querySelector("dialog[open]") !== null) return
      const next = KEYS[event.code]
      if (next === undefined) return
      event.preventDefault()
      setView(next)
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [setView])
}

/** One `useSankey` for both the picture and its caption: the graph is built once. */
function SankeyMiniButton({ onSwap }: { readonly onSwap: () => void }): React.JSX.Element {
  const sankey = useSankey()
  return (
    <MiniButton
      view="sankey"
      label="Switch to the Sankey — key 1"
      picture={<MiniSankey {...sankey} />}
      caption={
        <>
          <b>Sankey</b>
          <span>
            {sankey.graph.steps} steps · {sankey.graph.links.length.toLocaleString()} flows
          </span>
        </>
      }
      onSwap={onSwap}
    />
  )
}

function MiniButton({
  view,
  label,
  picture,
  caption,
  onSwap,
}: {
  readonly view: MainView
  readonly label: string
  readonly picture: React.ReactNode
  readonly caption: React.ReactNode
  readonly onSwap: () => void
}): React.JSX.Element {
  return (
    <button type="button" className="viewswitch__mini" aria-label={label} onClick={onSwap}>
      {/* Keyed by view, so a swap fades the new picture in rather than morphing. */}
      <span key={view} className="viewswitch__frame" aria-hidden="true">
        {picture}
        <span className="viewswitch__swap">⇄ Swap</span>
      </span>
      <span className="viewswitch__caption">{caption}</span>
    </button>
  )
}

/**
 * The Sankey of the current selection at thumbnail size: the same graph the
 * main view draws (`useSankey`), the base layer only, laid out at a fixed size
 * and never tweened — a picture, not a chart.
 */
function MiniSankey({ graph, palette, stateRank }: SankeyData): React.JSX.Element {
  const order = useEras((s) => s.sankeyOrder)
  const uid = useId()

  const layout = useMemo(
    () =>
      layoutSankey(graph, {
        width: MINI_SANKEY_WIDTH,
        height: MINI_HEIGHT,
        marginX: 4,
        marginTop: 4,
        marginBottom: 4,
        nodeWidth: 4,
        nodePadding: 3,
        minNodeHeight: 0.75,
        minLinkWidth: 0.75,
        minColumnGap: 0,
        order,
        stateRank,
        keepOrder: null,
      }),
    [graph, order, stateRank],
  )

  return (
    <svg
      className="viewswitch__sankey"
      viewBox={`0 0 ${MINI_SANKEY_WIDTH} ${MINI_HEIGHT}`}
      preserveAspectRatio="none"
    >
      <SankeyBase graph={graph} layout={layout} palette={palette} uid={uid} mini exiting={null} />
    </svg>
  )
}

function TrajectoriesCaption(): React.JSX.Element | null {
  const store = useEras((s) => s.store)
  const typologies = useEras((s) => s.typologies)
  const selected = useEras((s) => s.selectedTypologies)

  const stateCount = store?.stateNames.length ?? 0
  const palette = useMemo(() => buildPalette(stateCount), [stateCount])

  const single = useMemo(() => {
    if (store === null || selected.length !== 1) return null
    const typology = typologies.find((t) => t.key === selected[0])
    if (typology === undefined) return null
    const states = Array.from(typology.states)
    return {
      states,
      labels: sequenceLabels(typology.states, store.stateNames),
      repeated: repeatedSteps(typology.states),
    }
  }, [store, typologies, selected])

  if (single !== null) {
    return (
      <>
        <b>Trajectories</b>
        <StateDots
          states={single.states}
          labels={single.labels}
          repeated={single.repeated}
          palette={palette}
        />
      </>
    )
  }

  return (
    <>
      <b>Trajectories</b>
      <span>
        {selected.length === 0
          ? "small multiples · biggest first"
          : `${selected.length.toLocaleString()} typologies · small multiples`}
      </span>
    </>
  )
}
