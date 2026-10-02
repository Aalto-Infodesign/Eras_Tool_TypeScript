import { CLUSTERING_ENABLED } from "../app/features.ts"
import { useSidePanels } from "../app/sidePanels.ts"
import { useEras, type ChartLayer } from "../app/store.ts"
import type { XAxis } from "../core/render/geometry.ts"
import type { SankeyOrder } from "../core/render/sankeyLayout.ts"
import { useClusterRun } from "./useClusterRun.ts"

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

/**
 * The current chart's own controls, at the end of its stats row: under the x
 * axis it switches, and out of the plot so nothing is covered. The gear comes
 * last, which puts it in the bottom-right corner.
 *
 * Which chart is big is not chosen here — the View panel and keys 1 / 2 do that.
 */
export function ChartControls(): React.JSX.Element {
  const view = useEras((s) => s.view)

  const axis = useEras((s) => s.axis)
  const setAxis = useEras((s) => s.setAxis)

  const layers = useEras((s) => s.layers)
  const toggleLayer = useEras((s) => s.toggleLayer)
  const clusterRun = useClusterRun()
  const clusterStatus = useEras((s) => s.clusterStatus)

  const hasClusters = clusterRun !== null && clusterRun.clusters.length > 0

  /*
   * Everything else here belongs to the trajectories: the Sankey has no x axis,
   * no layers and no hairlines to fade. Its one question of its own is how to
   * order a column.
   */
  if (view === "sankey") {
    return (
      <div className="controls">
        <OrderGroup />
        <SettingsButton />
      </div>
    )
  }

  return (
    <div className="controls">
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

      {/* Line opacity lives in the settings dialog — see `SettingsModal`. */}
      <SettingsButton />
    </div>
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

/** Last in the row, so in the corner: the settings that do not earn a place on screen. */
function SettingsButton(): React.JSX.Element {
  const setSettingsOpen = useSidePanels((s) => s.setSettingsOpen)

  return (
    <button
      type="button"
      className="button controls__settings"
      aria-label="Settings"
      title="Settings — line opacity, side panels"
      onClick={() => setSettingsOpen(true)}
    >
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
        <path
          fill="currentColor"
          fillRule="evenodd"
          d="M6.9 1h2.2l.4 1.9c.4.1.8.3 1.1.5l1.6-1 1.5 1.5-1 1.6c.2.3.4.7.5 1.1l1.9.4v2.2l-1.9.4c-.1.4-.3.8-.5 1.1l1 1.6-1.5 1.5-1.6-1c-.3.2-.7.4-1.1.5L9.1 15H6.9l-.4-1.9c-.4-.1-.8-.3-1.1-.5l-1.6 1-1.5-1.5 1-1.6c-.2-.3-.4-.7-.5-1.1L1 9.1V6.9l1.9-.4c.1-.4.3-.8.5-1.1l-1-1.6 1.5-1.5 1.6 1c.3-.2.7-.4 1.1-.5L6.9 1ZM8 5.6a2.4 2.4 0 1 0 0 4.8 2.4 2.4 0 0 0 0-4.8Z"
        />
      </svg>
    </button>
  )
}
