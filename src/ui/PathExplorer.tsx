import { useEffect, useMemo, useState } from "react"

import { useEras } from "../app/store.ts"
import { buildPalette, type Palette } from "../core/render/palette.ts"
import {
  buildPathTree,
  collectTypologies,
  effectiveSteps,
  normalizeSteps,
  toggleStep,
  walkSteps,
  type Expectation,
  type PathNode,
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
 * offered, nobody in the cohort ever did it. You can stop anywhere — a prefix is
 * a selection in its own right — or walk to the end of a path.
 *
 * One state per step. A second route is a second walk: save the first as an
 * *expectation* and start again. Expectations switch on and off, and the ones on
 * merge with the walk into one selection — so "a then b, or c then d" is two
 * saved walks rather than a grid of picks whose later steps every branch shares.
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
  const hasSelection = steps.length > 0 || walk.expectations.some((row) => row.active)

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
        {steps.length > 0 && (
          <PathFlow
            tree={tree}
            steps={steps}
            levels={levels}
            palette={palette.css}
            stateNames={stateNames}
            onStep={selectPath}
          />
        )}
        <SaveExpectation walk={walk} />
        <ExpectationList walk={walk} />

        {!hasSelection ? (
          <p className="paths__hint">
            Step through the cohort one state at a time, narrowing as you go.
          </p>
        ) : (
          <>
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
            disabled={!hasSelection}
            title="Back to the whole cohort — clears the walk and switches every expectation off"
            onClick={walk.clear}
          >
            ↺
          </button>
        </div>
      </Panel>

      <PathDialog open={isOpen} onClose={() => setIsOpen(false)} walk={walk} />
    </>
  )
}

/** A saved expectation as the current tree reads it. */
interface ExpectationRow {
  readonly expectation: Expectation
  /** Its steps with removed states cut out — what it selects now. */
  readonly steps: PathSteps
  /** The node it ends on, or `null` when the tree no longer has the path. */
  readonly node: number | null
  readonly active: boolean
}

interface PathWalk {
  readonly tree: PathTree
  readonly steps: PathSteps
  /** `walkSteps(tree, steps)`: the node each step reaches, root first. */
  readonly levels: readonly number[]
  /**
   * The nodes whose subtrees are selected: where the walk stands, and where
   * every expectation switched on ends. Nested ones are dropped, so the
   * subtrees are disjoint and their sizes add up.
   */
  readonly frontier: readonly number[]
  /** Patients under the frontier: the selection's size. */
  readonly size: number
  /** Keys of the typologies under the frontier — what the path selection picks. */
  readonly scoped: readonly string[]
  readonly expectations: readonly ExpectationRow[]
  readonly palette: Palette
  readonly stateNames: readonly string[]
  readonly selectPath: (steps: PathSteps) => void
  /** Back to the whole cohort: no walk, nothing switched on. */
  readonly clear: () => void
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
  const clear = useEras((s) => s.clearTypologies)
  const expectations = useEras((s) => s.expectations)
  const activeExpectations = useEras((s) => s.activeExpectations)
  const removedStates = useEras((s) => s.filters.removedStates)

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

  const rows = useMemo(() => {
    const removed = new Set(removedStates)
    return expectations.map((expectation): ExpectationRow => {
      const steps = effectiveSteps(expectation.steps, removed)
      const nodes = walkSteps(tree, steps)
      return {
        expectation,
        steps,
        node:
          steps.length > 0 && nodes.length === steps.length + 1 ? (nodes.at(-1) as number) : null,
        active: activeExpectations.includes(expectation.id),
      }
    })
  }, [tree, expectations, activeExpectations, removedStates])

  const frontier = useMemo(() => {
    const ends = rows.flatMap((row) => (row.active && row.node !== null ? [row.node] : []))
    // The walk counts once it has a step, or alone — the root — when nothing else does.
    if (normalized.length > 0 || ends.length === 0) ends.push(levels.at(-1) as number)
    return outermost(tree, ends)
  }, [tree, rows, normalized, levels])

  if (store === null || typologies.length === 0) return null

  let size = 0
  for (const id of frontier) size += (tree.nodes[id] as PathNode).size

  return {
    tree,
    steps: normalized,
    levels,
    frontier,
    size,
    scoped: frontier.flatMap((id) => collectTypologies(tree, id)),
    expectations: rows,
    palette,
    stateNames: store.stateNames,
    selectPath,
    clear,
  }
}

/**
 * `ids` without duplicates and without any node under another of them — the
 * nodes whose subtrees, taken together, cover the rest. `a` and `a → b` both
 * switched on select `a`'s subtree once, not `a → b` twice.
 */
function outermost(tree: PathTree, ids: readonly number[]): number[] {
  const set = new Set(ids)
  return [...set].filter((id) => {
    for (
      let up = (tree.nodes[id] as PathNode).parent;
      up >= 0;
      up = (tree.nodes[up] as PathNode).parent
    ) {
      if (set.has(up)) return false
    }
    return true
  })
}

/** Keeps the walk as an expectation — the way to a second route. */
function SaveExpectation({ walk }: { readonly walk: PathWalk }): React.JSX.Element | null {
  const save = useEras((s) => s.saveExpectation)
  if (walk.steps.length === 0) return null

  return (
    <button
      type="button"
      className="button button--tiny paths__save"
      title="Keep this path, switched on, and start a new walk — expectations switched on merge into one selection"
      onClick={save}
    >
      ＋ Save as expectation
    </button>
  )
}

/**
 * How much of the cohort the selection covers, as one stacked bar — the
 * original's selection pie, brought to the path explorer and stood upright
 * along the selection's right edge, so it reads as a gauge beside the walk and
 * the expectations it measures rather than one more row under them. It fills
 * from the bottom.
 *
 * One segment per route: the walk in progress and each expectation switched on,
 * as far as `frontier` keeps them apart (a route inside another is counted in
 * the outer one). So the bar answers both "how much do my expectations cover"
 * and "how much of that is each of them", the second on hover.
 *
 * The denominator is the tree's: the cohort as the filters leave it, which is
 * the whole dataset until a filter is set — and the caption says when it is not.
 */
function Coverage({ walk }: { readonly walk: PathWalk }): React.JSX.Element {
  const cohortSize = useEras((s) => s.cohortSize)
  const { tree, frontier, size, steps, levels, expectations, stateNames } = walk
  const total = tree.total
  const share = total === 0 ? 0 : (size / total) * 100
  const isEverything = frontier.length === 1 && frontier[0] === 0

  const names = new Map<number, string>()
  if (steps.length > 0) names.set(levels.at(-1) as number, "Current walk")
  for (const row of expectations) {
    if (row.active && row.node !== null && !names.has(row.node))
      names.set(row.node, row.expectation.name)
  }

  // Biggest first from the bottom, so the segments read as a sorted breakdown.
  const segments = frontier
    .map((id) => {
      const node = tree.nodes[id] as PathNode
      return {
        id,
        size: node.size,
        label: names.get(id) ?? stateNames[node.state] ?? "Whole cohort",
      }
    })
    .sort((a, b) => b.size - a.size)

  return (
    <div className="coverage">
      <span className="coverage__share">{formatShare(share)}</span>
      <div
        className="coverage__bar"
        role="img"
        aria-label={`${formatShare(share)} of ${total.toLocaleString()} patients`}
      >
        {total > 0 &&
          segments.map((segment) => (
            <span
              key={segment.id}
              className="coverage__segment"
              style={{ height: `${(segment.size / total) * 100}%` }}
              title={`${segment.label} · ${segment.size.toLocaleString()} patients (${formatShare((segment.size / total) * 100)})`}
            />
          ))}
      </div>
      <span className="coverage__caption">
        {isEverything ? (
          <b>
            Whole <br /> cohort
          </b>
        ) : (
          <b>
            {size.toLocaleString()} / {total.toLocaleString()}
          </b>
        )}
        {total < cohortSize && (
          <span className="coverage__note">
            filters keep {total.toLocaleString()} of {cohortSize.toLocaleString()}
          </span>
        )}
      </span>
    </div>
  )
}

/** A share to one decimal; a sliver keeps enough digits not to read as zero. */
const formatShare = (percent: number): string =>
  `${percent.toFixed(percent > 0 && percent < 1 ? 2 : percent === 100 ? 0 : 1)}%`

/**
 * The saved walks: a switch to merge each into the selection, its path as
 * dots, a name to edit, how many it picks, and a way to drop it.
 */
function ExpectationList({ walk }: { readonly walk: PathWalk }): React.JSX.Element | null {
  const toggle = useEras((s) => s.toggleExpectation)
  const rename = useEras((s) => s.renameExpectation)
  const remove = useEras((s) => s.removeExpectation)
  const { tree, expectations, palette, stateNames } = walk

  if (expectations.length === 0) return null

  return (
    <ul className="expectations" aria-label="Expectations">
      {expectations.map(({ expectation, steps, node, active }) => {
        const route = steps.map((state) => stateNames[state]).join(" → ")
        const size = node === null ? 0 : (tree.nodes[node] as PathNode).size

        return (
          <li key={expectation.id} className="expectation" data-active={active}>
            <input
              type="checkbox"
              className="expectation__toggle"
              checked={active}
              aria-label={`Merge ${expectation.name} into the selection`}
              onChange={() => toggle(expectation.id)}
            />
            <span className="expectation__route" title={route}>
              {steps.map((state, i) => (
                <span
                  key={i}
                  className="flow__dot"
                  style={{ background: palette.css[state] }}
                  aria-hidden="true"
                />
              ))}
            </span>
            <input
              type="text"
              className="expectation__name"
              value={expectation.name}
              aria-label="Expectation name"
              title={route}
              onChange={(event) => rename(expectation.id, event.target.value)}
            />
            <span
              className="expectation__count"
              title={
                node === null
                  ? "Nobody takes this path any more"
                  : `${size} patients start this way`
              }
            >
              {size.toLocaleString()}
            </span>
            <button
              type="button"
              className="expectation__remove"
              aria-label={`Delete ${expectation.name}`}
              title="Delete this expectation"
              onClick={() => remove(expectation.id)}
            >
              ×
            </button>
          </li>
        )
      })}
    </ul>
  )
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
          {scoped.length.toLocaleString()} typolog{scoped.length === 1 ? "y" : "ies"}
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
 * offers whatever follows the state picked in the one before it — so its counts
 * are the people that column could still keep.
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
  const columns: { options: PathNode[]; total: number; chosen: number | undefined }[] = []
  for (let depth = 0; depth <= steps.length; depth++) {
    const parent = tree.nodes[levels[depth] ?? -1]
    if (parent === undefined || parent.children.length === 0) break
    columns.push({
      options: parent.children.map((id) => tree.nodes[id] as PathNode),
      total: parent.size,
      chosen: steps[depth],
    })
  }

  // The walk has nowhere left to go: everyone on it stops here.
  const isEnd = steps.length > 0 && columns.length === steps.length
  const endCount = isEnd ? (tree.nodes[levels.at(-1) as number] as PathNode).ends : 0

  // Changing a step can strand a later one — it only ever followed the state
  // just replaced — so the result is checked against the tree.
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
        <div className="board__selection">
          <Coverage walk={walk} />
          <div className="board__chosen">
            <div className="board__walk">
              <PathFlow
                tree={tree}
                steps={steps}
                levels={levels}
                palette={palette.css}
                stateNames={stateNames}
                onStep={selectPath}
                showCounts
              />
              <SaveExpectation walk={walk} />
            </div>
            {/* <ExpectationList walk={walk} /> */}
          </div>
          {/* Down the right edge, as tall as the walk and the expectations it measures. */}
        </div>
      </div>

      <div className="board__columns">
        {columns.map(({ options, total, chosen }, depth) => (
          <section className="board__column" key={depth}>
            <header className="board__column-head">
              <span>Step {depth + 1}</span>
              <span className="board__column-count">{options.length} options</span>
            </header>

            <ul className="board__options">
              {options.map((option) => {
                const isChosen = chosen === option.state
                const share = total === 0 ? 0 : (option.size / total) * 100

                return (
                  <li key={option.state}>
                    <button
                      type="button"
                      className="board__option"
                      data-chosen={isChosen}
                      data-dimmed={chosen !== undefined && !isChosen}
                      // Zero means the current filters left nobody on this
                      // branch. The step stays visible and clickable — "nobody
                      // here" is an answer, and a silently missing option would
                      // read as "nobody ever".
                      data-empty={option.size === 0}
                      aria-pressed={isChosen}
                      title={
                        isChosen
                          ? "Step back to before this state"
                          : `Take this step · ${option.size} continue this way`
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
          width={width - 310}
          height={MAP_HEIGHT_EXPANDED}
          palette={palette.css}
        />
        <ExpectationList walk={walk} />
      </footer>
    </div>
  )
}
