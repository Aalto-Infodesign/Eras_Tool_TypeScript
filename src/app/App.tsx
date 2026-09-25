import { CLUSTERING_ENABLED } from "./features.ts"
import { useEras } from "./store.ts"
import { ControlBar } from "../ui/ControlBar.tsx"
import { FileLoader } from "../ui/FileLoader.tsx"
import { FiltersPanel } from "../ui/FiltersPanel.tsx"
import { ClusterTable } from "../ui/ClusterTable.tsx"
import { PathExplorer } from "../ui/PathExplorer.tsx"
import { PerfHud } from "../ui/PerfHud.tsx"
import { StatesPanel } from "../ui/StatesPanel.tsx"
import { TrajectoriesChart } from "../ui/TrajectoriesChart.tsx"
import { TypologyList } from "../ui/TypologyList.tsx"

export function App(): React.JSX.Element {
  const status = useEras((s) => s.status)
  const hasData = useEras((s) => s.store !== null)

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
          <aside className="app__side">
            <PerfHud />
            <StatesPanel />
            <FiltersPanel />
            {CLUSTERING_ENABLED && <ClusterTable />}
            <TypologyList />
            <PathExplorer />
          </aside>

          <section className="app__chart">
            <ControlBar />
            <TrajectoriesChart />
          </section>
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
