import { useMemo, useState } from "react"

import { useEras } from "../app/store.ts"
import type { Distribution, DistributionPair } from "../core/stats/distributions.ts"
import type { NumericFilter, Range } from "../core/query/filters.ts"
import { FilterDistribution } from "./FilterDistribution.tsx"
import { Panel } from "./Panel.tsx"
import { RangeSlider } from "./RangeSlider.tsx"
import { StackedLines } from "./StackedLines.tsx"

export const LABELS: Record<NumericFilter, string> = {
  age: "Age",
  year: "Calendar year",
  diseaseDuration: "Disease duration",
  duration: "Segment duration",
}

/** Terse enough for a chip and for the collapsed header. */
const SHORT: Record<NumericFilter, string> = {
  age: "age",
  year: "year",
  diseaseDuration: "disease",
  duration: "segment",
}

const CHART_WIDTH = 246
const DISTRIBUTION_HEIGHT = 44
const STACKED_HEIGHT = 120

export function FiltersPanel(): React.JSX.Element | null {
  const store = useEras((s) => s.store)
  const filters = useEras((s) => s.filters)
  const distributions = useEras((s) => s.distributions)
  const selectionDistributions = useEras((s) => s.selectionDistributions)
  const selection = useEras((s) => s.selection)
  const selectionVersion = useEras((s) => s.selectionVersion)
  const cohortSize = useEras((s) => s.cohortSize)
  const setFilters = useEras((s) => s.setFilters)
  const resetFilter = useEras((s) => s.resetFilter)
  const toggleInverted = useEras((s) => s.toggleInverted)
  const axis = useEras((s) => s.axis)
  const xDomainOverride = useEras((s) => s.xDomainOverride)
  const fitXDomain = useEras((s) => s.fitXDomain)
  const resetXDomain = useEras((s) => s.resetXDomain)

  /*
   * Which population the curves describe. The *preference* is what is stored,
   * not what is drawn: with nothing selected the dataset is drawn either way,
   * and a later selection should come back to whatever was picked last.
   *
   * One or the other rather than both overlaid, so a chart only ever has one
   * y scale — a selection over the dataset needs either two scales, which
   * cannot be compared, or one, which flattens the selection to the axis.
   */
  const [curveSource, setCurveSource] = useState<"dataset" | "selection">("selection")

  const bounds = useMemo<Record<NumericFilter, readonly [number, number]> | null>(() => {
    if (store === null) return null
    return {
      age: store.extents.age,
      year: store.extents.year,
      diseaseDuration: store.extents.diseaseDuration,
      duration: store.extents.duration,
    }
  }, [store])

  const active = useMemo(
    () => (Object.keys(LABELS) as NumericFilter[]).filter((key) => filters[key] !== null),
    [filters],
  )

  if (store === null || selection === null || bounds === null || distributions === null) return null

  const curveData =
    curveSource === "selection" && selectionDistributions !== null
      ? selectionDistributions
      : distributions
  const showSelection = curveData !== distributions

  return (
    <Panel
      title="Filters"
      count={
        <span key={selectionVersion}>
          {active.length > 0 && <em className="panel__badge">{active.length}</em>}
          {selection.count.toLocaleString()} / {cohortSize.toLocaleString()}
        </span>
      }
      /*
       * The chips are the filter's memory, so they live in the summary slot
       * rather than in the body: once a range is placed, the panel can be
       * collapsed and what is still cutting the data stays legible — with its
       * two verbs, invert and drop, on the summary itself. One row that scrolls
       * sideways rather than a wrapping block, so folding the panel away buys a
       * fixed amount of column back however many filters are on.
       */
      summary={
        active.length > 0 ? (
          <ul className="chips">
            {active.map((key) => {
              const range = filters[key] as Range
              const inverted = filters.inverted[key] === true

              return (
                <li key={key} className="chip" data-inverted={inverted}>
                  <button
                    type="button"
                    className="chip__invert"
                    title={inverted ? "Filtering outside this range" : "Filter outside this range"}
                    onClick={() => toggleInverted(key)}
                  >
                    {inverted ? "◑" : "◐"}
                  </button>
                  <span className="chip__label">
                    {SHORT[key]} {inverted && "∉ "}
                    {range.min.toFixed(0)}–{range.max.toFixed(0)}
                  </span>
                  <button
                    type="button"
                    className="chip__remove"
                    title="Drop this filter"
                    onClick={() => resetFilter(key)}
                  >
                    ✕
                  </button>
                </li>
              )
            })}
          </ul>
        ) : undefined
      }
    >
      {/*
       * Manual for now. Refitting on every filter change would mean the axis
       * moving under the pointer mid-drag, which makes a filter hard to aim;
       * a button keeps the two acts separate until that is worth solving.
       */}
      <div className="filters__axis">
        <button
          type="button"
          className="button"
          disabled={selection.count === 0}
          title={`Zoom the ${axis === "age" ? "age" : "calendar"} axis onto the patients in view`}
          onClick={fitXDomain}
        >
          Fit axis to selection
        </button>
        {xDomainOverride !== null && (
          <button
            type="button"
            className="button button--tiny"
            title="Back to the full dataset extent"
            onClick={resetXDomain}
          >
            ↺
          </button>
        )}
      </div>

      {xDomainOverride !== null && (
        <p className="filters__axis-note">
          x axis: {xDomainOverride[0].toFixed(1)} – {xDomainOverride[1].toFixed(1)}
        </p>
      )}

      <StackedLines width={CHART_WIDTH} height={STACKED_HEIGHT} />

      <div className="filters__source" role="group" aria-label="Distribution curves">
        <span>Curves</span>
        <button
          type="button"
          className="button button--tiny"
          data-selected={!showSelection}
          title="Every patient in the dataset"
          onClick={() => setCurveSource("dataset")}
        >
          Dataset
        </button>
        <button
          type="button"
          className="button button--tiny"
          data-selected={showSelection}
          disabled={selectionDistributions === null}
          title={
            selectionDistributions === null
              ? "Select typologies to see their distributions"
              : "The selected typologies, each filter applied but its own"
          }
          onClick={() => setCurveSource("selection")}
        >
          Selection
        </button>
      </div>

      {(Object.keys(LABELS) as NumericFilter[]).map((key) => (
        <FilterControl
          key={key}
          name={key}
          label={LABELS[key]}
          bounds={bounds[key]}
          value={filters[key]}
          inverted={filters.inverted[key] === true}
          distribution={curveData[key]}
          onChange={(next) => setFilters({ [key]: next } as Partial<typeof filters>)}
          onInvert={() => toggleInverted(key)}
          onReset={() => resetFilter(key)}
        />
      ))}
    </Panel>
  )
}

