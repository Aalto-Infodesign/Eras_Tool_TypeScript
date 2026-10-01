/**
 * Past this many (step, source, target) slots the lookup tables become a Map.
 *
 * A dense table is one `Int32Array` read per lookup and is what both real
 * datasets need — 8 states over 8 steps is 512 slots. But the graph is rebuilt
 * on every filter frame and keeps its tables alive for `nodeAt`/`linkAt`, so
 * the dense form is capped at 256 KB; a vocabulary big enough to pass that is
 * sparse anyway, since a link slot is only used if someone made that move.
 */
const DENSE_SLOT_LIMIT = 1 << 16;
function denseIndex(length) {
    const slots = new Int32Array(length).fill(-1);
    return {
        get: (key) => (key >= 0 && key < length ? slots[key] : -1),
        set: (key, index) => {
            slots[key] = index;
        },
    };
}
function sparseIndex() {
    const slots = new Map();
    return {
        get: (key) => slots.get(key) ?? -1,
        set: (key, index) => {
            slots.set(key, index);
        },
    };
}
/** Provisional index → final index, when the final order is ascending key. */
function rankByKey(keys) {
    const order = keys.map((_, i) => i).sort((a, b) => keys[a] - keys[b]);
    const rank = new Int32Array(keys.length);
    for (let r = 0; r < order.length; r++)
        rank[order[r]] = r;
    return rank;
}
export function buildSankey(typologies, sizes, stateCount) {
    const sizeOf = (t) => (t < sizes.length ? sizes[t] : 0);
    // Pass 1 — how deep and how wide.
    let steps = 0;
    let total = 0;
    let maxState = stateCount - 1;
    for (let t = 0; t < typologies.length; t++) {
        const size = sizeOf(t);
        if (size === 0)
            continue;
        const states = typologies[t].states;
        if (states.length > steps)
            steps = states.length;
        total += size;
        for (let k = 0; k < states.length; k++) {
            if (states[k] > maxState)
                maxState = states[k];
        }
    }
    const S = Math.max(0, maxState + 1);
    const dense = steps * S * S <= DENSE_SLOT_LIMIT;
    const nodeIndex = dense ? denseIndex(steps * S) : sparseIndex();
    const linkIndex = dense ? denseIndex(Math.max(0, steps - 1) * S * S) : sparseIndex();
    // Pass 2 — accumulate under provisional indices, in order of first sight.
    const nodeKeys = [];
    const nodeSize = [];
    const nodeEnds = [];
    const nodeCount = [];
    const linkKeys = [];
    const linkSize = [];
    const linkCount = [];
    for (let t = 0; t < typologies.length; t++) {
        const size = sizeOf(t);
        if (size === 0)
            continue;
        const states = typologies[t].states;
        for (let k = 0; k < states.length; k++) {
            const state = states[k];
            const nodeKey = k * S + state;
            let n = nodeIndex.get(nodeKey);
            if (n === -1) {
                n = nodeKeys.length;
                nodeIndex.set(nodeKey, n);
                nodeKeys.push(nodeKey);
                nodeSize.push(0);
                nodeEnds.push(0);
                nodeCount.push(0);
            }
            nodeSize[n] = nodeSize[n] + size;
            nodeCount[n] = nodeCount[n] + 1;
            if (k === states.length - 1) {
                nodeEnds[n] = nodeEnds[n] + size;
                continue;
            }
            const linkKey = nodeKey * S + states[k + 1];
            let l = linkIndex.get(linkKey);
            if (l === -1) {
                l = linkKeys.length;
                linkIndex.set(linkKey, l);
                linkKeys.push(linkKey);
                linkSize.push(0);
                linkCount.push(0);
            }
            linkSize[l] = linkSize[l] + size;
            linkCount[l] = linkCount[l] + 1;
        }
    }
    /*
     * The keys already encode the order the graph promises — `step·S + state`
     * sorts by step then state, `(step·S + source)·S + target` by step, source,
     * target — so ranking the keys is the whole sort, and the tables are rewritten
     * in place to hold final indices.
     */
    const nodeRank = rankByKey(nodeKeys);
    const linkRank = rankByKey(linkKeys);
    const nodes = new Array(nodeKeys.length);
    for (let i = 0; i < nodeKeys.length; i++) {
        const key = nodeKeys[i];
        const index = nodeRank[i];
        const step = Math.floor(key / S);
        const size = nodeSize[i];
        const ends = nodeEnds[i];
        nodeIndex.set(key, index);
        nodes[index] = {
            index,
            step,
            state: key - step * S,
            size,
            inflow: step === 0 ? 0 : size,
            outflow: size - ends,
            ends,
        };
    }
    const links = new Array(linkKeys.length);
    for (let i = 0; i < linkKeys.length; i++) {
        const key = linkKeys[i];
        const index = linkRank[i];
        const target = key % S;
        const sourceKey = (key - target) / S;
        const step = Math.floor(sourceKey / S);
        linkIndex.set(key, index);
        links[index] = {
            index,
            step,
            source: nodeIndex.get(sourceKey),
            target: nodeIndex.get((step + 1) * S + target),
            size: linkSize[i],
        };
    }
    const incoming = nodes.map(() => []);
    const outgoing = nodes.map(() => []);
    for (const link of links) {
        ;
        outgoing[link.source].push(link.index);
        incoming[link.target].push(link.index);
    }
    // Pass 3 — the typologies through each node and link, as CSR.
    const nodeOffsets = new Uint32Array(nodes.length + 1);
    for (let i = 0; i < nodeKeys.length; i++) {
        nodeOffsets[nodeRank[i] + 1] = nodeCount[i];
    }
    for (let n = 0; n < nodes.length; n++) {
        nodeOffsets[n + 1] = nodeOffsets[n + 1] + nodeOffsets[n];
    }
    const linkOffsets = new Uint32Array(links.length + 1);
    for (let i = 0; i < linkKeys.length; i++) {
        linkOffsets[linkRank[i] + 1] = linkCount[i];
    }
    for (let l = 0; l < links.length; l++) {
        linkOffsets[l + 1] = linkOffsets[l + 1] + linkOffsets[l];
    }
    const nodeTypologies = new Uint32Array(nodeOffsets[nodes.length]);
    const linkTypologies = new Uint32Array(linkOffsets[links.length]);
    const nodeCursor = nodeOffsets.slice(0, nodes.length);
    const linkCursor = linkOffsets.slice(0, links.length);
    for (let t = 0; t < typologies.length; t++) {
        if (sizeOf(t) === 0)
            continue;
        const states = typologies[t].states;
        for (let k = 0; k < states.length; k++) {
            const nodeKey = k * S + states[k];
            const n = nodeIndex.get(nodeKey);
            nodeTypologies[nodeCursor[n]] = t;
            nodeCursor[n] = nodeCursor[n] + 1;
            if (k === states.length - 1)
                continue;
            const l = linkIndex.get(nodeKey * S + states[k + 1]);
            linkTypologies[linkCursor[l]] = t;
            linkCursor[l] = linkCursor[l] + 1;
        }
    }
    const inRange = (value, limit) => Number.isInteger(value) && value >= 0 && value < limit;
    return {
        nodes,
        links,
        incoming,
        outgoing,
        steps,
        total,
        stateCount: S,
        linkOffsets,
        linkTypologies,
        nodeOffsets,
        nodeTypologies,
        nodeAt: (step, state) => inRange(step, steps) && inRange(state, S) ? nodeIndex.get(step * S + state) : -1,
        linkAt: (step, sourceState, targetState) => inRange(step, steps - 1) && inRange(sourceState, S) && inRange(targetState, S)
            ? linkIndex.get((step * S + sourceState) * S + targetState)
            : -1,
    };
}
/**
 * A pin as a string: `n:step:state` or `l:step:source:target`.
 *
 * What the SVG carries in `data-key`, what a tween keys its elements by, and
 * what hover holds — a string compares by value, which is what the hover
 * settler needs, and it resolves against whatever graph is current.
 */
