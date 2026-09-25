import type { Typology } from "../types.ts"

/**
 * The typologies as a prefix tree — the structure behind the path explorer.
 *
 * A typology is an ordered state sequence, so the set of them is a tree the
 * moment you read it left to right: every distinct prefix is a node, and its
 * children are the states that were observed *next*. Walking down it answers
 * "who started here, and where did they go?" one step at a time, which is the
 * question the original's Hasse diagram answered all at once and at the cost of
 * a poset over every pair of silhouettes, computed in its own worker.
 *
 * This needs no worker. Building it is one pass over the typology list — whose
 * total length is the sum of the sequence lengths, a few thousand entries even
 * on the 250k dataset — because the typologies are *already* the deduplicated
 * sequences with their patient counts attached.
 *
 * What it is not: a partial order. The original's poset related silhouettes by
 * subsequence containment, so `a-c` sat under `a-b-c`. Here `a-c` and `a-b-c`
 * are different branches from `a`. That is the right structure for stepping
 * forward through a trajectory, and the wrong one for asking what contains what.
 */

export interface PathNode {
  readonly id: number
  /** State id this node was reached by; `-1` at the root, which stands for nobody. */
  readonly state: number
  readonly depth: number
  readonly parent: number
  /** Patients whose trajectory *starts with* this path. */
  readonly size: number
  /** Patients whose trajectory *is* this path — they stop here. */
  readonly ends: number
  /**
   * The typology that ends exactly here, if any.
   *
   * At most one, because typologies are distinct sequences: the tree is a
   * bijection between its nodes-with-a-terminal and the typology list.
   */
  readonly terminal: string | null
  /** Node ids, biggest subtree first. */
  readonly children: readonly number[]
}

export interface PathTree {
  /** `nodes[0]` is the root. Ids index this array. */
  readonly nodes: readonly PathNode[]
  /** Patients in the tree at all — the denominator for a node's share. */
  readonly total: number
}

interface MutableNode {
  id: number
  state: number
  depth: number
  parent: number
  size: number
  ends: number
  terminal: string | null
  children: number[]
}

/**
 * `sizeOf` overrides a typology's patient count by index — pass the live counts
 * to make the tree describe the filtered cohort rather than the whole dataset.
 * Branches that lose every patient stay in the tree at size 0, so the explorer
 * can show them struck out rather than silently dropping a path that exists.
 */
export function buildPathTree(
  typologies: readonly Typology[],
  sizeOf?: (index: number) => number,
): PathTree {
  const nodes: MutableNode[] = [
    { id: 0, state: -1, depth: 0, parent: -1, size: 0, ends: 0, terminal: null, children: [] },
  ]
  // One state→child map per node. A Map rather than a scan of `children`
  // because a state vocabulary can be large and this is the inner loop.
  const index: Map<number, number>[] = [new Map()]

  for (let t = 0; t < typologies.length; t++) {
    const typology = typologies[t] as Typology
    const size = sizeOf === undefined ? typology.size : sizeOf(t)

    let current = 0
    ;(nodes[0] as MutableNode).size += size

    for (let i = 0; i < typology.states.length; i++) {
      const state = typology.states[i] as number
      const parent = nodes[current] as MutableNode
      const map = index[current] as Map<number, number>

      let next = map.get(state)
      if (next === undefined) {
        next = nodes.length
        nodes.push({
          id: next,
          state,
          depth: parent.depth + 1,
          parent: current,
          size: 0,
          ends: 0,
          terminal: null,
          children: [],
        })
        index.push(new Map())
        parent.children.push(next)
        map.set(state, next)
      }

      ;(nodes[next] as MutableNode).size += size
      current = next
    }

    const leaf = nodes[current] as MutableNode
    leaf.terminal = typology.key
    leaf.ends += size
  }

  // Biggest branch first, so the explorer offers the likely step at the top.
  // Ties break on state id, which keeps the layout stable across rebuilds.
  for (const node of nodes) {
    node.children.sort((a, b) => {
      const left = nodes[a] as MutableNode
      const right = nodes[b] as MutableNode
      return right.size - left.size || left.state - right.state
    })
  }

  return { nodes, total: (nodes[0] as MutableNode).size }
}

/** Follows a path of state ids from the root. `-1` when it does not exist. */
export function findPath(tree: PathTree, path: readonly number[]): number {
  let current = 0
  for (const state of path) {
    const node = tree.nodes[current]
    if (node === undefined) return -1

    let next = -1
    for (const child of node.children) {
      if ((tree.nodes[child] as PathNode).state === state) {
        next = child
        break
      }
    }
    if (next === -1) return -1
    current = next
  }
  return current
}

/** The state ids from the root down to `id`, root excluded. */
export function pathOf(tree: PathTree, id: number): number[] {
  const out: number[] = []
  let current = id
  while (current > 0) {
    const node = tree.nodes[current]
    if (node === undefined) break
    out.push(node.state)
    current = node.parent
  }
  return out.reverse()
}

/** Every typology key in a node's subtree — what selecting that node scopes to. */
export function collectTypologies(tree: PathTree, id: number): string[] {
  const out: string[] = []
  const stack = [id]

  while (stack.length > 0) {
    const node = tree.nodes[stack.pop() as number]
    if (node === undefined) continue
    if (node.terminal !== null) out.push(node.terminal)
    for (const child of node.children) stack.push(child)
  }

  return out
}

/** Does this sequence begin with `path`? The store's side of a path selection. */
export function startsWithPath(states: Uint16Array, path: readonly number[]): boolean {
  if (path.length > states.length) return false
  for (let i = 0; i < path.length; i++) {
    if (states[i] !== path[i]) return false
  }
  return true
}
