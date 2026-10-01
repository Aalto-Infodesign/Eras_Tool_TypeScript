/**
 * How long the pointer has to settle on a spine before the chart reacts.
 *
 * Hovering a medoid rebuilds a geometry buffer of its cluster's members and
 * redraws every layer under it — perfectly affordable once, wasteful at pointer
 * rate. Sweeping across a dense band of spines would otherwise queue a rebuild
 * for each one passed over on the way to the one being aimed at.
 *
 * Short enough that aiming at a spine feels like a direct response rather than
 * a delay, long enough that crossing the layer costs nothing.
 */
export const HOVER_SETTLE_MS = 110;
/**
 * The two values a hover reading is made of, shared by both views so the grid
 * and the single chart answer the same question the same way.
 *
 * Pointing at a spine asks "who does this stand for?", and the answer is only
 * legible if everything else steps back further than the opacity slider ever
 * puts it — hence a floor rather than a factor. The members come back at an
 * alpha that still stacks, so their own density is what fills the gap.
 */
export const DIM_FADE = 0.9;
export const HIGHLIGHT_OPACITY = 0.5;
/**
 * Applies `commit` once the target has held still for `HOVER_SETTLE_MS`.
 *
 * Restarted only when the target *changes*, so jitter on the same spine does
 * not push the highlight permanently into the future — which a plain trailing
 * debounce of every pointer event does.
 */
export function createHoverSettler(commit) {
    let pending;
    let armed = false;
    let timer = 0;
    return {
        queue(value) {
            if (armed && pending === value)
                return;
            pending = value;
            armed = true;
            window.clearTimeout(timer);
            timer = window.setTimeout(() => {
                armed = false;
                commit(value);
            }, HOVER_SETTLE_MS);
        },
        cancel() {
            armed = false;
            window.clearTimeout(timer);
        },
    };
}