export function pinKey(pin) {
    return pin.kind === "node"
        ? `n:${pin.step}:${pin.state}`
        : `l:${pin.step}:${pin.source}:${pin.target}`;
}
const DIGITS = /^\d+$/;
/** The inverse of `pinKey`; `null` for anything it would not have produced. */
export function parsePinKey(key) {
    const parts = key.split(":");
    const numbers = [];
    for (let i = 1; i < parts.length; i++) {
        const part = parts[i];
        if (!DIGITS.test(part))
            return null;
        const value = Number(part);
        if (!Number.isSafeInteger(value))
            return null;
        numbers.push(value);
    }
    const [a = 0, b = 0, c = 0] = numbers;
    if (parts[0] === "n" && numbers.length === 2)
        return { kind: "node", step: a, state: b };
    if (parts[0] === "l" && numbers.length === 3) {
        return { kind: "link", step: a, source: b, target: c };
    }
    return null;
}
/** The identity of an item of `graph`; `null` if the index is not in it. */
export function pinOf(graph, item) {
    if (item.kind === "node") {
        const node = graph.nodes[item.index];
        return node === undefined ? null : { kind: "node", step: node.step, state: node.state };
    }
    const link = graph.links[item.index];
    if (link === undefined)
        return null;
    const source = graph.nodes[link.source];
    const target = graph.nodes[link.target];
    return { kind: "link", step: link.step, source: source.state, target: target.state };
}
/**
 * `pinKey(pinOf(graph, item))` — the key an item is drawn and hovered under.
 * Empty (never a valid key) when the index is not in `graph`.
 */
