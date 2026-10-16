import type { PathNode, PathSteps, PathTree } from "../core/stats/pathTree.ts"

interface Props {
  readonly tree: PathTree
  readonly steps: PathSteps
  /** `walkSteps(tree, steps)` — the node each step reaches, root first. */
  readonly levels: readonly number[]
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
 * the chart's own colours, and every step is a click back to that depth.
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

      {steps.map((state, depth) => {
        // Patients still in after this step: everyone under the node it reached.
        const node = tree.nodes[levels[depth + 1] ?? -1]
        const size = node?.size ?? 0
        const ends = node?.ends ?? 0
        const isLast = depth === steps.length - 1
        const name = stateNames[state]

        return (
          <li key={depth}>
            <span className="flow__arrow" aria-hidden="true">
              →
            </span>
            <button
              type="button"
              className="flow__step"
              data-active={isLast}
              title={`${name}: ${size.toLocaleString()} reach here, ${ends.toLocaleString()} stop here`}
              onClick={() => onStep(steps.slice(0, depth + 1))}
            >
              <span className="flow__dot" style={{ background: palette[state] }} aria-hidden="true" />
              {name}
              {showCounts && <em>{size.toLocaleString()}</em>}
            </button>
          </li>
        )
      })}
    </ol>
  )
}