function FilterControl({
  name,
  label,
  bounds,
  value,
  inverted,
  distribution,
  onChange,
  onInvert,
  onReset,
}: {
  name: NumericFilter
  label: string
  bounds: readonly [number, number]
  value: Range | null
  inverted: boolean
  distribution: Distribution | DistributionPair
  onChange: (next: Range) => void
  onInvert: () => void
  onReset: () => void
}): React.JSX.Element {
  /*
   * The handles' live position, which the distribution masks against. It is not
   * the committed range: a commit re-runs the filter and every layer behind it,
   * so the mask would lag the pointer by however long that takes.
   *
   * `null` outside a drag, so the committed range takes over again — a preview
   * that outlived its drag would survive a reset and leave the mask where the
   * handles no longer are.
   */
  const [preview, setPreview] = useState<readonly [number, number] | null>(null)
  const [hoverX, setHoverX] = useState<number | null>(null)

  const committed: readonly [number, number] = value === null ? bounds : [value.min, value.max]
  const shown = preview ?? committed

  const curves = useMemo(() => curvesOf(distribution), [distribution])

  const isActive = value !== null

  return (
    <div className="filter" data-active={isActive} data-inverted={inverted}>
      <div className="filter__head">
        <label>{label}</label>
        <span className="filter__value">
          {shown[0].toFixed(1)} – {shown[1].toFixed(1)}
        </span>
        <button
          type="button"
          className="button button--tiny"
          data-selected={inverted}
          title="Keep what falls outside the range instead"
          onClick={onInvert}
        >
          ◐
        </button>
        <button
          type="button"
          className="button button--tiny"
          disabled={!isActive}
          title="Reset this filter"
          onClick={onReset}
        >
          ↺
        </button>
      </div>

      <FilterDistribution
        curves={curves}
        bounds={bounds}
        selection={shown}
        width={CHART_WIDTH}
        height={DISTRIBUTION_HEIGHT}
        inverted={inverted}
        hoverX={hoverX}
      />

      <RangeSlider
        bounds={bounds}
        value={value === null ? null : [value.min, value.max]}
        width={CHART_WIDTH}
        inverted={inverted}
        onChange={(next) => onChange({ min: next[0], max: next[1] })}
        onPreview={setPreview}
        onHoverX={setHoverX}
      />

      {/* Two curves need saying which is which; one does not. */}
      {curves.length > 1 && (
        <p className="filter__legend">
          <span className="distribution--start">— starts</span>
          <span className="distribution--end">— ends</span>
          <em>{name === "age" ? "patient age span" : "patient calendar span"}</em>
        </p>
      )}
    </div>
  )
}

function curvesOf(distribution: Distribution | DistributionPair) {
  if ("start" in distribution) {
    return [
      { distribution: distribution.start, className: "distribution--start", label: "starts" },
      { distribution: distribution.end, className: "distribution--end", label: "ends" },
    ]
  }
  return [{ distribution, className: "distribution--single", label: "count" }]
}