export function itemKey(graph, item) {
    const pin = pinOf(graph, item);
    return pin === null ? "" : pinKey(pin);
}
/**
 * Where a pin is in `graph`, or `null` when nobody live is there.
 *
 * A pin that resolves to nothing is *dormant*, not wrong: the filters emptied
 * it, and widening them brings it back at whatever index it now has.
 */
export function resolvePin(graph, pin) {
    if (pin === null)
        return null;
    const index = pin.kind === "node"
        ? graph.nodeAt(pin.step, pin.state)
        : graph.linkAt(pin.step, pin.source, pin.target);
    return index === -1 ? null : { kind: pin.kind, index };
}
export function samePin(a, b) {
    if (a === null || b === null)
        return a === b;
    if (a.kind === "node" && b.kind === "node")
        return a.step === b.step && a.state === b.state;
    if (a.kind === "link" && b.kind === "link") {
        return a.step === b.step && a.source === b.source && a.target === b.target;
    }
    return false;
}
/**
 * Indices into `typologies` of the live typologies through an item.
 *
 * Because a typology is an exact sequence, its live members are *exactly* the
 * patients it contributes to every node and link on its path. So selecting
 * these typologies selects the item's patients and nobody else — the typology
 * selection is lossless here, which is why the Sankey drills down through it
 * rather than through a list of patient ids as the original did.
 *
 * `scope` only applies to nodes (see `SankeyScope`); a link's typologies all
 * continue by definition. With `all` this is a view into the graph, not a copy.
 */
export function typologiesThrough(graph, typologies, item, scope = "all") {
    const isNode = item.kind === "node";
    const offsets = isNode ? graph.nodeOffsets : graph.linkOffsets;
    const members = isNode ? graph.nodeTypologies : graph.linkTypologies;
    const count = isNode ? graph.nodes.length : graph.links.length;
    if (!Number.isInteger(item.index) || item.index < 0 || item.index >= count) {
        return new Uint32Array();
    }
    const all = members.subarray(offsets[item.index], offsets[item.index + 1]);
    if (!isNode || scope === "all")
        return all;
    const step = graph.nodes[item.index].step;
    const wanted = (t) => {
        const length = typologies[t].states.length;
        return scope === "continuing" ? length > step + 1 : length === step + 1;
    };
    let n = 0;
    for (let i = 0; i < all.length; i++)
        if (wanted(all[i]))
            n += 1;
    const out = new Uint32Array(n);
    n = 0;
    for (let i = 0; i < all.length; i++) {
        const t = all[i];
        if (wanted(t))
            out[n++] = t;
    }
    return out;
}
/**
 * Where the patients of some typologies go — the trace drawn over the graph.
 *
 * Hovering an item traces `typologiesThrough(item)`: the lineage of its
 * patients, upstream and downstream at once, which is the reading the original
 * could not give (its hover lit one link). A typology card's hover traces that
 * one typology, and a hovered patient traces theirs. O(Σ of those typologies'
 * lengths) — nothing here reads a patient.
 */
