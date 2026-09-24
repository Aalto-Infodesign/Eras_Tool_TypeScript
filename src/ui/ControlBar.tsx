import { CLUSTERING_ENABLED } from "../app/features.ts"
import { useEras, type ChartLayer } from "../app/store.ts"
import type { RendererKind } from "../core/render/Renderer.ts"
import type { XAxis } from "../core/render/geometry.ts"

const AXES: readonly { value: XAxis; label: string }[] = [
  { value: "age", label: "Age" },
  { value: "year", label: "Calendar" },
]

const BACKENDS: readonly { value: RendererKind; label: string }[] = [
  { value: "webgl2", label: "WebGL2" },
  { value: "canvas2d", label: "Canvas2D" },
]

const LAYERS: readonly { value: ChartLayer; label: string }[] = [
  { value: "lines", label: "Lines" },
  { value: "lumps", label: "Lumps" },
  // Only ever offered with clustering on, and only once a run has produced
  // something — see `app/features.ts`.
  { value: "medoids", label: "Medoids" },
]

export function ControlBar(): React.JSX.Element {
  const axis = useEras((s) => s.axis)
  const setAxis = useEras((s) => s.setAxis)
  const rendererKind = useEras((s) => s.rendererKind)
  const setRendererKind = useEras((s) => s.setRendererKind)
  const opacity = useEras((s) => s.opacity)
  const setOpacity = useEras((s) => s.setOpacity)

  const chartLayer = useEras((s) => s.chartLayer)
  const setChartLayer = useEras((s) => s.setChartLayer)
  const clusterRun = useEras((s) => s.clusterRun)
  const clusterStatus = useEras((s) => s.clusterStatus)

  const hasClusters = clusterRun !== null && clusterRun.clusters.length > 0

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

      <fieldset className="controls__group">
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
      </fieldset>

      <fieldset className="controls__group">
        <legend>Layer</legend>
        {LAYERS.filter((option) => option.value !== "medoids" || CLUSTERING_ENABLED).map(
          (option) => (
            <button
              key={option.value}
              type="button"
              className="button"
              data-selected={chartLayer === option.value}
              // The run streams, so the button lights up as soon as the first
              // typology lands rather than when the whole run finishes.
              disabled={option.value === "medoids" && !hasClusters}
              title={
                option.value === "medoids" && !hasClusters
                  ? `One line per cluster — waiting for results (${clusterStatus})`
                  : undefined
              }
              onClick={() => setChartLayer(option.value)}
            >
              {option.label}
            </button>
          ),
        )}
      </fieldset>

      {/*
        * Opacity is the hairlines' control: it is what turns overplotting into a
        * density field. The other two layers do not overplot — lumps carry their
        * own fill and there are a thousand medoid spines, not a million — so the
        * slider is disabled rather than left to do nothing, which is what it did
        * in lump mode before.
        */}
      <fieldset className="controls__group controls__group--wide" disabled={chartLayer !== "lines"}>
        <legend>Line opacity</legend>
        <input
          type="range"
          min={0.02}
          max={1}
          step={0.01}
          value={opacity}
          onChange={(event) => setOpacity(Number(event.target.value))}
        />
        <span className="controls__value">
          {chartLayer === "lines" ? opacity.toFixed(2) : "—"}
        </span>
      </fieldset>
    </div>
  )
}
