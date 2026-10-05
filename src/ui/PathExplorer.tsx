import { useEffect, useMemo, useState } from "react"

import { useEras } from "../app/store.ts"
import { buildPalette, type Palette } from "../core/render/palette.ts"
import {
  buildPathTree,
  collectTypologies,
  normalizeSteps,
  optionsAfter,
  toggleStep,
  walkSteps,
  type PathNode,
  type PathOption,
  type PathSteps,
  type PathTree,
} from "../core/stats/pathTree.ts"
import { filteredSizes } from "../core/stats/silhouettes.ts"
import { Modal } from "./Modal.tsx"
import { Panel } from "./Panel.tsx"
import { PathFlow } from "./PathFlow.tsx"
import { PathMinimap } from "./PathMinimap.tsx"

const MAP_HEIGHT = 150
const MAP_HEIGHT_EXPANDED = 300

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
 * people took it. Picking one narrows the chart to exactly those people, which
 * makes the "prediction" question fall out of the same control: if a step is not
 * offered, nobody in the cohort ever did it. A step takes any number of states —
 * click to add one, click again to drop it — so "started with a or b, then c" is
 * one selection rather than two walks. You can stop anywhere — a prefix is a
 * selection in its own right — or walk to the end of a path.
 *
 * It lives in a dialog rather than in the side column. A step is a *row* of
 * alternatives and a walk is a sequence of steps, so the thing wants two axes;
 * folded into a 300px column it could only stack, which turned the one reading
 * that matters — this branch against its siblings — into scrolling. The panel
 * keeps the part that is genuinely a summary: where you are, and how much of the
 * cohort is left.
 */
