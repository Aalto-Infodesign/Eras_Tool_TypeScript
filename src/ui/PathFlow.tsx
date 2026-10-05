import type { PathNode, PathSteps, PathTree } from "../core/stats/pathTree.ts"

interface Props {
  readonly tree: PathTree
  readonly steps: PathSteps
  /** `walkSteps(tree, steps)` — the nodes each step reaches. */
  readonly levels: readonly (readonly number[])[]
  readonly palette: readonly string[]
  readonly stateNames: readonly string[]
  readonly onStep: (steps: PathSteps) => void
  /**
   * Show how many patients survive each step. The board has room for the funnel;
   * the 300px side panel does not, and there the flow is only a "where am I".
   */
  readonly showCounts?: boolean
}

/**
 * The walk so far, as `a → b → c`.
 *
 * The board shows the *decisions* — a column of alternatives per step — which is
 * what you need while choosing and the wrong thing for reading back what you
 * chose: the answer is a few items per column, spread across the width, with
 * the rejected options between them. This is the same selection in one line, in
 * the chart's own colours — a step with several states picked shows them all —
 * and every step is a click back to that depth.
 *
 * With counts it is also the funnel, which is the number people actually want
 * from this panel: how much of the cohort each successive step costs.
 */
export function PathFlow({
  tree,
  steps,
  levels,
  palette,
  stateNames,
  onStep,
  showCounts = false,
}: Props): React.JSX.Element {
  const root = tree.nodes[0] as PathNode

  return (
    <ol className="flow" aria-label="Current path">
      <li>
        <button
          type="button"
          className="flow__step flow__step--root"
          data-active={steps.length === 0}
          title="The whole cohort"
          onClick={() => onStep([])}
        >
          All
          {showCounts && <em>{root.size.toLocaleString()}</em>}
        </button>
      </li>

      {steps.map((states, depth) => {
        // Patients still in after this step: everyone under the nodes it reached.
        let size = 0
        let ends = 0
        for (const id of levels[depth + 1] ?? []) {
          const node = tree.nodes[id] as PathNode
          size += node.size
          ends += node.ends
        }
        const isLast = depth === steps.length - 1
        const names = states.map((state) => stateNames[state]).join(" or ")
        // Two names fit the side panel's line; past that the dots carry it.
        const label =
          states.length <= 2 ? names : `${stateNames[states[0] as number]} +${states.length - 1}`

        return (
          <li key={depth}>
            <span className="flow__arrow" aria-hidden="true">
              →
            </span>
            <button
              type="button"
              className="flow__step"
              data-active={isLast}
              title={`${names}: ${size.toLocaleString()} reach here, ${ends.toLocaleString()} stop here`}
              onClick={() => onStep(steps.slice(0, depth + 1))}
            >
              {states.map((state) => (
                <span
                  key={state}
                  className="flow__dot"
                  style={{ background: palette[state] }}
                  aria-hidden="true"
                />
              ))}
              {label}
              {showCounts && <em>{size.toLocaleString()}</em>}
            </button>
          </li>
        )
      })}
    </ol>
  )
}
