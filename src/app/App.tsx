import { useEras } from "./store.ts"
import { FileLoader } from "../ui/FileLoader.tsx"
import { Landing } from "../ui/Landing.tsx"
import { SankeyChart } from "../ui/SankeyChart.tsx"
import { SettingsModal } from "../ui/SettingsModal.tsx"
import { SideColumn } from "../ui/SideColumn.tsx"
import { TrajectoriesChart } from "../ui/TrajectoriesChart.tsx"
// import { InteractiveBackground } from "@ui/InteractiveBackground.tsx"

export function App(): React.JSX.Element {
  const status = useEras((s) => s.status)
  const hasData = useEras((s) => s.store !== null)
  const workspaceOpen = useEras((s) => s.workspaceOpen)
  const view = useEras((s) => s.view)

  return (
    <div className="app">
      {hasData && !workspaceOpen ? (
        <Landing />
      ) : hasData ? (
        <main className="app__main">
          <SideColumn />

          <section className="app__chart">
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
        // No header: once a dataset is open the loader is the Data side panel,
        // so before then it is the whole screen.
        <main className="app__empty">
          {/* <InteractiveBackground /> */}

          <h1 className="app__title">
            ERAS Tool <span>· 2.0</span>
          </h1>
          <p>
            {status === "loading"
              ? "Parsing…"
              : "Drop a TSV, CSV or JSON file, or load one of the sample datasets."}
          </p>
          <FileLoader />
        </main>
      )}
    </div>
  )
}
