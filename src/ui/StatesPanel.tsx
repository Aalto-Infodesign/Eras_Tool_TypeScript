import { useMemo, useState } from "react"

import { useEras } from "../app/store.ts"
import { buildPalette } from "../core/render/palette.ts"
import { Panel } from "./Panel.tsx"

/**
 * The state list: reorder the chart's rows, take states out, put them back.
 *
 * Ported from the original's `StateSelection`, minus the flowchart it also fed —
 * a top list of the states in play, draggable to reorder, each with a control to
 * remove it, and a bottom list of what has been removed with a control to
 * restore it.
 *
 * Two things differ from the original, both deliberate.
 *
 * Reordering is HTML5 drag-and-drop plus a pair of arrows rather than a motion
 * `Reorder.Group`: it needs no animation library, and the arrows make the list
 * reachable from the keyboard, which a drag handle alone never is.
 *
 * And removing a state no longer discards a manual ordering. The original
 * recomputed `statesOrder` as `difference(statesNames, removedStates)` whenever
 * removals changed, which silently reset any reordering the user had done; here
 * the order holds every state and the removed ones are filtered out of the rows,
 * so a state comes back exactly where it was.
 *
 * Self-contained — it reads the store directly and takes no props, so the same
 * component drops into the side column later without changes.
 */
export function StatesPanel(): React.JSX.Element | null {
  const store = useEras((s) => s.store)
  const stateOrder = useEras((s) => s.stateOrder)
  const removedStates = useEras((s) => s.filters.removedStates)
  const baseStateOrder = useEras((s) => s.baseStateOrder)
  const states = useEras((s) => s.states)

  const setStateOrder = useEras((s) => s.setStateOrder)
  const moveState = useEras((s) => s.moveState)
  const toggleRemovedState = useEras((s) => s.toggleRemovedState)
  const resetStates = useEras((s) => s.resetStates)

  const [dragging, setDragging] = useState<number | null>(null)
  const [dragOver, setDragOver] = useState<number | null>(null)

  const palette = useMemo(
    () => buildPalette(store?.stateNames.length ?? 0),
    [store?.stateNames.length],
  )

  const populationOf = useMemo(() => {
    const sizes = new Map(states.map((state) => [state.id, state.population]))
    return (state: number): number => sizes.get(state) ?? 0
  }, [states])

  if (store === null || stateOrder.length === 0) return null

  const removed = new Set(removedStates)
  const kept = stateOrder.filter((state) => !removed.has(state))
  // Shown in the order the list holds them, not in the order they were removed.
  const dropped = stateOrder.filter((state) => removed.has(state))

  const isModified =
    removedStates.length > 0 ||
    stateOrder.length !== baseStateOrder.length ||
    stateOrder.some((state, index) => baseStateOrder[index] !== state)

  /**
   * Moves the dragged state to the drop target's place.
   *
   * Dragging downward lands *after* the target, upward lands *before* it — drop
   * always before, and the last position becomes unreachable by drag.
   */
  const drop = (target: number): void => {
    if (dragging === null || dragging === target) return

    const movingDown = stateOrder.indexOf(dragging) < stateOrder.indexOf(target)
    const next = stateOrder.filter((state) => state !== dragging)
    const at = next.indexOf(target)

    next.splice(at === -1 ? next.length : at + (movingDown ? 1 : 0), 0, dragging)

    setStateOrder(next)
    setDragging(null)
    setDragOver(null)
  }

  return (
    <Panel
      title="States"
      defaultOpen
      className="panel--states"
      count={
        <>
          {kept.length}
          {removedStates.length > 0 && <em> / {stateOrder.length}</em>}
        </>
      }
    >

      <p className="states__hint">Drag to reorder the chart's rows.</p>

      <ul className="states">
        {kept.map((state, row) => (
          <li
            key={state}
            className="state"
            draggable
            data-dragging={dragging === state}
            data-dragover={dragOver === state}
            onDragStart={() => setDragging(state)}
            onDragEnd={() => {
              setDragging(null)
              setDragOver(null)
            }}
            onDragOver={(event) => {
              event.preventDefault() // required for the element to be a drop target
              if (dragOver !== state) setDragOver(state)
            }}
            onDragLeave={() => setDragOver((current) => (current === state ? null : current))}
            onDrop={(event) => {
              event.preventDefault()
              drop(state)
            }}
          >
            <span className="state__grip" aria-hidden="true">
              ⠿
            </span>
            <span className="state__row">{row}</span>
            <span className="state__name" style={{ color: palette.css[state] }} title={store.stateNames[state]}>
              {store.stateNames[state]}
            </span>
            <span className="state__population">{populationOf(state).toLocaleString()}</span>

            <span className="state__controls">
              <button
                type="button"
                className="button button--tiny"
                title="Move up"
                disabled={row === 0}
                onClick={() => moveState(state, -1)}
              >
                ↑
              </button>
              <button
                type="button"
                className="button button--tiny"
                title="Move down"
                disabled={row === kept.length - 1}
                onClick={() => moveState(state, 1)}
              >
                ↓
              </button>
              <button
                type="button"
                className="button button--tiny"
                title="Remove this state from every trajectory"
                // The original guards the same way: the chart needs a row.
                disabled={kept.length <= 1}
                onClick={() => toggleRemovedState(state)}
              >
                ✕
              </button>
            </span>
          </li>
        ))}
      </ul>

      {dropped.length > 0 && (
        <>
          <p className="states__hint states__hint--removed">
            Spliced out; trajectories link across them.
          </p>
          <ul className="states states--removed">
            {dropped.map((state) => (
              <li key={state} className="state state--removed">
                <span className="state__name" title={store.stateNames[state]}>
                  {store.stateNames[state]}
                </span>
                <span className="state__population">{populationOf(state).toLocaleString()}</span>
                <span className="state__controls">
                  <button
                    type="button"
                    className="button button--tiny"
                    title="Put this state back"
                    onClick={() => toggleRemovedState(state)}
                  >
                    +
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </>
      )}

      <button type="button" className="button" disabled={!isModified} onClick={resetStates}>
        Reset states
      </button>
    </Panel>
  )
}