export function traceSankey(graph, typologies, sizes, typologyIndices) {
    const links = new Uint32Array(graph.links.length);
    const nodes = new Uint32Array(graph.nodes.length);
    let total = 0;
    for (let i = 0; i < typologyIndices.length; i++) {
        const t = typologyIndices[i];
        const typology = typologies[t];
        const size = t < sizes.length ? sizes[t] : 0;
        if (typology === undefined || size === 0)
            continue;
        total += size;
        const { states } = typology;
        for (let k = 0; k < states.length; k++) {
            const state = states[k];
            const n = graph.nodeAt(k, state);
            if (n !== -1)
                nodes[n] = nodes[n] + size;
            if (k === states.length - 1)
                continue;
            const l = graph.linkAt(k, state, states[k + 1]);
            if (l !== -1)
                links[l] = links[l] + size;
        }
    }
    return { links, nodes, total };
}
/**
 * The patient's typology index, or -1 for a patient in none (a splice emptied
 * their trajectory) — how a hovered patient becomes a trace.
 */
export function typologyOfPatient(typologies, patientCount) {
    const out = new Int32Array(patientCount).fill(-1);
    for (let t = 0; t < typologies.length; t++) {
        const { patients } = typologies[t];
        for (let i = 0; i < patients.length; i++) {
            const p = patients[i];
            if (p < patientCount)
                out[p] = t;
        }
    }
    return out;
}
/*
 * A link a → b at step k is the pair (event k, event k + 1): its duration is
 * `durations[k]` — the time from a to b — and its age and year are read at
 * k + 1, on reaching b, which is when the move happened.
 *
 * A node at step k reads age and year at event k, on reaching the state. Its
 * duration is the time spent there before the next state, so it only exists for
 * the patients who *have* a next state: a trajectory's closing self-link carries
 * a zero that is a convention rather than a measurement (see distributions.ts),
 * and counting those zeros would pile every stopping patient into the first bin.
 */
function readingOf(store, kind, step, metric) {
    const onward = step + 2;
    const here = kind === "link" ? onward : step + 1;
    const shift = kind === "link" ? 1 : 0;
    switch (metric) {
        case "duration":
            return { column: store.durations, shift: 0, minLength: onward };
        case "age":
            return { column: store.ages, shift, minLength: here };
        case "year":
            return { column: store.years, shift, minLength: here };
        case "diseaseDuration":
            return { column: null, shift: 0, minLength: here };
    }
}
/**
 * The metric for every live member of the candidate typologies (all of them
 * when `candidates` is null), at `step`. Exact length.
 */
function gather(store, typologies, candidates, mask, step, reading) {
    const { column, shift, minLength } = reading;
    const count = candidates === null ? typologies.length : candidates.length;
    const typologyAt = (i) => typologies[candidates === null ? i : candidates[i]];
    // Sized for every member, trimmed to the live ones: one allocation either way.
    let capacity = 0;
    for (let i = 0; i < count; i++) {
        const typology = typologyAt(i);
        if (typology !== undefined && typology.states.length >= minLength) {
            capacity += typology.patients.length;
        }
    }
    const out = new Float64Array(capacity);
    let n = 0;
    for (let i = 0; i < count; i++) {
        const typology = typologyAt(i);
        if (typology === undefined || typology.states.length < minLength)
            continue;
        const { patients } = typology;
        for (let j = 0; j < patients.length; j++) {
            const p = patients[j];
            if (mask[p] !== 1)
                continue;
            out[n++] =
                column === null
                    ? store.diseaseDuration[p]
                    : column[store.offsets[p] + step + shift];
        }
    }
    return n === capacity ? out : out.slice(0, n);
}
/**
 * One value per live patient through an item — the distribution under a pin.
 *
 * The original plotted one thing here, the segment duration (`speed`) of the
 * link; the other metrics are the ones its filters already offered. A node's
 * duration only counts the patients who continue (see `readingOf`), so it can
 * hold fewer values than the node holds patients.
 */
