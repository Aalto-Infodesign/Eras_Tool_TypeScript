import { useEffect, useMemo, useState } from "react"

import { useEras } from "../app/store.ts"
import { buildPalette } from "../core/render/palette.ts"
import { filteredSizes, typologyIds } from "../core/stats/silhouettes.ts"
import { downloadText, safeFilename } from "../core/util/download.ts"
import type { Typology } from "../core/types.ts"
import { Panel } from "./Panel.tsx"
import { RangeSlider } from "./RangeSlider.tsx"
import { SilhouetteGlyph } from "./SilhouetteGlyph.tsx"

type SortKey = "size" | "length" | "name"
type Tab = "all" | "selected"

const SORTS: Record<SortKey, string> = {
  size: "size",
  length: "length",
  name: "name",
}

const CARD_WIDTH = 85
const CARD_HEIGHT = 112
const GLYPH_SIZE = 56
const CHIP_GLYPH = 22
/**
 * Chips shown for the selection before it collapses to a count.
 *
 * Clicking a card selects one typology, but the path explorer selects every
 * typology under a prefix — hundreds of them. Rendering a glyph each would cost
 * more than the whole rest of the panel and say less than the number does.
 */
const MAX_CHIPS = 18
/** Rows of cards kept mounted above and below the viewport. */
const OVERSCAN = 2

interface Entry {
  readonly typology: Typology
  /** Patients still passing the filters, or `null` when nothing is filtered. */
  readonly live: number | null
}

/**
 * The silhouettes: every typology as a card you can read, select and export.
 *
 * This replaces a text list of `A-B-C` keys, which is exactly the thing the
 * original stopped doing — a sequence is a *shape*, and the eye groups shapes
 * far faster than it parses dash-separated names. Each card carries the same
 * glyph the chart would draw, the group's size and share, and two actions that
 * were the point of the original panel: export this group's ids, and restack the
 * chart's rows so this shape reads as a staircase.
 *
 * The list is windowed rather than capped. The previous version showed the 40
 * biggest groups and told you how many it was hiding, because a real dataset has
 * thousands and the original needed react-virtuoso to survive them. A fixed card
 * size makes windowing arithmetic rather than a library: only the rows near the
 * viewport are mounted, so the whole tail is reachable at the cost of a screenful.
 */
