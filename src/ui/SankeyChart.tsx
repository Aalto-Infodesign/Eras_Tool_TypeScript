import {
  useCallback,
  useDeferredValue,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react"

import { useEras } from "../app/store.ts"
import type { Palette } from "../core/render/palette.ts"
import {
  layoutSankey,
  stickyOrder,
  type LinkBand,
  type NodeBox,
  type SankeyLayout,
} from "../core/render/sankeyLayout.ts"
import {
  itemKey,
  linkSegmentsInRange,
  parsePinKey,
  pinKey,
  pinOf,
  resolvePin,
  samePin,
  sankeyMetricValues,
  stepMetricValues,
  summarise,
  traceSankey,
  typologiesThrough,
  typologyOfPatient,
  type SankeyGraph,
  type SankeyItem,
  type SankeyLink,
  type SankeyMetric,
  type SankeyMetricOptions,
  type SankeyNode,
  type SankeyPin,
  type SankeyScope,
  type ValueSummary,
} from "../core/stats/sankey.ts"
import type { Typology } from "../core/types.ts"
import { SankeyDistribution, type CurveRole, type SankeyCurve } from "./SankeyDistribution.tsx"
import {
  collapsedBand,
  collapsedBox,
  graphKeys,
  labelGutter,
  SankeyBase,
  SankeyLabels,
  SankeyOverlay,
  type SankeyExiting,
} from "./SankeyGraphic.tsx"
import { createHoverSettler } from "./hover.ts"
import { DURATION_MS, ease } from "./useAnimatedView.ts"
import { useElementSize } from "./useRenderer.ts"
import { useSankey } from "./useSankey.ts"

/**
 * The main view's geometry, in CSS pixels.
 *
 * The original used d3-sankey's 26px nodes with 15px padding at a fixed
 * 1000×500. Narrower nodes leave the column gap to the labels — which the
 * original never drew — and a 96px floor on that gap is what keeps a
 * `gait_tremor_problems` from running into the next column before the content
 * widens and the surface scrolls instead. The top margin holds the column
 * headers.
 */
const LAYOUT = {
  nodeWidth: 12,
  nodePadding: 10,
  marginX: 8,
  marginTop: 30,
  marginBottom: 10,
  minNodeHeight: 2,
  minLinkWidth: 1,
  minColumnGap: 96,
} as const

/** The tooltip's distance from the pointer, and from an item focused by keyboard. */
const TIP_OFFSET = 14
/** Neighbours listed per side in a node's tooltip before "n more". */
const TOP_NEIGHBOURS = 3

/**
 * The filter panel's names for the four metrics, exactly: the distribution is
 * read beside those sliders, and "Duration" next to "Disease duration" is the
 * ambiguity that naming them the same way avoids. (FiltersPanel keeps its copy
 * private; these must stay word for word the same.)
 */
const METRICS: readonly { value: SankeyMetric; label: string }[] = [
  { value: "duration", label: "Segment duration" },
  { value: "age", label: "Age" },
  { value: "year", label: "Calendar year" },
  { value: "diseaseDuration", label: "Disease duration" },
]

const NO_NAMES: readonly string[] = []

const HINT =
  "Hover a flow to trace its patients · click to pin, shift-click to compare · " +
  "◍ tails: trajectories that end at that step"

/** The latest pointer event, read by the next animation frame. */
interface PointerSample {
  readonly x: number
  readonly y: number
  readonly target: EventTarget | null
}

/**
 * The typologies as a layered flow — the overview the app opens on.
 *
 * The port of the original's `PartialOrderChart`: a column per step, a node
 * per state at that step, a ribbon per consecutive pair. What it keeps: the
 * shape comes from the selected typologies (else all of them), a link's
 * distribution sits under it, and a node narrows to the patients entering or
 * leaving it. What it changes, and why, is spelled out where it happens — true
 * step positions rather than positions among surviving segments, nothing hidden
 * for being small, pins by identity instead of by d3's index, hover that traces
 * a lineage instead of lighting one link, and drilling down through typologies
 * rather than a list of ids.
 */
export function SankeyChart(): React.JSX.Element {
  const store = useEras((s) => s.store)
  const baseStore = useEras((s) => s.baseStore)
  const typologies = useEras((s) => s.typologies)
  const selection = useEras((s) => s.selection)
  const visibleStates = useEras((s) => s.visibleStates)
  const selectedTypologies = useEras((s) => s.selectedTypologies)
  const sankeyOrder = useEras((s) => s.sankeyOrder)
  const sankeyPin = useEras((s) => s.sankeyPin)
  const sankeyCompare = useEras((s) => s.sankeyCompare)
  const setSankeyPin = useEras((s) => s.setSankeyPin)
  const setSankeyCompare = useEras((s) => s.setSankeyCompare)
  const hoveredTypology = useEras((s) => s.hoveredTypology)
  const hoveredPatient = useEras((s) => s.hoveredPatient)
  const duration = useEras((s) => s.filters.duration)
  const durationInverted = useEras((s) => s.filters.inverted.duration === true)
  const undoSelection = useEras((s) => s.undoSelection)
  const redoSelection = useEras((s) => s.redoSelection)

  const { graph, sizes, palette, stateRank, buildMs } = useSankey()
  const stateNames = store?.stateNames ?? NO_NAMES
  const uid = useId()

  // Elements, not refs: see `useRenderer`.
  const [root, setRoot] = useState<HTMLDivElement | null>(null)
  const [surface, setSurface] = useState<HTMLDivElement | null>(null)
  const [svg, setSvg] = useState<SVGSVGElement | null>(null)
  const [tip, setTip] = useState<HTMLDivElement | null>(null)
  const size = useElementSize(surface)

  /*
   * What counts as a *move*: a new order, a new set of typologies, a new row
   * order or a removed state. A fresh token whenever one of them changes, so it
   * compares by identity. Everything else that rebuilds the graph — a filter
   * dragged one frame further, a resize — lands directly.
   */
  const motionKey = useMemo(
    () => ({ sankeyOrder, selectedTypologies, visibleStates }),
    [sankeyOrder, selectedTypologies, visibleStates],
  )

  /*
   * Untangle keeps its column order through filter-driven rebuilds, so a node
   * resizes under a drag instead of swapping places with its neighbour mid-way.
   * The kept order is the last layout's — merged with the one before, so a node
   * a filter emptied keeps its slot (`stickyOrder`) — written after it commits
   * and read when the next one is computed; a move (a new motion key) re-sorts
   * from scratch.
   * A ref rather than state because it must not itself cause a relayout — the
   * layout it would produce is the one already on screen.
   */
  const keptOrder = useRef<{
    readonly key: object
    readonly order: ReadonlyMap<string, number>
  } | null>(null)

  const gutter = useMemo(() => labelGutter(stateNames), [stateNames])

  const layout = useMemo(() => {
    const kept = keptOrder.current
    const keepOrder =
      sankeyOrder === "flow" && kept !== null && kept.key === motionKey ? kept.order : null
    return layoutSankey(graph, {
      width: Math.max(0, size.width - gutter),
      height: size.height,
      ...LAYOUT,
      order: sankeyOrder,
      stateRank,
      keepOrder,
    })
  }, [graph, size.width, size.height, gutter, sankeyOrder, stateRank, motionKey])

  useEffect(() => {
    const kept = keptOrder.current
    keptOrder.current = {
      key: motionKey,
      order:
        kept !== null && kept.key === motionKey
          ? stickyOrder(kept.order, layout.order)
          : layout.order,
    }
  }, [layout, motionKey])

  const drawn = useSankeyTween(graph, layout, motionKey, baseStore)
  const isAnimating = drawn.isAnimating

  /*
   * Hover is held as a key, not an index: it compares by value, which the
   * settler needs, and it resolves against whatever graph is current. The key
   * under the pointer (or the keyboard) drives the tooltip and the trace at
   * once; its settled twin drives the detail strip, which costs more.
   */
  const [hoverKey, setHoverKey] = useState<string | null>(null)
  const [settledKey, setSettledKey] = useState<string | null>(null)
  const [focusKey, setFocusKey] = useState<string | null>(null)

  const settler = useMemo(() => createHoverSettler<string | null>(setSettledKey), [])
  useEffect(() => () => settler.cancel(), [settler])

  const pointer = useRef<PointerSample | null>(null)
  const pending = useRef(0)
  /** Whether the tooltip follows the pointer or sits beside a keyboard-focused item. */
  const anchor = useRef<"pointer" | "item">("pointer")
  const itemPoint = useRef<{ readonly x: number; readonly y: number } | null>(null)

  useEffect(
    () => () => {
      if (pending.current !== 0) cancelAnimationFrame(pending.current)
    },
    [],
  )

  const resolveKey = useCallback(
    (key: string | null): SankeyItem | null =>
      key === null ? null : resolvePin(graph, parsePinKey(key)),
    [graph],
  )

  // Hit-testing a moving chart answers for where things were; hover pauses for
  // the few hundred milliseconds of a move, as it does in the Trajectories view.
  const hovered = isAnimating ? null : resolveKey(hoverKey)
  const pinned = resolvePin(graph, sankeyPin)
  const compared = resolvePin(graph, sankeyCompare)

  /*
   * The trace: a hovered or pinned item's lineage — upstream and downstream at
   * once — or, with neither, one typology from outside the chart: a card under
   * the pointer, or the typology of a patient hovered in the sidebar.
   */
  const typologyIndex = useMemo(
    () => new Map(typologies.map((typology, t) => [typology.key, t])),
    [typologies],
  )
  // Only built once someone hovers a patient, and then kept per typology set:
  // a getter that fills its cache on first call, so the pointer leaving the
  // sidebar does not throw the table away.
  const patientTypology = useMemo(() => {
    let built: Int32Array | null = null
    return (): Int32Array | null => {
      if (built === null && store !== null) {
        built = typologyOfPatient(typologies, store.patientCount)
      }
      return built
    }
  }, [typologies, store])

  const traced = hovered ?? pinned
  const tracedKind = traced?.kind ?? null
  const tracedIndex = traced?.index ?? -1
  const outsideTypology = (() => {
    if (tracedKind !== null) return -1
    if (hoveredTypology !== null) return typologyIndex.get(hoveredTypology) ?? -1
    if (hoveredPatient !== null) return patientTypology()?.[hoveredPatient] ?? -1
    return -1
  })()

  const trace = useMemo(() => {
    if (isAnimating) return null
    let through: Uint32Array | null = null
    if (tracedKind !== null) {
      through = typologiesThrough(graph, typologies, { kind: tracedKind, index: tracedIndex })
    } else if (outsideTypology >= 0) {
      through = Uint32Array.of(outsideTypology)
    }
    if (through === null) return null
    const result = traceSankey(graph, typologies, sizes, through)
    /*
     * A trace of everyone is no trace. It dims nothing it does not also cover —
     * hovering the card of the one typology on screen painted the whole chain
     * over in the trace colour — so it is not drawn at all.
     */
    return result.total > 0 && result.total < graph.total ? result : null
  }, [isAnimating, graph, typologies, sizes, tracedKind, tracedIndex, outsideTypology])

  /*
   * The duration filter keeps a *patient* if any one of their segments is in
   * range, so a flow can carry segments outside it. The Sankey stays a reading
   * of patients — true steps, conserved flow — and shows the in-range share of
   * each link as lit over a ghost of the rest. Only computed while it is on.
   */
  const inRange = useMemo(
    () =>
      duration === null || store === null || selection === null
        ? null
        : linkSegmentsInRange({
            store,
            graph,
            typologies,
            mask: selection.mask,
            range: duration,
            inverted: durationInverted,
          }),
    [duration, durationInverted, store, graph, typologies, selection],
  )

  /*
   * The tooltip is placed by writing its transform directly, from the frame
   * that read the pointer: moving it is not a React render. Its content only
   * re-renders when the item under the pointer changes.
   */
  const placeTip = useCallback((): void => {
    if (tip === null || root === null) return
    const frame = root.getBoundingClientRect()
    let px: number
    let py: number
    if (anchor.current === "item") {
      const point = itemPoint.current
      if (point === null || svg === null) return
      const box = svg.getBoundingClientRect()
      px = box.left + point.x
      py = box.top + point.y
    } else {
      const point = pointer.current
      if (point === null) return
      px = point.x
      py = point.y
    }
    const w = tip.offsetWidth
    const h = tip.offsetHeight
    let x = px - frame.left + TIP_OFFSET
    let y = py - frame.top + TIP_OFFSET
    // Flipped to the other side of the pointer rather than clamped, so it never
    // lands on top of the thing it describes.
    if (x + w > frame.width) x = Math.max(0, px - frame.left - TIP_OFFSET - w)
    if (y + h > frame.height) y = Math.max(0, py - frame.top - TIP_OFFSET - h)
    tip.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`
  }, [tip, root, svg])

  const tipLines = useMemo(
    () =>
      hovered === null
        ? null
        : describe({ graph, layout, stateNames, palette, inRange }, hovered),
    [hovered, graph, layout, stateNames, palette, inRange],
  )

  const shownKey = hovered === null ? null : itemKey(graph, hovered)

  // After the content changes its size, and after a keyboard move, place it again.
  useLayoutEffect(() => {
    if (shownKey === null) return
    if (anchor.current === "item") {
      const item = resolveKey(shownKey)
      itemPoint.current = item === null ? null : anchorOf(drawn.layout, item)
    }
    placeTip()
  }, [shownKey, placeTip, resolveKey, drawn.layout])

  // Delegated, and coalesced to one hit test per animation frame: the pointer
  // fires more moves than there are frames, and the key is all a move needs.
  const handlePointerMove = useCallback(
    (event: React.PointerEvent<SVGSVGElement>) => {
      pointer.current = { x: event.clientX, y: event.clientY, target: event.target }
      if (pending.current !== 0) return

      pending.current = requestAnimationFrame(() => {
        pending.current = 0
        const point = pointer.current
        if (point === null) return
        anchor.current = "pointer"
        const hit = point.target instanceof Element ? point.target.closest("[data-key]") : null
        const key = hit?.getAttribute("data-key") ?? null
        // The tooltip and the trace follow at once; the detail waits to settle.
        setFocusKey(null)
        setHoverKey(key)
        settler.queue(key)
        placeTip()
      })
    },
    [settler, placeTip],
  )

  const handlePointerLeave = useCallback(() => {
    if (pending.current !== 0) cancelAnimationFrame(pending.current)
    pending.current = 0
    pointer.current = null
    setHoverKey(null)
    // Leaving is unambiguous, so the detail lets go at once rather than after the settle.
    settler.cancel()
    setSettledKey(null)
  }, [settler])

  /** A click, or Enter: pin it; again unpins. Shift compares instead. */
  const choose = useCallback(
    (pin: SankeyPin | null, asCompare: boolean) => {
      if (pin === null) {
        setSankeyCompare(null)
        setSankeyPin(null)
        return
      }
      // Comparing needs something to compare with; with no pin, it pins.
      if (asCompare && sankeyPin !== null) {
        setSankeyCompare(samePin(sankeyCompare, pin) ? null : pin)
      } else {
        setSankeyPin(samePin(sankeyPin, pin) ? null : pin)
      }
    },
    [sankeyPin, sankeyCompare, setSankeyPin, setSankeyCompare],
  )

  const handleClick = useCallback(
    (event: React.MouseEvent<SVGSVGElement>) => {
      const hit = event.target instanceof Element ? event.target.closest("[data-key]") : null
      const key = hit?.getAttribute("data-key") ?? null
      // The background clears both, as an empty click does everywhere else.
      choose(key === null ? null : parsePinKey(key), event.shiftKey)
    },
    [choose],
  )

  /*
   * The keyboard: the svg is one tab stop, and the arrows move a focused item
   * through it — two hundred paths as two hundred tab stops would be worse
   * than none. The focused item *is* the hover, with the tooltip beside it.
   */
  const focusOn = useCallback(
    (item: SankeyItem) => {
      const key = itemKey(graph, item)
      if (key === "") return
      anchor.current = "item"
      setFocusKey(key)
      setHoverKey(key)
      settler.queue(key)
    },
    [graph, settler],
  )

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<SVGSVGElement>) => {
      if (event.altKey || event.metaKey || event.ctrlKey) return
      // From wherever the reader is: the focused item, else the hovered, else the pin.
      const current = resolveKey(focusKey ?? hoverKey) ?? resolvePin(graph, sankeyPin)

      if (event.key === "Enter") {
        if (current === null) return
        event.preventDefault()
        choose(pinOf(graph, current), event.shiftKey)
        return
      }

      const next = stepFrom(graph, layout, current, event.key)
      if (next === undefined) return
      event.preventDefault()
      if (next !== null) focusOn(next)
    },
    [graph, layout, focusKey, hoverKey, sankeyPin, resolveKey, choose, focusOn],
  )

  const handleBlur = useCallback(() => {
    if (anchor.current !== "item") return
    anchor.current = "pointer"
    setFocusKey(null)
    setHoverKey(null)
    settler.cancel()
    setSettledKey(null)
  }, [settler])

  /*
   * Esc, and Cmd/Ctrl+Z, from anywhere on the page — but never out from under
   * something else that owns the key: an open dialog (whose own Esc closes it,
   * and bubbles here too), or a field being typed in, where Cmd+Z is the
   * field's.
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || isEditable(event.target)) return
      if (document.querySelector("dialog[open]") !== null) return

      if (event.key === "Escape") {
        // The compared item first: it is the more recent, lighter choice.
        if (sankeyCompare !== null) setSankeyCompare(null)
        else if (sankeyPin !== null) setSankeyPin(null)
        else return
        event.preventDefault()
        return
      }

      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "z") {
        event.preventDefault()
        if (event.shiftKey) redoSelection()
        else undoSelection()
      }
    }

    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [sankeyPin, sankeyCompare, setSankeyPin, setSankeyCompare, undoSelection, redoSelection])

  /*
   * The detail strip runs a step behind on a filter drag. Its values and the
   * step's ghost are a pass over every patient through the item — about 11 ms
   * for a big flow at 250k — and spent inside the frame that redraws the flow,
   * they make the drag stutter. Deferred, the flow lands first and the strip
   * follows in whatever time is left, or once the handle rests. The graph
   * travels with the typologies it was built from, so a new clustering never
   * reads an old graph's typology indices against a new list; pins and the
   * settled hover are resolved against that graph, not the one on screen.
   */
  const current = useMemo(() => ({ graph, typologies }), [graph, typologies])
  const detail = useDeferredValue(current)
  const detailSettled =
    isAnimating || settledKey === null ? null : resolvePin(detail.graph, parsePinKey(settledKey))

  const tracing = trace !== null
  const isEmpty = graph.nodes.length === 0
  const showSvg = size.width > 0 && size.height > 0 && !isEmpty
  const tipText = tipLines === null ? "" : tipLines.map(lineText).join(". ")
  const label =
    `Sankey of ${graph.total.toLocaleString()} patients over ${graph.steps} steps. ` +
    "Arrow keys move between flows, Enter pins, Shift+Enter compares, Escape unpins."

  return (
    <div ref={setRoot} className="chart sankey">
      <div ref={setSurface} className="chart__surface sankey__surface">
        {isEmpty && <p className="sankey__empty">No patients pass the current filters.</p>}
        {showSvg && (
          <svg
            ref={setSvg}
            className="sankey__svg"
            width={layout.contentWidth + gutter}
            height={layout.contentHeight}
            tabIndex={0}
            role="group"
            aria-label={label}
            data-tracing={tracing}
            data-filtering={inRange !== null}
            onPointerMove={handlePointerMove}
            onPointerLeave={handlePointerLeave}
            onClick={handleClick}
            onKeyDown={handleKeyDown}
            onBlur={handleBlur}
          >
            <SankeyBase
              graph={graph}
              layout={drawn.layout}
              palette={palette}
              uid={uid}
              mini={false}
              exiting={drawn.exiting}
            />
            <SankeyOverlay
              graph={graph}
              layout={drawn.layout}
              palette={palette}
              uid={uid}
              trace={trace}
              traceTone={tracedKind === null ? "accent" : "state"}
              pinned={pinned}
              compare={compared}
              hovered={hovered !== null && !sameItem(hovered, pinned) ? hovered : null}
              inRange={inRange}
            />
            <SankeyLabels
              graph={graph}
              layout={drawn.layout}
              palette={palette}
              stateNames={stateNames}
              edgeRoom={gutter}
            />
          </svg>
        )}
      </div>

      {/* Always mounted, so the rAF that places it never finds it missing. */}
      <div ref={setTip} className="sankey__tip" data-visible={tipLines !== null} aria-hidden="true">
        {tipLines?.map((line, i) => <TipRow key={i} line={line} />)}
      </div>
      <div className="sankey__live" aria-live="polite">
        {focusKey !== null ? tipText : ""}
      </div>

      <SankeyDetail
        graph={detail.graph}
        typologies={detail.typologies}
        palette={palette}
        stateNames={stateNames}
        pin={sankeyPin}
        pinned={resolvePin(detail.graph, sankeyPin)}
        comparePin={sankeyCompare}
        compared={resolvePin(detail.graph, sankeyCompare)}
        hovered={detailSettled}
      />

      <SankeyStats graph={graph} sizes={sizes} buildMs={buildMs} />
    </div>
  )
}

function sameItem(a: SankeyItem | null, b: SankeyItem | null): boolean {
  return a !== null && b !== null && a.kind === b.kind && a.index === b.index
}

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return (
    target.isContentEditable ||
    target.closest("input, textarea, select, [contenteditable]") !== null
  )
}

/** Where a keyboard-focused item's tooltip hangs: off its right edge, near the top. */
function anchorOf(layout: SankeyLayout, item: SankeyItem): { x: number; y: number } | null {
  if (item.kind === "node") {
    const box = layout.nodes[item.index]
    return box === undefined ? null : { x: box.x1, y: box.y0 }
  }
  const band = layout.links[item.index]
  return band === undefined
    ? null
    : { x: (band.x0 + band.x1) / 2, y: (band.sy0 + band.ty0) / 2 + band.width / 2 }
}

/**
 * The item an arrow key moves to from `from`; `undefined` for a key that is not
 * a move, `null` when there is nowhere to go.
 *
 * Up and down stay in the column (a node's neighbours, or a link's siblings out
 * of the same node); right goes downstream — a node to its biggest flow out, a
 * flow to where it lands — and left mirrors it. With nothing focused yet, any
 * arrow starts at the top of the first column.
 */
function stepFrom(
  graph: SankeyGraph,
  layout: SankeyLayout,
  from: SankeyItem | null,
  key: string,
): SankeyItem | null | undefined {
  if (key !== "ArrowUp" && key !== "ArrowDown" && key !== "ArrowLeft" && key !== "ArrowRight") {
    return undefined
  }

  const top = (n: number): number => layout.nodes[n]?.y0 ?? 0
  const column = (step: number): number[] =>
    graph.nodes
      .filter((node) => node.step === step)
      .map((node) => node.index)
      .sort((a, b) => top(a) - top(b))
  const sizeOf = (l: number): number => (graph.links[l] as SankeyLink).size
  const biggest = (links: readonly number[]): number | null => {
    let best: number | null = null
    for (const l of links) if (best === null || sizeOf(l) > sizeOf(best)) best = l
    return best
  }

  if (from === null) {
    const first = column(0)[0]
    return first === undefined ? null : { kind: "node", index: first }
  }

  const vertical = key === "ArrowUp" ? -1 : key === "ArrowDown" ? 1 : 0

  if (from.kind === "node") {
    const node = graph.nodes[from.index] as SankeyNode
    if (vertical !== 0) {
      const nodes = column(node.step)
      const next = nodes[nodes.indexOf(from.index) + vertical]
      return next === undefined ? from : { kind: "node", index: next }
    }
    const next = biggest(
      (key === "ArrowRight" ? graph.outgoing : graph.incoming)[from.index] as readonly number[],
    )
    return next === null ? from : { kind: "link", index: next }
  }

  const link = graph.links[from.index] as SankeyLink
  if (vertical !== 0) {
    const siblings = [...(graph.outgoing[link.source] as readonly number[])].sort(
      (a, b) => (layout.links[a]?.sy0 ?? 0) - (layout.links[b]?.sy0 ?? 0),
    )
    const next = siblings[siblings.indexOf(from.index) + vertical]
    return next === undefined ? from : { kind: "link", index: next }
  }
  return { kind: "node", index: key === "ArrowRight" ? link.target : link.source }
}

/** The last layout the tween was asked for, and what it was asked under. */
interface Settled {
  readonly graph: SankeyGraph
  readonly layout: SankeyLayout
  readonly motionKey: object
  readonly vocabulary: unknown
  readonly at: number
}

interface TweenPlan {
  readonly target: SankeyLayout
  readonly started: number
  /** Where each of the target's nodes and links starts, by the target's indices. */
  readonly nodesFrom: readonly NodeBox[]
  readonly linksFrom: readonly LinkBand[]
  /** What the previous graph had and this one does not, at full size. */
  readonly leaving: SankeyExiting
}

interface TweenFrame {
  readonly plan: TweenPlan
  readonly layout: SankeyLayout
  readonly exiting: SankeyExiting
}

interface Drawn {
  readonly layout: SankeyLayout
  readonly exiting: SankeyExiting | null
  readonly isAnimating: boolean
}

const lerp = (a: number, b: number, k: number): number => a + (b - a) * k

function lerpBox(a: NodeBox, b: NodeBox, k: number): NodeBox {
  return {
    x0: lerp(a.x0, b.x0, k),
    x1: lerp(a.x1, b.x1, k),
    y0: lerp(a.y0, b.y0, k),
    y1: lerp(a.y1, b.y1, k),
  }
}

function lerpBand(a: LinkBand, b: LinkBand, k: number): LinkBand {
  return {
    x0: lerp(a.x0, b.x0, k),
    x1: lerp(a.x1, b.x1, k),
    sy0: lerp(a.sy0, b.sy0, k),
    ty0: lerp(a.ty0, b.ty0, k),
    width: lerp(a.width, b.width, k),
  }
}

/**
 * Pairs the new layout with the old by key — an item's (step, state) or (step,
 * source, target), looked up in the old graph — since indices mean nothing
 * across two graphs. Arrivals grow from nothing where they land; departures
 * shrink where they were.
 */
function planTween(
  from: Settled,
  graph: SankeyGraph,
  layout: SankeyLayout,
  started: number,
): TweenPlan {
  const nodesFrom = graph.nodes.map((node) => {
    const target = layout.nodes[node.index] as NodeBox
    const before = from.layout.nodes[from.graph.nodeAt(node.step, node.state)]
    return before ?? collapsedBox(target)
  })

  const linksFrom = graph.links.map((link) => {
    const target = layout.links[link.index] as LinkBand
    const source = (graph.nodes[link.source] as SankeyNode).state
    const destination = (graph.nodes[link.target] as SankeyNode).state
    const before = from.layout.links[from.graph.linkAt(link.step, source, destination)]
    return before ?? collapsedBand(target)
  })

  const oldKeys = graphKeys(from.graph)
  const nodes: SankeyExiting["nodes"][number][] = []
  for (const node of from.graph.nodes) {
    const box = from.layout.nodes[node.index]
    if (box === undefined || graph.nodeAt(node.step, node.state) !== -1) continue
    nodes.push({ key: oldKeys.nodes[node.index] as string, state: node.state, box })
  }
  const links: SankeyExiting["links"][number][] = []
  for (const link of from.graph.links) {
    const band = from.layout.links[link.index]
    const source = (from.graph.nodes[link.source] as SankeyNode).state
    const destination = (from.graph.nodes[link.target] as SankeyNode).state
    if (band === undefined || graph.linkAt(link.step, source, destination) !== -1) continue
    links.push({ key: oldKeys.links[link.index] as string, source, target: destination, band })
  }

  return { target: layout, started, nodesFrom, linksFrom, leaving: { nodes, links } }
}

function frameAt(plan: TweenPlan, k: number): TweenFrame {
  const { target } = plan
  return {
    plan,
    layout: {
      ...target,
      nodes: target.nodes.map((box, i) => lerpBox(plan.nodesFrom[i] ?? box, box, k)),
      links: target.links.map((band, i) => lerpBand(plan.linksFrom[i] ?? band, band, k)),
    },
    exiting: {
      nodes: plan.leaving.nodes.map((node) => ({
        ...node,
        box: lerpBox(node.box, collapsedBox(node.box), k),
      })),
      links: plan.leaving.links.map((link) => ({
        ...link,
        band: lerpBand(link.band, collapsedBand(link.band), k),
      })),
    },
  }
}

/** Read at the moment a move would start, so changing the setting applies at once. */
function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  )
}

/**
 * Moves the Sankey between layouts on the changes worth watching, and lands
 * every other one directly.
 *
 * A filter slider commits once a frame while it is dragged, and each commit is
 * a new graph; tweening those would leave the chart trailing the handle by a
 * full `DURATION_MS` for the whole drag. So only a change of the *motion key*
 * moves — order, selected typologies, row order — and even that snaps when it
 * arrives within `DURATION_MS` of the previous target (the tail of a drag), on
 * a new file (there is nothing to move from), and under reduced motion. The
 * first layout never tweens: the view's own fade-in is enough.
 *
 * The settled target lives in a ref written only in effects; the frame lives in
 * state, set per animation frame and cancelled in cleanup, so StrictMode's
 * double effects restart the same tween rather than corrupting it.
 */
function useSankeyTween(
  graph: SankeyGraph,
  layout: SankeyLayout,
  motionKey: object,
  vocabulary: unknown,
): Drawn {
  const settled = useRef<Settled | null>(null)
  const [frame, setFrame] = useState<TweenFrame | null>(null)

  // A layout effect, so the first frame of a move replaces the target before
  // it is ever painted — otherwise the chart flashes the end state first.
  useLayoutEffect(() => {
    const previous = settled.current
    if (previous !== null && previous.layout === layout) return
    const now = performance.now()
    settled.current = { graph, layout, motionKey, vocabulary, at: now }

    const moves =
      previous !== null &&
      previous.motionKey !== motionKey &&
      previous.vocabulary === vocabulary &&
      now - previous.at >= DURATION_MS &&
      previous.graph.nodes.length > 0 &&
      graph.nodes.length > 0 &&
      !prefersReducedMotion()

    setFrame(moves ? frameAt(planTween(previous, graph, layout, now), 0) : null)
  }, [graph, layout, motionKey, vocabulary])

  const plan = frame?.plan ?? null

  useEffect(() => {
    if (plan === null) return
    let handle = 0
    const step = (): void => {
      const t = Math.min(1, (performance.now() - plan.started) / DURATION_MS)
      if (t >= 1) {
        // Done: departures are purged, and the target is drawn as it is.
        handle = 0
        setFrame(null)
        return
      }
      setFrame(frameAt(plan, ease(t)))
      handle = requestAnimationFrame(step)
    }
    handle = requestAnimationFrame(step)
    return () => cancelAnimationFrame(handle)
  }, [plan])

  // A frame of an older target is never drawn: that is the snap.
  return frame !== null && frame.plan.target === layout
    ? { layout: frame.layout, exiting: frame.exiting, isAnimating: true }
    : { layout, exiting: null, isAnimating: false }
}

interface TipPart {
  readonly text: string
  readonly color: string | null
  readonly muted: boolean
}

interface TipLine {
  /** `entry` is a neighbour in a list: name left, count right, like `.dots__entry`. */
  readonly kind: "title" | "line" | "head" | "entry"
  readonly parts: readonly TipPart[]
}

const plain = (text: string): TipPart => ({ text, color: null, muted: false })
const muted = (text: string): TipPart => ({ text, color: null, muted: true })
const coloured = (text: string, color: string | undefined): TipPart => ({
  text,
  color: color ?? null,
  muted: false,
})

const count = (n: number): string => n.toLocaleString()
const typologiesLabel = (n: number): string => `${count(n)} ${n === 1 ? "typology" : "typologies"}`
const patientsLabel = (n: number): string => `${count(n)} ${n === 1 ? "patient" : "patients"}`

function lineText(line: TipLine): string {
  return line.parts.map((part) => part.text).join("")
}

/** A share as a whole percentage, with "<1%" rather than a misleading 0. */
function percent(part: number, whole: number): string {
  if (!(whole > 0)) return "0%"
  const share = (part / whole) * 100
  return share > 0 && share < 1 ? "<1%" : `${Math.round(share)}%`
}

interface Describe {
  readonly graph: SankeyGraph
  readonly layout: SankeyLayout
  readonly stateNames: readonly string[]
  readonly palette: Palette
  readonly inRange: Uint32Array | null
}

/** A pin's title in words and colour — which works for a dormant pin too. */
function titleOf(pin: SankeyPin, stateNames: readonly string[], palette: Palette): TipPart[] {
  const name = (state: number): string => stateNames[state] ?? String(state)
  if (pin.kind === "node") {
    return [coloured(name(pin.state), palette.css[pin.state]), plain(` · step ${pin.step + 1}`)]
  }
  return [
    coloured(name(pin.source), palette.css[pin.source]),
    plain(" → "),
    coloured(name(pin.target), palette.css[pin.target]),
    plain(` · step ${pin.step + 1} → ${pin.step + 2}`),
  ]
}

/**
 * The tooltip, as data: rendered as coloured lines and read out as a sentence
 * by the live region, from one source.
 *
 * A node says where its patients came from and went to, not how many arrived —
 * past the first column that is always all of them — and how many stopped. A
 * link says what share of its source went this way and what share of its
 * target came from there: the two readings of one flow.
 */
function describe(context: Describe, item: SankeyItem): TipLine[] {
  const { graph, layout, stateNames, palette, inRange } = context
  const name = (state: number): string => stateNames[state] ?? String(state)
  const state = (n: number): TipPart => {
    const id = (graph.nodes[n] as SankeyNode).state
    return coloured(name(id), palette.css[id])
  }
  const line = (...parts: TipPart[]): TipLine => ({ kind: "line", parts })

  const pin = pinOf(graph, item)
  if (pin === null) return []
  const lines: TipLine[] = [{ kind: "title", parts: titleOf(pin, stateNames, palette) }]

  if (item.kind === "node") {
    const node = graph.nodes[item.index] as SankeyNode
    const step = node.step + 1
    const column = layout.columns[node.step]?.size ?? graph.total
    const share = percent(node.size, column)
    lines.push(line(plain(`${patientsLabel(node.size)} · ${share} of step ${step}`)))

    const neighbours = (links: readonly number[], head: string, far: "source" | "target"): void => {
      if (links.length === 0) return
      const size = (l: number): number => (graph.links[l] as SankeyLink).size
      const ranked = [...links].sort((a, b) => size(b) - size(a))
      lines.push({ kind: "head", parts: [muted(head)] })
      for (const l of ranked.slice(0, TOP_NEIGHBOURS)) {
        const link = graph.links[l] as SankeyLink
        lines.push({ kind: "entry", parts: [state(link[far]), muted(` ${count(link.size)}`)] })
      }
      if (ranked.length > TOP_NEIGHBOURS) {
        lines.push({ kind: "entry", parts: [muted(`+${ranked.length - TOP_NEIGHBOURS} more`)] })
      }
    }
    neighbours(graph.incoming[node.index] as readonly number[], "← from", "source")
    neighbours(graph.outgoing[node.index] as readonly number[], "→ to", "target")

    if (node.ends > 0) {
      const stopping = percent(node.ends, node.size)
      lines.push(line(plain(`◍ ${count(node.ends)} stop here (${stopping})`)))
    }
    return lines
  }

  const link = graph.links[item.index] as SankeyLink
  const source = graph.nodes[link.source] as SankeyNode
  const target = graph.nodes[link.target] as SankeyNode
  const typologyCount =
    (graph.linkOffsets[item.index + 1] as number) - (graph.linkOffsets[item.index] as number)
  const a = state(link.source)
  const b = state(link.target)

  lines.push(line(plain(`${patientsLabel(link.size)} · ${typologiesLabel(typologyCount)}`)))
  const onward = percent(link.size, source.size)
  const inward = percent(link.size, target.size)
  lines.push(line(plain(`${onward} of `), a, plain(` at step ${link.step + 1} go on to `), b))
  lines.push(line(plain(`${inward} of `), b, plain(` at step ${link.step + 2} came from `), a))
  if (inRange !== null) {
    const lit = inRange[item.index] ?? 0
    lines.push(line(muted(`${count(lit)} of ${count(link.size)} within the duration filter`)))
  }
  return lines
}

function TipRow({ line }: { readonly line: TipLine }): React.JSX.Element {
  return (
    <span className="sankey__tip-line" data-kind={line.kind}>
      {line.parts.map((part, i) => (
        <span
          key={i}
          className={part.muted ? "sankey__tip-muted" : undefined}
          style={part.color === null ? undefined : { color: part.color }}
        >
          {part.text}
        </span>
      ))}
    </span>
  )
}

/** What an x value is, for this kind of item and this metric. */
function captionOf(pin: SankeyPin, metric: SankeyMetric, stateNames: readonly string[]): string {
  const name = (state: number): string => stateNames[state] ?? String(state)
  if (metric === "diseaseDuration") return "disease duration, per patient, whole trajectory"
  if (pin.kind === "link") {
    const a = name(pin.source)
    const b = name(pin.target)
    if (metric === "duration") return `years from ${a} to ${b}`
    if (metric === "age") return `age on reaching ${b}`
    return `calendar year of ${a} → ${b}`
  }
  const a = name(pin.state)
  if (metric === "duration") return `years in ${a} before the next state`
  if (metric === "age") return `age on reaching ${a}`
  return `calendar year of reaching ${a}`
}

const unitOf = (metric: SankeyMetric): string => (metric === "year" ? "" : "y")

interface Slot {
  readonly pin: SankeyPin
  /** `null` when the pin is dormant — the filters emptied it. */
  readonly item: SankeyItem | null
  readonly role: CurveRole
}

interface Measured {
  readonly values: Float64Array
  readonly summary: ValueSummary
}

type ValueContext = Omit<SankeyMetricOptions, "item" | "metric">

/** An item's metric values and their summary, once per graph, item and metric. */
function useMeasured(
  context: ValueContext | null,
  item: SankeyItem | null,
  metric: SankeyMetric,
): Measured | null {
  const kind = item?.kind ?? null
  const index = item?.index ?? -1
  return useMemo(() => {
    if (context === null || kind === null) return null
    const values = sankeyMetricValues({ ...context, item: { kind, index }, metric })
    return { values, summary: summarise(values) }
  }, [context, kind, index, metric])
}

function formatSummary(summary: ValueSummary, unit: string): string {
  if (summary.n === 0) return "no values"
  // Two decimals when the middle half is narrower than a unit, one otherwise.
  const digits = summary.q3 - summary.q1 < 1 ? 2 : 1
  const f = (value: number): string => value.toFixed(digits)
  const suffix = unit === "" ? "" : ` ${unit}`
  const median = f(summary.median)
  const iqr = `${f(summary.q1)}–${f(summary.q3)}`
  return `${count(summary.n)} · median ${median} · IQR ${iqr} · mean ${f(summary.mean)}${suffix}`
}

/**
 * The strip under the flow: what is pinned (or, with nothing pinned, what the
 * pointer has settled on), how its patients sit on one metric against everyone
 * at their step, and what to do with them.
 *
 * Fixed in height, because every pixel of it comes out of the Sankey above; the
 * words on the left, the distribution filling the rest.
 */
function SankeyDetail({
  graph,
  typologies,
  palette,
  stateNames,
  pin,
  pinned,
  comparePin,
  compared,
  hovered,
}: {
  /** Deferred, with the typologies it was built from: see `SankeyChart`. */
  readonly graph: SankeyGraph
  readonly typologies: readonly Typology[]
  readonly palette: Palette
  readonly stateNames: readonly string[]
  readonly pin: SankeyPin | null
  readonly pinned: SankeyItem | null
  readonly comparePin: SankeyPin | null
  readonly compared: SankeyItem | null
  /** The settled hover. */
  readonly hovered: SankeyItem | null
}): React.JSX.Element {
  const store = useEras((s) => s.store)
  const selection = useEras((s) => s.selection)
  const mapping = useEras((s) => s.mapping)
  const sankeyMetric = useEras((s) => s.sankeyMetric)
  const setSankeyMetric = useEras((s) => s.setSankeyMetric)
  const setSankeyPin = useEras((s) => s.setSankeyPin)
  const setSankeyCompare = useEras((s) => s.setSankeyCompare)
  const selectTypologies = useEras((s) => s.selectTypologies)
  const selectPath = useEras((s) => s.selectPath)
  const selectedTypologies = useEras((s) => s.selectedTypologies)
  const pathPrefix = useEras((s) => s.pathPrefix)
  const drillDown = useEras((s) => s.drillDown)
  const duration = useEras((s) => s.filters.duration)
  const durationInverted = useEras((s) => s.filters.inverted.duration === true)

  // Without a date column the years are ages under another name (see build.ts).
  const hasDates = mapping?.mapping.date !== null
  const metric: SankeyMetric = sankeyMetric === "year" && !hasDates ? "duration" : sankeyMetric

  const hoveredPin = hovered === null ? null : pinOf(graph, hovered)
  const primary: Slot | null =
    pin !== null
      ? { pin, item: pinned, role: "pinned" }
      : hovered !== null && hoveredPin !== null
        ? { pin: hoveredPin, item: hovered, role: "hovered" }
        : null
  // A dormant pin still owns the primary slot: hover only ever feeds the second.
  const secondary: Slot | null =
    comparePin !== null
      ? { pin: comparePin, item: compared, role: "compare" }
      : pin !== null && hovered !== null && hoveredPin !== null && !samePin(hoveredPin, pin)
        ? { pin: hoveredPin, item: hovered, role: "hovered" }
        : null

  const context = useMemo<ValueContext | null>(
    () =>
      store === null || selection === null
        ? null
        : { store, graph, typologies, mask: selection.mask },
    [store, graph, typologies, selection],
  )

  const first = useMeasured(context, primary?.item ?? null, metric)
  const second = useMeasured(context, secondary?.item ?? null, metric)

  const ghostStep = primary?.item === null || primary === null ? -1 : primary.pin.step
  const ghostKind = primary?.pin.kind ?? "link"
  const ghost = useMemo(
    () =>
      context === null || ghostStep < 0
        ? null
        : stepMetricValues({
            store: context.store,
            typologies: context.typologies,
            mask: context.mask,
            step: ghostStep,
            kind: ghostKind,
            metric,
          }),
    [context, ghostStep, ghostKind, metric],
  )

  // The scope a pinned node's actions apply to; back to "all" for a new pin.
  const scopeOwner = pin === null ? "" : pinKey(pin)
  const [scopeState, setScopeState] = useState<{ owner: string; scope: SankeyScope }>({
    owner: "",
    scope: "all",
  })
  const scope: SankeyScope = scopeState.owner === scopeOwner ? scopeState.scope : "all"

  const pinnedKind = pinned?.kind ?? null
  const pinnedIndex = pinned?.index ?? -1
  const scoped = useMemo(
    () =>
      pinnedKind === null
        ? null
        : typologiesThrough(
            graph,
            typologies,
            { kind: pinnedKind, index: pinnedIndex },
            pinnedKind === "node" ? scope : "all",
          ),
    [graph, typologies, pinnedKind, pinnedIndex, scope],
  )

  const unit = unitOf(metric)
  const curveOf = (slot: Slot | null, measured: Measured | null): SankeyCurve | null =>
    slot === null || measured === null
      ? null
      : { values: measured.values, role: slot.role, median: measured.summary.median }

  const pinnedNode = pinned?.kind === "node" ? (graph.nodes[pinned.index] ?? null) : null
  const pinnedLink = pinned?.kind === "link" ? (graph.links[pinned.index] ?? null) : null
  const scopeSize =
    pinnedNode !== null
      ? scope === "all"
        ? pinnedNode.size
        : scope === "continuing"
          ? pinnedNode.outflow
          : pinnedNode.ends
      : (pinnedLink?.size ?? 0)
  const unchanged = scopeSize === (selection?.count ?? -1)

  const keysOf = (indices: Uint32Array): string[] =>
    Array.from(indices, (t) => (typologies[t] as Typology).key)

  const showOnly = (): void => {
    if (pin === null || scoped === null) return
    /*
     * A first-step node or flow *is* a path prefix, so it goes through the
     * path explorer — its breadcrumb then describes the selection instead of
     * going blank, which a list of keys would make it do.
     *
     * Only when that is still a narrowing, though. `selectPath` picks every
     * typology under the prefix, not just the ones on screen: with a hand-picked
     * selection already narrowing the Sankey, it would bring back typologies the
     * reader had left out, and "show only" would show more. The prefix is safe
     * from the whole cohort, or from a path it extends.
     */
    if (pin.step === 0 && (pin.kind === "link" || scope === "all")) {
      const path = pin.kind === "link" ? [pin.source, pin.target] : [pin.state]
      const extendsCurrent =
        pathPrefix.length > 0 &&
        pathPrefix.length <= path.length &&
        pathPrefix.every((state, i) => path[i] === state)
      if (selectedTypologies.length === 0 || extendsCurrent) {
        selectPath(path)
        return
      }
    }
    selectTypologies(keysOf(scoped))
  }

  const typologyCount = (item: SankeyItem): number => {
    const offsets = item.kind === "node" ? graph.nodeOffsets : graph.linkOffsets
    return (offsets[item.index + 1] as number) - (offsets[item.index] as number)
  }

  const scopes: readonly { value: SankeyScope; label: string; count: number }[] =
    pinnedNode === null
      ? []
      : [
          { value: "all", label: "All", count: pinnedNode.size },
          { value: "continuing", label: "Continuing", count: pinnedNode.outflow },
          { value: "ending", label: "Stopping here", count: pinnedNode.ends },
        ]

  const statRow = (slot: Slot | null, measured: Measured | null): React.JSX.Element | null => {
    if (slot === null) return null
    return (
      <p className="sankey__stat" data-role={slot.role}>
        <span className="sankey__stat-swatch" aria-hidden="true" />
        <span className="sankey__stat-text">
          {slot.item === null
            ? "0 patients under the current filters"
            : measured === null
              ? "—"
              : formatSummary(measured.summary, unit)}
        </span>
        {slot.role === "compare" && (
          <button
            type="button"
            className="sankey__stat-clear"
            title="Stop comparing · Esc"
            aria-label="Stop comparing"
            onClick={() => setSankeyCompare(null)}
          >
            ✕
          </button>
        )}
      </p>
    )
  }

  const sizeOf = (item: SankeyItem): number =>
    (item.kind === "node" ? graph.nodes[item.index]?.size : graph.links[item.index]?.size) ?? 0
  const counts =
    primary === null
      ? ""
      : primary.item === null
        ? " · 0 patients under the current filters"
        : ` · ${patientsLabel(sizeOf(primary.item))} · ` +
          typologiesLabel(typologyCount(primary.item))

  return (
    <div className="sankey__detail">
      <p className="sankey__detail-head" role="status">
        {primary === null ? (
          <span className="sankey__hint">{HINT}</span>
        ) : (
          <>
            <span className="sankey__detail-title" data-role={primary.role}>
              {titleOf(primary.pin, stateNames, palette).map((part, i) => (
                <span key={i} style={part.color === null ? undefined : { color: part.color }}>
                  {part.text}
                </span>
              ))}
              <span className="sankey__detail-counts">{counts}</span>
            </span>
            {primary.role === "pinned" ? (
              <button
                type="button"
                className="button button--tiny"
                title="Unpin · Esc"
                aria-label="Unpin"
                onClick={() => setSankeyPin(null)}
              >
                ✕
              </button>
            ) : (
              <span className="sankey__hint">click to pin</span>
            )}
          </>
        )}
      </p>

      <div className="sankey__detail-side">
        <div className="sankey__metrics" role="group" aria-label="Distribution of">
          {METRICS.map((option) => {
            const unavailable = option.value === "year" && !hasDates
            return (
              <button
                key={option.value}
                type="button"
                className="button button--tiny"
                data-selected={metric === option.value}
                disabled={unavailable}
                {...(unavailable
                  ? { title: "This file has no date column, so there are no years to plot" }
                  : {})}
                onClick={() => setSankeyMetric(option.value)}
              >
                {option.label}
              </button>
            )
          })}
        </div>

        {statRow(primary, first)}
        {statRow(secondary, second)}

        {scopes.length > 0 && (
          <div className="sankey__scopes" role="group" aria-label="Which of its patients">
            {scopes.map((option) => (
              <button
                key={option.value}
                type="button"
                className="button button--tiny"
                data-selected={scope === option.value}
                disabled={option.count === 0}
                onClick={() => setScopeState({ owner: scopeOwner, scope: option.value })}
              >
                {option.label} {option.count.toLocaleString()}
              </button>
            ))}
          </div>
        )}

        {pinned !== null && scoped !== null && (
          <div className="sankey__actions">
            <button
              type="button"
              className="button button--tiny"
              disabled={unchanged || scoped.length === 0}
              title={
                unchanged
                  ? "These are already the only patients on screen"
                  : "Narrow every view, this one included, to the typologies through it"
              }
              onClick={showOnly}
            >
              Show only these {scoped.length.toLocaleString()} typologies
            </button>
            <button
              type="button"
              className="button button--tiny"
              disabled={scoped.length === 0}
              title="Select them and open the Trajectories view"
              onClick={() => drillDown(keysOf(scoped))}
            >
              Open in Trajectories →
            </button>
          </div>
        )}
      </div>

      <SankeyDistribution
        primary={curveOf(primary, first)}
        secondary={curveOf(secondary, second)}
        ghost={ghost}
        ghostLabel={
          primary === null
            ? ""
            : primary.pin.kind === "link"
              ? `grey: every flow from step ${primary.pin.step + 1}`
              : `grey: everyone at step ${primary.pin.step + 1}`
        }
        caption={primary === null ? "" : captionOf(primary.pin, metric, stateNames)}
        unit={unit}
        band={
          metric === "duration" && duration !== null
            ? { range: duration, inverted: durationInverted }
            : null
        }
        lockKey={pin === null ? null : `${pinKey(pin)}|${metric}`}
      />
    </div>
  )
}

function SankeyStats({
  graph,
  sizes,
  buildMs,
}: {
  readonly graph: SankeyGraph
  readonly sizes: Uint32Array
  readonly buildMs: number
}): React.JSX.Element {
  const selection = useEras((s) => s.selection)
  const selectionVersion = useEras((s) => s.selectionVersion)
  const cohortSize = useEras((s) => s.cohortSize)
  const typologyTotal = useEras((s) => s.typologies.length)
  const selectedTypologies = useEras((s) => s.selectedTypologies)
  const clearTypologies = useEras((s) => s.clearTypologies)
  const undoSelection = useEras((s) => s.undoSelection)
  const redoSelection = useEras((s) => s.redoSelection)
  const cannotUndo = useEras((s) => s.selectionHistory.past.length === 0)
  const cannotRedo = useEras((s) => s.selectionHistory.future.length === 0)

  const liveTypologies = useMemo(() => {
    let n = 0
    for (let t = 0; t < sizes.length; t++) if ((sizes[t] as number) > 0) n += 1
    return n
  }, [sizes])

  return (
    <div className="chart__stats sankey__stats">
      <span key={selectionVersion}>
        <b>{(selection?.count ?? 0).toLocaleString()}</b> / {cohortSize.toLocaleString()} patients
      </span>
      <span>
        <b>{liveTypologies.toLocaleString()}</b> typologies
      </span>
      <span>
        <b>{graph.steps}</b> steps
      </span>
      <span>
        <b>{graph.links.length.toLocaleString()}</b> flows
      </span>
      <span>
        built <b>{buildMs.toFixed(1)}ms</b>
      </span>
      {/*
       * The Sankey is drawn from the selection, so after a drill-down and back
       * it shows only what was drilled into. This says so, and is the way back.
       */}
      {selectedTypologies.length > 0 && (
        <button
          type="button"
          className="chart__stats-isolated"
          title="Show every typology again"
          onClick={clearTypologies}
        >
          {count(selectedTypologies.length)} of {count(typologyTotal)} typologies ✕
        </button>
      )}
      <span className="sankey__history">
        <button
          type="button"
          className="button button--tiny"
          disabled={cannotUndo}
          title="Undo the last selection change · ⌘Z / Ctrl+Z"
          aria-label="Undo selection"
          onClick={undoSelection}
        >
          ↶
        </button>
        <button
          type="button"
          className="button button--tiny"
          disabled={cannotRedo}
          title="Redo · ⇧⌘Z / Ctrl+Shift+Z"
          aria-label="Redo selection"
          onClick={redoSelection}
        >
          ↷
        </button>
      </span>
    </div>
  )
}
