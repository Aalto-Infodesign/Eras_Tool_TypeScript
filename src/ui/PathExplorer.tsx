import { useEffect, useMemo, useState } from "react"

import { useEras } from "../app/store.ts"
import { buildPalette, type Palette } from "../core/render/palette.ts"
import {
  buildPathTree,
  collectTypologies,
  findPath,
  type PathNode,
  type PathTree,
} from "../core/stats/pathTree.ts"
import { filteredSizes } from "../core/stats/silhouettes.ts"
import { Modal } from "./Modal.tsx"
import { Panel } from "./Panel.tsx"
import { PathFlow } from "./PathFlow.tsx"
import { PathMinimap } from "./PathMinimap.tsx"

const MAP_HEIGHT = 150

/**
 * Walking the cohort forward one state at a time.
 *
 * The original had two separate answers to "what can follow what": a Hasse
 * diagram over a partial order of silhouettes, computed in its own worker, and
 * a React Flow board for drawing a sequence to ask whether anyone had lived it.
 * This is one answer to both, and the cheaper one — the typologies are already
 * the distinct sequences with their counts, so reading them as a prefix tree
 * costs a single pass and no library.
 *
 * Each step shows every state that was actually observed next, with how many
 * people took it. Choosing one narrows the chart to exactly those people, which
 * makes the "prediction" question fall out of the same control: if a step is not
 * offered, nobody in the cohort ever did it. You can stop anywhere — a prefix is
 * a selection in its own right — or walk to the end of a path.
 *
 * It lives in a dialog rather than in the side column. A step is a *row* of
 * alternatives and a walk is a sequence of steps, so the thing wants two axes;
 * folded into a 300px column it could only stack, which turned the one reading
 * that matters — this branch against its siblings — into scrolling. The panel
 * keeps the part that is genuinely a summary: where you are, and how much of the
 * cohort is left.
 */
export function PathExplorer(): React.JSX.Element | null {
  const store = useEras((s) => s.store)
  const typologies = useEras((s) => s.typologies)
  const population = useEras((s) => s.population)
  const selectionVersion = useEras((s) => s.selectionVersion)
  const pathPrefix = useEras((s) => s.pathPrefix)
  const selectPath = useEras((s) => s.selectPath)

  const [isOpen, setIsOpen] = useState(false)

  const palette = useMemo(
    () => buildPalette(store?.stateNames.length ?? 0),
    [store?.stateNames.length],
  )

  /*
   * Counts come from `population` — the filters, but *not* the typology
   * narrowing the explorer itself performs. Reading them off `selection` would
   * make the tree describe its own last click: every branch but the chosen one
   * would drop to zero and the alternatives the panel exists to show would
   * vanish.
   */
  const tree = useMemo(() => {
    if (population === null || population.isEverything) return buildPathTree(typologies)
    const live = filteredSizes(typologies, population.mask)
    return buildPathTree(typologies, (i) => live[i] as number)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typologies, population, selectionVersion])

  const current = findPath(tree, pathPrefix)

  // A path can outlive the tree it was walked in — a reshape rebuilds the
  // typologies under it. The store drops it on a splice; this catches the rest.
  useEffect(() => {
    if (current === -1 && pathPrefix.length > 0) selectPath([])
  }, [current, pathPrefix.length, selectPath])

  if (store === null || typologies.length === 0 || current === -1) return null

  const node = tree.nodes[current] as PathNode
  const scoped = collectTypologies(tree, current)

  return (
    <>
      <Panel
        title="Path explorer"
        defaultOpen
        count={
          <>
            {pathPrefix.length > 0 && <em className="panel__badge">{pathPrefix.length}</em>}
            {node.size.toLocaleString()}
          </>
        }
      >
        {pathPrefix.length === 0 ? (
          <p className="paths__hint">
            Step through the cohort one state at a time, narrowing as you go.
          </p>
        ) : (
          <>
            <PathFlow
              tree={tree}
              pathPrefix={pathPrefix}
              palette={palette.css}
              stateNames={store.stateNames}
              onStep={selectPath}
            />
            <p className="paths__hint">
              {node.size.toLocaleString()} of {tree.total.toLocaleString()} ·{" "}
              {scoped.length.toLocaleString()} typolog{scoped.length === 1 ? "y" : "ies"}
            </p>
            <PathMinimap
              tree={tree}
              current={current}
              width={300}
              height={MAP_HEIGHT}
              palette={palette.css}
            />
          </>
        )}

        <div className="paths__actions">
          <button type="button" className="button" onClick={() => setIsOpen(true)}>
            Explore ⤢
          </button>
          <button
            type="button"
            className="button button--tiny"
            disabled={pathPrefix.length === 0}
            title="Back to the whole cohort"
            onClick={() => selectPath([])}
          >
            ↺
          </button>
        </div>
      </Panel>

      <Modal
        open={isOpen}
        title="Path explorer"
        onClose={() => setIsOpen(false)}
        toolbar={
          <span className="modal__note">
            {node.size.toLocaleString()} of {tree.total.toLocaleString()} patients ·{" "}
            {scoped.length.toLocaleString()} typologies
          </span>
        }
      >
        <PathBoard
          tree={tree}
          pathPrefix={pathPrefix}
          current={current}
          palette={palette}
          stateNames={store.stateNames}
          onStep={selectPath}
        />
      </Modal>
    </>
  )
}