export function TypologyList(): React.JSX.Element | null {
  const store = useEras((s) => s.store)
  const typologies = useEras((s) => s.typologies)
  const visibleStates = useEras((s) => s.visibleStates)
  const selected = useEras((s) => s.selectedTypologies)
  const population = useEras((s) => s.population)
  const selectionVersion = useEras((s) => s.selectionVersion)
  const toggle = useEras((s) => s.toggleTypology)
  const clear = useEras((s) => s.clearTypologies)

  const [tab, setTab] = useState<Tab>("all")
  const [sortKey, setSortKey] = useState<SortKey>("size")
  /** Share band in percent. `null` is "no band", which is not the same as [0, max]. */
  const [percentRange, setPercentRange] = useState<readonly [number, number] | null>(null)
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null)
  const [viewport, setViewport] = useState({ width: 258, height: 300 })
  const [scrollTop, setScrollTop] = useState(0)

  useEffect(() => {
    if (scroller === null) return
    const observer = new ResizeObserver(([entry]) => {
      if (entry === undefined) return
      const { width, height } = entry.contentRect
      setViewport((current) =>
        current.width === width && current.height === height ? current : { width, height },
      )
    })
    observer.observe(scroller)
    return () => observer.disconnect()
  }, [scroller])

  const palette = useMemo(
    () => buildPalette(store?.stateNames.length ?? 0),
    [store?.stateNames.length],
  )

  /**
   * `stateId → row`, in the chart's ordering. A state with no row (removed, or
   * absent from this dataset) sits at -1 and is simply never drawn, because a
   * typology from before a splice cannot name one.
   */
  const rows = useMemo(() => {
    const out = new Float32Array(store?.stateNames.length ?? 0).fill(-1)
    visibleStates.forEach((state, row) => {
      out[state] = row
    })
    return out
  }, [store?.stateNames.length, visibleStates])

  /*
   * How much of each group survives the filters.
   *
   * Read against `population`, not `selection`: `selection` has already been
   * narrowed to whatever typologies are selected, so reading these cards off it
   * would zero every card but the chosen ones — the panel would erase its own
   * context the moment you used it.
   */
  const live = useMemo(() => {
    if (population === null || population.isEverything) return null
    return filteredSizes(typologies, population.mask)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typologies, population, selectionVersion])

  const entries = useMemo<Entry[]>(() => {
    const list: Entry[] = typologies.map((typology, i) => ({
      typology,
      live: live === null ? null : (live[i] as number),
    }))

    switch (sortKey) {
      case "name":
        return list.sort((a, b) => a.typology.key.localeCompare(b.typology.key))
      case "length":
        return list.sort(
          (a, b) =>
            b.typology.states.length - a.typology.states.length ||
            b.typology.size - a.typology.size,
        )
      case "size":
        return list.sort((a, b) => (b.live ?? b.typology.size) - (a.live ?? a.typology.size))
    }
  }, [typologies, live, sortKey])

  /**
   * The slider's upper bound is the biggest share, not 100.
   *
   * The original fixed it at 0–100, which on any real dataset wastes most of the
   * track: the largest silhouette is a few percent of the cohort and the whole
   * long tail — the part you actually want to lasso — lives in the first pixel.
   * The semantics are the original's; only the range is honest about the data.
   */
  const maxPercent = useMemo(() => {
    let max = 0
    for (const typology of typologies) max = Math.max(max, typology.share * 100)
    return Math.max(Math.ceil(max * 10) / 10, 0.1)
  }, [typologies])

  const inRange = (typology: Typology): boolean => {
    if (percentRange === null) return true
    const percent = typology.share * 100
    return percent >= percentRange[0] && percent <= percentRange[1]
  }

  const banded = useMemo(
    () => entries.filter(({ typology }) => inRange(typology)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [entries, percentRange],
  )

  /*
   * The count is summed, not materialised. Turning it into the id strings costs
   * one UTF-8 decode per patient — a quarter of a million of them on the full
   * dataset — and the original paid that on every render just to label a button.
   * Here the strings are built when the button is pressed.
   */
  const bandedPatients = banded.reduce((total, e) => total + (e.live ?? e.typology.size), 0)

  // A Set, not `includes`: with a path selection this runs against hundreds of
  // keys on every render of a list that is already thousands long.
  const selectedKeys = new Set(selected)
  const selectedEntries = entries.filter(({ typology }) => selectedKeys.has(typology.key))

  /*
   * Which list the grid is showing. The selected tab reuses `entries`, so it
   * inherits the sort — reading a selection back in a different order from the
   * one you picked it in is its own small confusion.
   */
  const shown = tab === "all" ? banded : selectedEntries

  if (store === null || typologies.length === 0) return null

  const exportIds = (groups: readonly Typology[], filename: string): void => {
    const ids = typologyIds(groups, store.ids, live === null ? null : (population?.mask ?? null))
    if (ids.length === 0) return
    downloadText(filename, ids.join("\n"), "text/plain")
  }

  const columns = Math.max(1, Math.floor(viewport.width / CARD_WIDTH))
  const gridRows = Math.ceil(shown.length / columns)
  const firstRow = Math.max(0, Math.floor(scrollTop / CARD_HEIGHT) - OVERSCAN)
  const mountedRows = Math.ceil(viewport.height / CARD_HEIGHT) + OVERSCAN * 2
  const mounted = shown.slice(firstRow * columns, (firstRow + mountedRows) * columns)

  const selectedPatients = selectedEntries.reduce(
    (total, e) => total + (e.live ?? e.typology.size),
    0,
  )

  return (
    <Panel
      title="Typologies"
      defaultOpen
      count={
        <>
          {selected.length > 0 && <em className="panel__badge">{selected.length}</em>}
          {typologies.length.toLocaleString()}
        </>
      }
    >
      {/*
       * Two views of one list. Selecting from a list of thousands and then
       * wanting to *look* at what you selected are different tasks, and hunting
       * the chosen cards back out of the full grid is the worse of the two —
       * which is why the selection used to collapse to a row of chips. A tab
       * shows them at full size instead, with every card's actions intact.
       */}
      <div className="silhouettes__tabs" role="tablist">
        {([
          ["all", "All", typologies.length],
          ["selected", "Selected", selected.length],
        ] as const).map(([value, label, count]) => (
          <button
            key={value}
            type="button"
            role="tab"
            className="silhouettes__tab"
            aria-selected={tab === value}
            data-selected={tab === value}
            onClick={() => {
              setTab(value)
              // The two lists have nothing to do with each other's length, so
              // carrying the offset across lands somewhere arbitrary.
              setScrollTop(0)
              scroller?.scrollTo({ top: 0 })
            }}
          >
            {label}
            <em>{count.toLocaleString()}</em>
          </button>
        ))}
      </div>

      <div className="silhouettes__controls">
        {(Object.keys(SORTS) as SortKey[]).map((key) => (
          <button
            key={key}
            type="button"
            className="button button--tiny"
            data-selected={sortKey === key}
            onClick={() => setSortKey(key)}
          >
            {SORTS[key]}
          </button>
        ))}
      </div>

      {/*
       * The share band. Its job is bulk export: drag the top handle down to the
       * first percent and you have every rare silhouette in one file. It filters
       * the full list, so it has no meaning over an explicit selection.
       */}
      <div className="silhouettes__band" hidden={tab !== "all"}>
        <p className="silhouettes__legend">
          <span>Share of cohort</span>
          <em>
            {percentRange === null
              ? `0 – ${maxPercent}%`
              : `${percentRange[0].toFixed(2)} – ${percentRange[1].toFixed(2)}%`}
          </em>
        </p>
        <RangeSlider
          bounds={[0, maxPercent]}
          value={percentRange}
          width={Math.max(120, Math.round(viewport.width))}
          inverted={false}
          onChange={setPercentRange}
        />
        <div className="silhouettes__band-actions">
          <button
            type="button"
            className="button button--tiny"
            disabled={percentRange === null}
            title="Drop the share band"
            onClick={() => setPercentRange(null)}
          >
            ↺
          </button>
          <button
            type="button"
            className="button"
            disabled={bandedPatients === 0}
            title={`Export the ids of every patient in the ${banded.length} silhouettes in the band`}
            onClick={() =>
              exportIds(
                banded.map((e) => e.typology),
                percentRange === null
                  ? "silhouettes_all.txt"
                  : `silhouettes_${percentRange[0].toFixed(2)}-${percentRange[1].toFixed(2)}pct.txt`,
              )
            }
          >
            ⤓ {bandedPatients.toLocaleString()} ids
          </button>
        </div>
      </div>

      <div
        className="silhouettes"
        ref={setScroller}
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      >
        {/* Spacer holds the true scroll height while only the window mounts. */}
        <div style={{ height: gridRows * CARD_HEIGHT, position: "relative" }}>
          <ul
            className="silhouettes__grid"
            style={{ transform: `translateY(${firstRow * CARD_HEIGHT}px)` }}
          >
            {mounted.map(({ typology, live: survivors }) => (
              <Card
                key={typology.key}
                typology={typology}
                live={survivors}
                liveCohort={population?.count ?? 0}
                rows={rows}
                rowCount={visibleStates.length}
                palette={palette.css}
                maxSteps={store.extents.maxTrajectoryLength}
                isSelected={selectedKeys.has(typology.key)}
                onToggle={() => toggle(typology.key)}
                onExport={() =>
                  exportIds([typology], `silhouette_${safeFilename(typology.key)}.txt`)
                }
              />
            ))}
          </ul>
        </div>
      </div>

      {tab === "selected" && selected.length === 0 && (
        <p className="silhouettes__empty">
          Nothing selected. Pick cards from <b>All</b>, or walk a path in the explorer.
        </p>
      )}

      {/*
       * On the full list the selection collapses to chips — the same glyph at
       * chip size, so what is cutting the chart stays recognisable after the
       * grid has been scrolled somewhere else. On the selected tab the cards
       * *are* that answer, at full size, so chips would only repeat them.
       */}
      {tab === "all" && selectedEntries.length > 0 && (
        <div className="silhouettes__selection">
          <ul className="silhouettes__chips">
            {selectedEntries.slice(0, MAX_CHIPS).map(({ typology }) => (
              <li key={typology.key}>
                <button
                  type="button"
                  className="silhouettes__chip"
                  title={`${typology.key} — click to deselect`}
                  onClick={() => toggle(typology.key)}
                >
                  <SilhouetteGlyph
                    states={typology.states}
                    rows={rows}
                    rowCount={visibleStates.length}
                    palette={palette.css}
                    maxSteps={store.extents.maxTrajectoryLength}
                    size={CHIP_GLYPH}
                  />
                </button>
              </li>
            ))}
          </ul>
          <div className="silhouettes__selection-foot">
            {selectedEntries.length > MAX_CHIPS && (
              <span className="silhouettes__more">
                +{(selectedEntries.length - MAX_CHIPS).toLocaleString()} more
              </span>
            )}
            <button
              type="button"
              className="button button--tiny"
              onClick={() => setTab("selected")}
            >
              See all
            </button>
            <button type="button" className="button button--tiny" onClick={clear}>
              Clear {selected.length.toLocaleString()}
            </button>
          </div>
        </div>
      )}

      {tab === "selected" && selectedEntries.length > 0 && (
        <div className="silhouettes__selection-foot">
          <button
            type="button"
            className="button"
            title={`Export the ids of every patient in the ${selectedEntries.length} selected silhouettes`}
            onClick={() =>
              exportIds(
                selectedEntries.map((e) => e.typology),
                "silhouettes_selected.txt",
              )
            }
          >
            ⤓ {selectedPatients.toLocaleString()} ids
          </button>
          <button type="button" className="button button--tiny" onClick={clear}>
            Clear
          </button>
        </div>
      )}

    </Panel>
  )
}

