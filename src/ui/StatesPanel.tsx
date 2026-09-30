import { useMemo } from "react"

import { useEras } from "../app/store.ts"
import { buildPalette } from "../core/render/palette.ts"
import { ClusterStaleNotice } from "./ClusterStale.tsx"
import { Panel } from "./Panel.tsx"

/**
 * The state list: reorder the chart's rows, take states out, put them back.
 *
 * Ported from the original's `StateSelection`, minus the flowchart it also fed —
 * a top list of the states in play, draggable to reorder, each with a control to
 * remove it, and a bottom list of what has been removed with a control to
 * restore it.
 *
 * Reordering used to live here, and no longer does. It existed to make one
 * sequence read as a staircase in the shared frame, and the chart answers that
 * directly now: select a typology and it is drawn along *its own steps*. A
 * global order bent toward one sequence was always a compromise for the others,
 * and it could not express a repeated state at all.
 *
 * What is left is membership: take a state out of the dataset, or put it back.
 * The order is the ingest's, and removing a state no longer disturbs it — the
 * original recomputed `statesOrder` as `difference(statesNames, removedStates)`
 * whenever removals changed, so a state came back at the end rather than where
 * it was.
 *
 * Self-contained — it reads the store directly and takes no props, so the same
 * component drops into the side column later without changes.
 */
export function StatesPanel(): React.JSX.Element | null {
  const store = useEras((s) => s.store)
  const stateOrder = useEras((s) => s.stateOrder)
  const removedStates = useEras((s) => s.filters.removedStates)
  const states = useEras((s) => s.states)

  const toggleRemovedState = useEras((s) => s.toggleRemovedState)
  const resetStates = useEras((s) => s.resetStates)

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

  const isModified = removedStates.length > 0

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
      <p className="states__hint">
        Rows of the shared view. Remove one to splice it out of every trajectory.
      </p>

      <ClusterStaleNotice />

      <ul className="states">
        {kept.map((state, row) => (
          <li key={state} className="state">
            <span className="state__row">{row}</span>
            <span className="state__row"> · </span>
            <span
              className="state__name"
              style={{ color: palette.css[state] }}
              title={store.stateNames[state]}
            >
              {store.stateNames[state]}
            </span>
            <span className="state__population">{populationOf(state).toLocaleString()}</span>

            <span className="state__controls">
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
