import { CLUSTERING_ENABLED } from "../app/features.ts"
import { chartModeOf, useEras, type ChartLayer, type MainView } from "../app/store.ts"
import type { XAxis } from "../core/render/geometry.ts"
import type { SankeyOrder } from "../core/render/sankeyLayout.ts"
import { useClusterRun } from "./useClusterRun.ts"

/**
 * The same swap as the View panel's thumbnail, as words. The thumbnail shows
 * what the other view would look like; this says which one you are in. Keys 1
 * and 2 do it too, so the titles say so.
 */
const VIEWS: readonly { value: MainView; label: string; title: string }[] = [
  {
    value: "sankey",
    label: "Sankey",
    title: "Every typology as a flow from step to step · key 1",
  },
  {
    value: "trajectories",
    label: "Trajectories",
    title: "The typologies themselves, as small multiples or one on its own steps · key 2",
  },
]

/** See `SankeyOrder`. By state first: it is the default, and the app's convention. */
const ORDERS: readonly { value: SankeyOrder; label: string; title: string }[] = [
  {
    value: "state",
    label: "By state",
    title: "Each column in the States panel order — a state keeps its rank at every step",
  },
  {
    value: "flow",
    label: "Untangle",
    title: "Reorder each column to reduce crossings, as the original did",
  },
]

const AXES: readonly { value: XAxis; label: string }[] = [
  { value: "age", label: "Age" },
  { value: "year", label: "Calendar" },
]

// const BACKENDS: readonly { value: RendererKind; label: string }[] = [
//   { value: "webgl2", label: "WebGL2" },
// ]

const LAYERS: readonly { value: ChartLayer; label: string }[] = [
  { value: "lines", label: "Lines" },
  // { value: "lumps", label: "Lumps" },
  // something — see `app/features.ts`.
  { value: "medoids", label: "Medoids" },
]

export function ControlBar(): React.JSX.Element {
  const view = useEras((s) => s.view)

  const axis = useEras((s) => s.axis)
  const setAxis = useEras((s) => s.setAxis)

  const opacity = useEras((s) => s.opacity)
  const setOpacity = useEras((s) => s.setOpacity)

  const layers = useEras((s) => s.layers)
  const toggleLayer = useEras((s) => s.toggleLayer)
  const clusterRun = useClusterRun()
  const clusterStatus = useEras((s) => s.clusterStatus)
  const selectedTypologies = useEras((s) => s.selectedTypologies)

  const hasClusters = clusterRun !== null && clusterRun.clusters.length > 0
  /*
   * The grid draws every panel's own cohort whatever the Lines toggle says —
   * those hairlines *are* the panel, the thing whose slope is being compared,
   * not a layer over something else. So the slider still governs them there,
   * where in the single chart it belongs to a layer you can switch off.
   */
  const isGrid = chartModeOf(selectedTypologies) === "multiples"
  // The hairlines step back under anything drawn over them, and the slider
  // changes meaning with them. See `ViewState.bulkFade`.
  const isBackdrop = (layers.lines || isGrid) && (layers.medoids || layers.lumps)

  /*
   * Everything else here belongs to the trajectories: the Sankey has no x axis,
   * no layers and no hairlines to fade. Its one question of its own is how to
   * order a column.
   */
  if (view === "sankey") {
    return (
      <div className="controls">
        <ViewGroup />
        <OrderGroup />
      </div>
    )
  }

  return (
    <div className="controls">
      <ViewGroup />

      <fieldset className="controls__group">
        <legend>X axis</legend>
        {AXES.map((option) => (
          <button
            key={option.value}
            type="button"
            className="button"
            data-selected={axis === option.value}
            onClick={() => setAxis(option.value)}
          >
            {option.label}
          </button>
        ))}
      </fieldset>

      {/* <fieldset className="controls__group">
        <legend>Renderer</legend>
        {BACKENDS.map((option) => (
          <button
            key={option.value}
            type="button"
            className="button"
            data-selected={rendererKind === option.value}
            onClick={() => setRendererKind(option.value)}
          >
            {option.label}
          </button>
        ))}
      </fieldset> */}

      {/* Toggles, not a choice: the point of the medoid spines is how they sit
          against the field they summarise. */}
      <fieldset className="controls__group">
        <legend>Layers</legend>
        {LAYERS.filter((option) => option.value !== "medoids" || CLUSTERING_ENABLED).map(
          (option) => (
            <button
              key={option.value}
              type="button"
              className="button"
              data-selected={layers[option.value]}
              aria-pressed={layers[option.value]}
              // The run streams, so the button lights up as soon as the first
              // typology lands rather than when the whole run finishes.
              disabled={option.value === "medoids" && !hasClusters}
              title={
                option.value === "medoids" && !hasClusters
                  ? `One line per cluster — waiting for results (${clusterStatus})`
                  : undefined
              }
              onClick={() => toggleLayer(option.value)}
            >
              {option.label}
            </button>
          ),
        )}
      </fieldset>

      {/*
       * The slider belongs to the hairlines and is disabled without them — lumps
       * carry their own fill and a thousand medoid spines have nothing to
       * overplot. Its *meaning* changes when they become a backdrop: the same
       * direction, but mixing into the background instead of stacking alpha.
       */}
      <fieldset
        className="controls__group controls__group--wide"
        disabled={!layers.lines && !isGrid}
      >
        <legend
          title={isBackdrop ? "Mixed into the background, so crossings do not stack" : undefined}
        >
          {isBackdrop ? "Line backdrop" : "Line opacity"}
        </legend>
        <input
          type="range"
          min={0.02}
          max={1}
          step={0.01}
          value={opacity}
          onChange={(event) => setOpacity(Number(event.target.value))}
        />
        <span className="controls__value">{layers.lines || isGrid ? opacity.toFixed(2) : "—"}</span>
      </fieldset>
    </div>
  )
}

/** First in the bar whichever view is showing, so it never moves under the pointer. */
function ViewGroup(): React.JSX.Element {
  const view = useEras((s) => s.view)
  const setView = useEras((s) => s.setView)

  return (
    <fieldset className="controls__group">
      <legend>View</legend>
      {VIEWS.map((option) => (
        <button
          key={option.value}
          type="button"
          className="button"
          data-selected={view === option.value}
          title={option.title}
          onClick={() => setView(option.value)}
        >
          {option.label}
        </button>
      ))}
    </fieldset>
  )
}

function OrderGroup(): React.JSX.Element {
  const sankeyOrder = useEras((s) => s.sankeyOrder)
  const setSankeyOrder = useEras((s) => s.setSankeyOrder)

  return (
    <fieldset className="controls__group">
      <legend>Order</legend>
      {ORDERS.map((option) => (
        <button
          key={option.value}
          type="button"
          className="button"
          data-selected={sankeyOrder === option.value}
          title={option.title}
          onClick={() => setSankeyOrder(option.value)}
        >
          {option.label}
        </button>
      ))}
    </fieldset>
  )
}
