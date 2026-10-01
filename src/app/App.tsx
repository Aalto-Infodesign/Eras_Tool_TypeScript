import { useEras } from "./store.ts"
import { ControlBar } from "../ui/ControlBar.tsx"
import { FileLoader } from "../ui/FileLoader.tsx"
import { SankeyChart } from "../ui/SankeyChart.tsx"
import { SettingsModal } from "../ui/SettingsModal.tsx"
import { SideColumn } from "../ui/SideColumn.tsx"
import { TrajectoriesChart } from "../ui/TrajectoriesChart.tsx"

export function App(): React.JSX.Element {
  const status = useEras((s) => s.status)
  const hasData = useEras((s) => s.store !== null)
  const view = useEras((s) => s.view)

  return (
    <div className="app">
      <header className="app__header">
        <h1>
          ERAS Tool <span>· TS</span>
        </h1>
        <FileLoader />
      </header>

      {hasData ? (
        <main className="app__main">
          <SideColumn />

          <section className="app__chart">
            <ControlBar />
            {/*
             * Keyed by the view, so a swap unmounts one chart and mounts the
             * other — a hidden Trajectories chart would go on rebuilding its
             * geometry on every filter frame and hold its WebGL context — and
             * the wrapper's fade-in plays once per swap.
             */}
            <div className="app__view" key={view}>
              {view === "sankey" ? <SankeyChart /> : <TrajectoriesChart />}
            </div>
          </section>

          <SettingsModal />
        </main>
      ) : (
        <main className="app__empty">
          <p>
            {status === "loading"
              ? "Parsing…"
              : "Drop a TSV, CSV or JSON file, or load one of the sample datasets."}
          </p>
        </main>
      )}
    </div>
  )
}
