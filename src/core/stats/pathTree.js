/**
 * `sizeOf` overrides a typology's patient count by index — pass the live counts
 * to make the tree describe the filtered cohort rather than the whole dataset.
 * Branches that lose every patient stay in the tree at size 0, so the explorer
 * can show them struck out rather than silently dropping a path that exists.
 */
export function buildPathTree(typologies, sizeOf) {
    const nodes = [
        { id: 0, state: -1, depth: 0, parent: -1, size: 0, ends: 0, terminal: null, children: [] },
    ];
    // One state→child map per node. A Map rather than a scan of `children`
    // because a state vocabulary can be large and this is the inner loop.
    const index = [new Map()];
    for (let t = 0; t < typologies.length; t++) {
        const typology = typologies[t];
        const size = sizeOf === undefined ? typology.size : sizeOf(t);
        let current = 0;
        nodes[0].size += size;
        for (let i = 0; i < typology.states.length; i++) {
            const state = typology.states[i];
            const parent = nodes[current];
            const map = index[current];
            let next = map.get(state);
            if (next === undefined) {
                next = nodes.length;
                nodes.push({
                    id: next,
                    state,
                    depth: parent.depth + 1,
                    parent: current,
                    size: 0,
                    ends: 0,
                    terminal: null,
                    children: [],
                });
                index.push(new Map());
                parent.children.push(next);
                map.set(state, next);
            }
            ;
            nodes[next].size += size;
            current = next;
        }
        const leaf = nodes[current];
        leaf.terminal = typology.key;
        leaf.ends += size;
    }
    // Biggest branch first, so the explorer offers the likely step at the top.
    // Ties break on state id, which keeps the layout stable across rebuilds.
    for (const node of nodes) {
        node.children.sort((a, b) => {
            const left = nodes[a];
            const right = nodes[b];
            return right.size - left.size || left.state - right.state;
        });
    }
    return { nodes, total: nodes[0].size };
}
/** Follows a path of state ids from the root. `-1` when it does not exist. */
export function findPath(tree, path) {
    let current = 0;
    for (const state of path) {
        const node = tree.nodes[current];
        if (node === undefined)
            return -1;
        let next = -1;
        for (const child of node.children) {
            if (tree.nodes[child].state === state) {
                next = child;
                break;
            }
        }
        if (next === -1)
            return -1;
        current = next;
    }
    return current;
}
/** The state ids from the root down to `id`, root excluded. */
export function pathOf(tree, id) {
    const out = [];
    let current = id;
    while (current > 0) {
        const node = tree.nodes[current];
        if (node === undefined)
            break;
        out.push(node.state);
        current = node.parent;
    }
    return out.reverse();
}
/** Every typology key in a node's subtree — what selecting that node scopes to. */
export function collectTypologies(tree, id) {
    const out = [];
    const stack = [id];
    while (stack.length > 0) {
        const node = tree.nodes[stack.pop()];
        if (node === undefined)
            continue;
        if (node.terminal !== null)
            out.push(node.terminal);
        for (const child of node.children)
            stack.push(child);
    }
    return out;
}
/** Does this sequence begin with `path`? The store's side of a path selection. */
export function startsWithPath(states, path) {
    if (path.length > states.length)
        return false;
    for (let i = 0; i < path.length; i++) {
        if (states[i] !== path[i])
            return false;
    }
    return true;
}
