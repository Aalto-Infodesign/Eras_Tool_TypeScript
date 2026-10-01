/**
 * Undo and redo for the typology selection.
 *
 * The Sankey's shape comes from the selection, so every "Show only these" and
 * "Open in Trajectories" narrows the very chart it was clicked in — and without
 * a way back, drilling down would erase the overview that prompted it. The
 * original had a history for its id selection, but it lived in the chart
 * component (lost on every view switch), never saw changes made elsewhere (so
 * the next union brought cleared ids back), and pushed an entry even when
 * nothing had changed. This one is store-level, sees every selection-changing
 * action, and skips no-ops.
 *
 * Pure and immutable: the store keeps a `SelectionHistory` and swaps it.
 */

/** Everything a selection-changing action writes, and so everything undo restores. */
export interface SelectionSnapshot {
  readonly selectedTypologies: readonly string[]
  readonly pathPrefix: readonly number[]
  readonly selectedClusters: readonly number[]
}

export interface SelectionHistory {
  /** Oldest first; the last entry is what undo restores. */
  readonly past: readonly SelectionSnapshot[]
  /** Nearest first; the first entry is what redo restores. */
  readonly future: readonly SelectionSnapshot[]
}

export const emptyHistory: SelectionHistory = { past: [], future: [] }

/**
 * Steps kept. Snapshots share their arrays with the store rather than copying
 * them, so even a path selection naming thousands of typologies costs a
 * reference per entry.
 */
export const HISTORY_LIMIT = 50

/** Just the three fields — pass the store's state straight in. */
export function snapshotOf(state: SelectionSnapshot): SelectionSnapshot {
  return {
    selectedTypologies: state.selectedTypologies,
    pathPrefix: state.pathPrefix,
    selectedClusters: state.selectedClusters,
  }
}

const sameSet = <T>(a: readonly T[], b: readonly T[]): boolean => {
  if (a === b) return true
  if (a.length !== b.length) return false
  const set = new Set(a)
  return b.every((value) => set.has(value))
}

const sameSequence = <T>(a: readonly T[], b: readonly T[]): boolean =>
  a === b || (a.length === b.length && a.every((value, i) => value === b[i]))

/**
 * Whether two snapshots select the same thing. Typologies and clusters compare
 * as sets — the order they were picked in is invisible — and the path prefix as
 * a sequence, because it is one.
 */
export function sameSnapshot(a: SelectionSnapshot, b: SelectionSnapshot): boolean {
  return (
    sameSet(a.selectedTypologies, b.selectedTypologies) &&
    sameSequence(a.pathPrefix, b.pathPrefix) &&
    sameSet(a.selectedClusters, b.selectedClusters)
  )
}

/**
 * Records that the selection went from `previous` to `next`.
 *
 * Returns `history` itself when nothing changed, so a caller can skip the
 * write; otherwise pushes `previous`, drops the oldest entry past
 * `HISTORY_LIMIT`, and clears the redo stack, since a new branch abandons it.
 */
export function pushHistory(
  history: SelectionHistory,
  previous: SelectionSnapshot,
  next: SelectionSnapshot,
): SelectionHistory {
  if (sameSnapshot(previous, next)) return history
  const past = [...history.past, snapshotOf(previous)]
  return { past: past.length > HISTORY_LIMIT ? past.slice(-HISTORY_LIMIT) : past, future: [] }
}

/** The snapshot to restore, and the history to keep; `null` when there is none. */
export interface HistoryStep {
  readonly history: SelectionHistory
  readonly snapshot: SelectionSnapshot
}

/** Steps back from `current`, which becomes the first thing redo restores. */
export function undo(history: SelectionHistory, current: SelectionSnapshot): HistoryStep | null {
  const snapshot = history.past[history.past.length - 1]
  if (snapshot === undefined) return null
  return {
    snapshot,
    history: { past: history.past.slice(0, -1), future: [snapshotOf(current), ...history.future] },
  }
}

/** Steps forward from `current`, which goes back on the undo stack. */
export function redo(history: SelectionHistory, current: SelectionSnapshot): HistoryStep | null {
  const snapshot = history.future[0]
  if (snapshot === undefined) return null
  const past = [...history.past, snapshotOf(current)]
  return {
    snapshot,
    history: {
      past: past.length > HISTORY_LIMIT ? past.slice(-HISTORY_LIMIT) : past,
      future: history.future.slice(1),
    },
  }
}
