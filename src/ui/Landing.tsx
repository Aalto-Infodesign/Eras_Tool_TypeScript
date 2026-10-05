import { useState } from "react"

import { useEras } from "../app/store.ts"
import { PathExplorerDialog } from "./PathExplorer.tsx"

/**
 * The one step between the upload and the charts.
 *
 * Either go straight in, or walk the path explorer first: stepping through the
 * cohort before seeing any chart is a way of saying what you expect to find —
 * which paths you think matter, how many people you think took them — and of
 * having that checked against the data before the overview can suggest an
 * answer. Whatever path the walk ends on is the selection the charts open with,
 * so setting expectations is also where the analysis starts.
 */
export function Landing(): React.JSX.Element {
  const fileName = useEras((s) => s.fileName)
  const cohortSize = useEras((s) => s.cohortSize)
  const stateCount = useEras((s) => s.visibleStates.length)
  const typologyCount = useEras((s) => s.typologies.length)
  const openWorkspace = useEras((s) => s.openWorkspace)
  const reset = useEras((s) => s.reset)

  const [isExploring, setExploring] = useState(false)

  return (
    <main className="app__empty landing">
      <h1 className="app__title">
        ERAS Tool <span>· TS</span>
      </h1>
      <p className="landing__file">
        <b>{fileName}</b> · {cohortSize.toLocaleString()} patients ·{" "}
        {stateCount.toLocaleString()} states · {typologyCount.toLocaleString()} typologies
      </p>

      <div className="landing__choices">
        <button
          type="button"
          className="landing__choice landing__choice--primary"
          onClick={openWorkspace}
          autoFocus
        >
          <span className="landing__choice-title">Create visualization</span>
          <span className="landing__choice-text">Open the charts on the whole cohort.</span>
        </button>

        <button type="button" className="landing__choice" onClick={() => setExploring(true)}>
          <span className="landing__choice-title">Set expectations</span>
          <span className="landing__choice-text">
            Walk the cohort one state at a time first, and open the charts on the path you
            expect to matter.
          </span>
        </button>
      </div>

      <button type="button" className="button button--tiny landing__back" onClick={reset}>
        ← Use a different file
      </button>

      {/*
       * Mounted only once asked for: the dialog builds the path tree, which the
       * plain "Create visualization" route has no use for here.
       */}
      {isExploring && (
        <PathExplorerDialog
          open
          // Every way out — the button, Escape, the backdrop — goes on to the
          // charts, carrying the walk as the selection. Coming back here would
          // only ask the same question again.
          onClose={openWorkspace}
          closeLabel="Create visualization →"
        />
      )}
    </main>
  )
}