export function sankeyMetricValues(options) {
    const { store, graph, typologies, mask, item, metric } = options;
    const owner = item.kind === "node" ? graph.nodes[item.index] : graph.links[item.index];
    if (owner === undefined)
        return new Float64Array();
    const reading = readingOf(store, item.kind, owner.step, metric);
    const members = typologiesThrough(graph, typologies, item);
    return gather(store, typologies, members, mask, owner.step, reading);
}
/**
 * The same metric over *everyone* at a step — every link k → k + 1, or every
 * node in column k — the ghost baseline an item's distribution is read against.
 * "Is a → b slow?" has no answer without "slow compared to what".
 */
export function stepMetricValues(options) {
    const { store, typologies, mask, step, kind, metric } = options;
    return gather(store, typologies, null, mask, step, readingOf(store, kind, step, metric));
}
/**
 * Per link, how many of its segments have a duration inside the filter range.
 *
 * The duration filter keeps a *patient* if any one of their segments is in
 * range, so a kept patient can still carry segments outside it — and the
 * trajectories views drop those segments when they draw. The Sankey is a
 * patient-level reading (true positions, conserved flow), so rather than
 * breaking flow to match, it shows this count as the lit share of each link
 * over a ghost of the rest. Only worth computing while the filter is on.
 */
export function linkSegmentsInRange(options) {
    const { store, graph, typologies, mask, range, inverted } = options;
    const out = new Uint32Array(graph.links.length);
    for (const link of graph.links) {
        const members = graph.linkTypologies.subarray(graph.linkOffsets[link.index], graph.linkOffsets[link.index + 1]);
        let lit = 0;
        for (let i = 0; i < members.length; i++) {
            const { patients } = typologies[members[i]];
            for (let j = 0; j < patients.length; j++) {
                const p = patients[j];
                if (mask[p] !== 1)
                    continue;
                const d = store.durations[store.offsets[p] + link.step];
                if (d >= range.min && d <= range.max ? !inverted : inverted)
                    lit += 1;
            }
        }
        out[link.index] = lit;
    }
    return out;
}
/**
 * Five numbers and a mean, exactly — the stats row under a distribution.
 *
 * Quantiles interpolate linearly between order statistics (R's type 7, which is
 * what `d3.quantile` computes), so an even count's median is the mean of the
 * middle two. NaN values are skipped; an empty input gives `n = 0` and NaN
 * everywhere else, which formats as a dash rather than a misleading zero.
 */
export function summarise(values) {
    // Typed-array sort is numeric and puts NaN last, so the live values are a prefix.
    const sorted = Float64Array.from(values).sort();
    let n = sorted.length;
    while (n > 0 && Number.isNaN(sorted[n - 1]))
        n -= 1;
    if (n === 0) {
        return { n: 0, min: NaN, q1: NaN, median: NaN, q3: NaN, max: NaN, mean: NaN };
    }
    const quantile = (p) => {
        const position = (n - 1) * p;
        const below = Math.floor(position);
        const lo = sorted[below];
        if (below + 1 >= n)
            return lo;
        return lo + (sorted[below + 1] - lo) * (position - below);
    };
    let sum = 0;
    for (let i = 0; i < n; i++)
        sum += sorted[i];
    return {
        n,
        min: sorted[0],
        q1: quantile(0.25),
        median: quantile(0.5),
        q3: quantile(0.75),
        max: sorted[n - 1],
        mean: sum / n,
    };
}