export function PathExplorer(): React.JSX.Element | null {
  const walk = usePathWalk()
  const [isOpen, setIsOpen] = useState(false)

  if (walk === null) return null

  const { tree, levels, frontier, size, scoped, palette, stateNames, steps, selectPath } = walk

  return (
    <>
      <Panel
        title="Path explorer"
        defaultOpen
        count={
          <>
            {steps.length > 0 && <em className="panel__badge">{steps.length}</em>}
            {size.toLocaleString()}
          </>
        }
      >
        {steps.length === 0 ? (
          <p className="paths__hint">
            Step through the cohort one state at a time, narrowing as you go.
          </p>
        ) : (
          <>
            <PathFlow
              tree={tree}
              steps={steps}
              levels={levels}
              palette={palette.css}
              stateNames={stateNames}
              onStep={selectPath}
            />
            <p className="paths__hint">
              {size.toLocaleString()} of {tree.total.toLocaleString()} ·{" "}
              {scoped.length.toLocaleString()} typolog{scoped.length === 1 ? "y" : "ies"}
            </p>
            <PathMinimap
              tree={tree}
              frontier={frontier}
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
            disabled={steps.length === 0}
            title="Back to the whole cohort"
            onClick={() => selectPath([])}
          >
            ↺
          </button>
        </div>
      </Panel>

      <PathDialog open={isOpen} onClose={() => setIsOpen(false)} walk={walk} />
    </>
  )
}

interface PathWalk {
  readonly tree: PathTree
  readonly steps: PathSteps
  /** `walkSteps(tree, steps)`: the nodes each step reaches, root first. */
  readonly levels: readonly (readonly number[])[]
  /** The last of `levels` — the nodes whose subtrees are selected. */
  readonly frontier: readonly number[]
  /** Patients under the frontier: the selection's size. */
  readonly size: number
  /** Keys of the typologies under the frontier — what the walk has selected so far. */
  readonly scoped: readonly string[]
  readonly palette: Palette
  readonly stateNames: readonly string[]
  readonly selectPath: (steps: PathSteps) => void
}

/**
 * The tree and where the walk stands in it, or `null` with nothing to walk.
 * Shared by the side panel and by the landing, which opens the dialog before
 * the side column exists.
 */
function usePathWalk(): PathWalk | null {
  const store = useEras((s) => s.store)
  const typologies = useEras((s) => s.typologies)
  const population = useEras((s) => s.population)
  const selectionVersion = useEras((s) => s.selectionVersion)
  const steps = useEras((s) => s.pathSteps)
  const selectPath = useEras((s) => s.selectPath)

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

  const normalized = normalizeSteps(tree, steps)
  const isStale = normalized !== steps

  // A selection can outlive the tree it was made in — a reshape rebuilds the
  // typologies under it. The store drops it on a splice; this catches the rest,
  // keeping whatever part of it still exists.
  useEffect(() => {
    if (isStale) selectPath(normalized)
  }, [isStale, normalized, selectPath])

  const levels = useMemo(() => walkSteps(tree, normalized), [tree, normalized])

  if (store === null || typologies.length === 0) return null

  const frontier = levels[levels.length - 1] as number[]
  let size = 0
  for (const id of frontier) size += (tree.nodes[id] as PathNode).size

  return {
    tree,
    steps: normalized,
    levels,
    frontier,
    size,
    // Frontier nodes sit at one depth, so their subtrees are disjoint.
    scoped: frontier.flatMap((id) => collectTypologies(tree, id)),
    palette,
    stateNames: store.stateNames,
    selectPath,
  }
}

interface DialogProps {
  readonly open: boolean
  readonly onClose: () => void
  /** Set by the landing, where closing is the way into the charts. */
  readonly closeLabel?: string
}

/**
 * The explorer at full size, on its own — for the landing, which opens it
 * before the side column (and so the panel) exists.
 */
export function PathExplorerDialog(props: DialogProps): React.JSX.Element | null {
  const walk = usePathWalk()
  return walk === null ? null : <PathDialog {...props} walk={walk} />
}

function PathDialog({
  open,
  onClose,
  closeLabel,
  walk,
}: DialogProps & { readonly walk: PathWalk }): React.JSX.Element {
  const { tree, size, scoped } = walk

  return (
    <Modal
      open={open}
      title="Path explorer"
      onClose={onClose}
      {...(closeLabel !== undefined && { closeLabel, closePrimary: true })}
      toolbar={
        <span className="modal__note">
          {size.toLocaleString()} of {tree.total.toLocaleString()} patients ·{" "}
          {scoped.length.toLocaleString()} typologies
        </span>
      }
    >
      <PathBoard walk={walk} />
    </Modal>
  )
}

/**
 * The walk, laid out along its two real axes: one column per step taken, each
 * column holding that step's alternatives.
 *
 * Every level stays on screen, so what you *excluded* by stepping is as visible
 * as what you chose and going back is one click rather than a reset. A column
 * offers whatever follows *any* state picked in the one before it, summed over
 * them — so its counts are the people that column could still keep.
 */
function PathBoard({ walk }: { readonly walk: PathWalk }): React.JSX.Element {
  const { tree, steps, levels, frontier, palette, stateNames, selectPath } = walk

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

  /** One column per step taken, plus the open step at the end. */
  const columns: { options: PathOption[]; total: number; chosen: readonly number[] }[] = []
  for (let depth = 0; depth <= steps.length; depth++) {
    const parents = levels[depth] as readonly number[]
    const options = optionsAfter(tree, parents)
    if (options.length === 0) break
    let total = 0
    for (const id of parents) total += (tree.nodes[id] as PathNode).size
    columns.push({ options, total, chosen: steps[depth] ?? [] })
  }

  // The frontier has nowhere left to go: everyone still selected stops here.
  const isEnd = columns.length === steps.length
  let endCount = 0
  if (isEnd) for (const id of frontier) endCount += (tree.nodes[id] as PathNode).ends

  // Adding or dropping a state can strand a later pick — it only ever followed
  // what was just dropped — so the result is checked against the tree.
  const step = (depth: number, state: number): void =>
    selectPath(normalizeSteps(tree, toggleStep(steps, depth, state)))

  return (
    <div className="board" ref={setHost}>
      {/*
       * The columns show the *decisions*; this shows the *answer*. Reading a
       * chosen path off the board means picking the cards out of each column
       * with the rejected options in between, which is exactly the wrong shape
       * for "what did I select".
       */}
      <div className="board__flow">
        <PathFlow
          tree={tree}
          steps={steps}
          levels={levels}
          palette={palette.css}
          stateNames={stateNames}
          onStep={selectPath}
          showCounts
        />
      </div>

      <div className="board__columns">
        {columns.map(({ options, total, chosen }, depth) => (
          <section className="board__column" key={depth}>
            <header className="board__column-head">
              <span>Step {depth + 1}</span>
              <span className="board__column-count">
                {chosen.length > 0 && `${chosen.length} of `}
                {options.length} options
              </span>
            </header>

            <ul className="board__options">
              {options.map((option) => {
                const isChosen = chosen.includes(option.state)
                const share = total === 0 ? 0 : (option.size / total) * 100

                return (
                  <li key={option.state}>
                    <button
                      type="button"
                      className="board__option"
                      data-chosen={isChosen}
                      data-dimmed={chosen.length > 0 && !isChosen}
                      // Zero means the current filters left nobody on this
                      // branch. The step stays visible and clickable — "nobody
                      // here" is an answer, and a silently missing option would
                      // read as "nobody ever".
                      data-empty={option.size === 0}
                      aria-pressed={isChosen}
                      title={
                        isChosen
                          ? "Drop this state from the step"
                          : `Add this state · ${option.size} continue this way`
                      }
                      onClick={() => step(depth, option.state)}
                    >
                      <span
                        className="paths__swatch"
                        style={{ background: palette.css[option.state] }}
                        aria-hidden="true"
                      />
                      <span className="board__name">{stateNames[option.state]}</span>
                      <span className="board__count">
                        {option.size.toLocaleString()}
                        <em>{share.toFixed(0)}%</em>
                      </span>
                      {/* Some trajectories stop on this state rather than going on. */}
                      {option.ends > 0 && (
                        <span className="board__ends" title={`${option.ends} stop here`}>
                          ◍ {option.ends.toLocaleString()}
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

        {isEnd && (
          <section className="board__column board__column--end">
            <header className="board__column-head">
              <span>End</span>
            </header>
            <p className="paths__hint paths__hint--end">
              {endCount.toLocaleString()} trajectories finish here.
            </p>
          </section>
        )}
      </div>

      <footer className="board__map">
        <PathMinimap
          tree={tree}
          frontier={frontier}
          width={width}
          height={MAP_HEIGHT_EXPANDED}
          palette={palette.css}
        />
      </footer>
    </div>
  )
}