interface CardProps {
  readonly typology: Typology
  readonly live: number | null
  /** Patients passing the filters, the denominator of the second share line. */
  readonly liveCohort: number
  readonly rows: Float32Array
  readonly rowCount: number
  readonly palette: readonly string[]
  readonly maxSteps: number
  readonly isSelected: boolean
  readonly onToggle: () => void
  readonly onExport: () => void
}

function Card({
  typology,
  live,
  liveCohort,
  rows,
  rowCount,
  palette,
  maxSteps,
  isSelected,
  onToggle,
  onExport,
}: CardProps): React.JSX.Element {
  // Only worth two lines when the filters actually took something out of *this*
  // group; otherwise the second line repeats the first on every card.
  const showsFiltered = live !== null && live !== typology.size
  const percent = typology.share * 100

  return (
    <li
      className="silhouette"
      data-selected={isSelected}
      /* The windowing arithmetic assumes a fixed cell, and a card grows a line
         when filters are live — so the size is pinned here rather than left to
         the content, and the stats block reserves both lines either way. */
      style={{ width: CARD_WIDTH, height: CARD_HEIGHT }}
    >
      {/*
       * The action sits outside the select button rather than inside it: a
       * button inside a button is invalid HTML, and the version that nests them
       * loses the click to the card underneath as often as not.
       *
       * "Order rows by this shape" used to live here. It moved into the chart
       * itself: selecting a typology now draws it along its own steps, so there
       * is no global ordering left to bend toward one sequence.
       */}
      <div className="silhouette__actions">
        <button
          type="button"
          className="button button--tiny"
          title="Export this silhouette's patient ids"
          onClick={onExport}
        >
          ⤓
        </button>
      </div>

      <button
        type="button"
        className="silhouette__body"
        title={typology.key}
        onClick={onToggle}
        aria-pressed={isSelected}
      >
        <span className="silhouette__stats">
          <span className="silhouette__stat" data-stale={showsFiltered}>
            {percent < 1 ? percent.toFixed(2) : percent.toFixed(1)}%
            <em>{typology.size.toLocaleString()}</em>
          </span>
          {showsFiltered && (
            <span className="silhouette__stat silhouette__stat--live">
              {/* Share of who is *left*, not of who there was — the same number
                  the first line shows, asked of the filtered cohort. */}
              {(liveCohort === 0 ? 0 : (live / liveCohort) * 100).toFixed(2)}%
              <em>{live.toLocaleString()}</em>
            </span>
          )}
        </span>

        <SilhouetteGlyph
          states={typology.states}
          rows={rows}
          rowCount={rowCount}
          palette={palette}
          maxSteps={maxSteps}
          size={GLYPH_SIZE}
        />
      </button>
    </li>
  )
}
