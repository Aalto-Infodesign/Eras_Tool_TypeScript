import { findPath, type PathNode, type PathTree } from "../core/stats/pathTree.ts"

interface Props {
  readonly tree: PathTree
  readonly pathPrefix: readonly number[]
  readonly palette: readonly string[]
  readonly stateNames: readonly string[]
  readonly onStep: (prefix: readonly number[]) => void
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
 * chose: the answer is one item per column, spread across the width, with the
 * rejected options between them. This is the same path in one line, in the
 * chart's own colours, and every step is a click back to that depth.
 *
 * With counts it is also the funnel, which is the number people actually want
 * from this panel: how much of the cohort each successive step costs.
 */
export function PathFlow({
  tree,
  pathPrefix,
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
          data-active={pathPrefix.length === 0}
          title="The whole cohort"
          onClick={() => onStep([])}
        >
          All
          {showCounts && <em>{root.size.toLocaleString()}</em>}
        </button>
      </li>

      {pathPrefix.map((state, depth) => {
        const node = tree.nodes[findPath(tree, pathPrefix.slice(0, depth + 1))]
        const isLast = depth === pathPrefix.length - 1

        return (
          <li key={`${state}-${depth}`}>
            <span className="flow__arrow" aria-hidden="true">
              →
            </span>
            <button
              type="button"
              className="flow__step"
              data-active={isLast}
              title={
                node === undefined
                  ? undefined
                  : `${node.size.toLocaleString()} reach here, ${node.ends.toLocaleString()} stop here`
              }
              onClick={() => onStep(pathPrefix.slice(0, depth + 1))}
            >
              <span
                className="flow__dot"
                style={{ background: palette[state] }}
                aria-hidden="true"
              />
              {stateNames[state]}
              {showCounts && node !== undefined && <em>{node.size.toLocaleString()}</em>}
            </button>
          </li>
        )
      })}
    </ol>
  )
}