interface BoardProps {
  readonly tree: PathTree
  readonly pathPrefix: readonly number[]
  readonly current: number
  readonly palette: Palette
  readonly stateNames: readonly string[]
  readonly onStep: (prefix: readonly number[]) => void
}

/**
 * The walk, laid out along its two real axes: one column per step taken, each
 * column holding that step's alternatives.
 *
 * Every level stays on screen, so what you *excluded* by stepping is as visible
 * as what you chose and going back is one click rather than a reset.
 */
function PathBoard({
  tree,
  pathPrefix,
  current,
  palette,
  stateNames,
  onStep,
}: BoardProps): React.JSX.Element {
  const [width, setWidth] = useState(900)
  const [host, setHost] = useState<HTMLDivElement | null>(null)

  useEffect(() => {
    if (host === null) return
    const observer = new ResizeObserver(([entry]) => {
      const next = entry?.contentRect.width
      if (next !== undefined) setWidth((value) => (value === next ? value : next))
    })
    observer.observe(host)
    return () => observer.disconnect()
  }, [host])

  const node = tree.nodes[current] as PathNode

  /** One column per step taken, plus the open step at the end. */
  const levels: { parent: PathNode; chosen: number }[] = []
  for (let depth = 0; depth <= pathPrefix.length; depth++) {
    const parent = tree.nodes[findPath(tree, pathPrefix.slice(0, depth))] as PathNode
    if (parent.children.length === 0) break
    levels.push({ parent, chosen: depth < pathPrefix.length ? (pathPrefix[depth] as number) : -1 })
  }

  const step = (depth: number, state: number): void => {
    // Clicking the state you are already on at this level steps back off it.
    onStep(
      pathPrefix[depth] === state
        ? pathPrefix.slice(0, depth)
        : [...pathPrefix.slice(0, depth), state],
    )
  }

  return (
    <div className="board" ref={setHost}>
      {/*
       * The columns show the *decisions*; this shows the *answer*. Reading a
       * chosen path off the board means picking one card out of each column
       * with the rejected options in between, which is exactly the wrong shape
       * for "what did I select".
       */}
      <div className="board__flow">
        <PathFlow
          tree={tree}
          pathPrefix={pathPrefix}
          palette={palette.css}
          stateNames={stateNames}
          onStep={onStep}
          showCounts
        />
      </div>

      <div className="board__columns">
        {levels.map(({ parent, chosen }, depth) => (
          <section className="board__column" key={parent.id}>
            <header className="board__column-head">
              <span>Step {depth + 1}</span>
              <span className="board__column-count">{parent.children.length} options</span>
            </header>

            <ul className="board__options">
              {parent.children.map((childId) => {
                const child = tree.nodes[childId] as PathNode
                const isChosen = child.state === chosen
                const share = parent.size === 0 ? 0 : (child.size / parent.size) * 100

                return (
                  <li key={childId}>
                    <button
                      type="button"
                      className="board__option"
                      data-chosen={isChosen}
                      data-dimmed={chosen !== -1 && !isChosen}
                      // Zero means the current filters left nobody on this
                      // branch. The step stays visible and clickable — "nobody
                      // here" is an answer, and a silently missing option would
                      // read as "nobody ever".
                      data-empty={child.size === 0}
                      aria-pressed={isChosen}
                      title={
                        isChosen ? "Step back off this state" : `${child.size} continue this way`
                      }
                      onClick={() => step(depth, child.state)}
                    >
                      <span
                        className="paths__swatch"
                        style={{ background: palette.css[child.state] }}
                        aria-hidden="true"
                      />
                      <span className="board__name">{stateNames[child.state]}</span>
                      <span className="board__count">
                        {child.size.toLocaleString()}
                        <em>{share.toFixed(0)}%</em>
                      </span>
                      {/* Some trajectories stop on this state rather than going on. */}
                      {child.ends > 0 && (
                        <span className="board__ends" title={`${child.ends} stop here`}>
                          ◍ {child.ends.toLocaleString()}
                        </span>
                      )}
                      <span
                        className="board__bar"
                        style={{ width: `${share}%` }}
                        aria-hidden="true"
                      />
                    </button>
                  </li>
                )
              })}
            </ul>
          </section>
        ))}

        {node.children.length === 0 && (
          <section className="board__column board__column--end">
            <header className="board__column-head">
              <span>End</span>
            </header>
            <p className="paths__hint paths__hint--end">
              {node.ends.toLocaleString()} trajectories finish here.
            </p>
          </section>
        )}
      </div>

      <footer className="board__map">
        <PathMinimap
          tree={tree}
          current={current}
          width={width}
          height={MAP_HEIGHT}
          palette={palette.css}
        />
      </footer>
    </div>
  )
}
