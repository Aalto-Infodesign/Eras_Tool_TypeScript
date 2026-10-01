import { useEffect, useRef, useState } from "react";
/**
 * Long enough to read as a move, short enough not to be in the way.
 *
 * Exported with `ease` so the Sankey's tween moves with the same feel as the
 * chart's rather than a copy of it that drifts.
 */
export const DURATION_MS = 380;
/** Ease-out cubic: fast commitment, soft landing. */
export const ease = (t) => 1 - (1 - t) ** 3;
/** Below this the animation is indistinguishable from the target; snap instead. */
const EPSILON = 1e-3;
/**
 * Tweens the chart's *view* — the x scale and the row ordering — toward its
 * target, and hands back the value every layer should draw this frame.
 *
 * Both are view parameters rather than data: the shader resolves the x scale
 * from a uniform and the row from a small lookup texture, so a frame of this
 * animation costs one redraw and a few dozen floats. Nothing is rebuilt, nothing
 * is re-uploaded, and `useChartLayers` never re-runs.
 *
 * The single returned value is the point. The canvas and the four SVG layers
 * read the same numbers each frame, so the decade rules, the box plots and the
 * density field move together; driving the canvas from a uniform while React
 * re-rendered the SVG only at the end would tear them apart for the duration.
 * That is why this pushes state per frame rather than animating inside the
 * renderer — the SVG layers are tens of elements, so the re-render is cheap, and
 * lockstep is worth more than the frames it costs.
 */
export function useAnimatedView(targetXDomain, targetRows, options) {
    const { enabled, xUnits } = options;
    const [view, setView] = useState({
        xDomain: targetXDomain,
        rows: targetRows,
        isAnimating: false,
    });
    // The animation's own bookkeeping, kept in step with `view` at every write.
    const current = useRef({ xDomain: targetXDomain, rows: targetRows });
    const handle = useRef(0);
    const cancel = () => {
        if (handle.current !== 0) {
            cancelAnimationFrame(handle.current);
            handle.current = 0;
        }
    };
    /*
     * A unit change lands during render, not in an effect.
     *
     * Switching axis replaces the geometry *and* the domain in one go. Deferring
     * the new domain by even one commit would let the draw effect paint the new
     * geometry against the old domain — calendar years on an age scale, i.e. the
     * whole chart somewhere off to one side — before the correction arrives. The
     * previous units live in state so this survives a double render.
     */
    const [previousUnits, setPreviousUnits] = useState(xUnits);
    if (previousUnits !== xUnits) {
        cancel();
        current.current = { xDomain: targetXDomain, rows: targetRows };
        setPreviousUnits(xUnits);
        setView({ xDomain: targetXDomain, rows: targetRows, isAnimating: false });
    }
    useEffect(() => {
        const from = current.current;
        const sameDomain = Math.abs(from.xDomain[0] - targetXDomain[0]) < EPSILON &&
            Math.abs(from.xDomain[1] - targetXDomain[1]) < EPSILON;
        /*
         * A changed vocabulary is not a move — there is no "from" row for a state
         * that did not exist a moment ago. Loading a file or removing a state lands
         * on the new ordering directly; only a reorder of the same states tweens.
         */
        const sameVocabulary = from.rows.length === targetRows.length;
        const sameRows = sameVocabulary &&
            targetRows.every((row, i) => Math.abs(from.rows[i] - row) < EPSILON);
        if (sameDomain && sameRows)
            return;
        if (!enabled || !sameVocabulary) {
            cancel();
            current.current = { xDomain: targetXDomain, rows: targetRows };
            setView({ xDomain: targetXDomain, rows: targetRows, isAnimating: false });
            return;
        }
        const startDomain = from.xDomain;
        const startRows = Float32Array.from(from.rows);
        const started = performance.now();
        const step = () => {
            const t = Math.min(1, (performance.now() - started) / DURATION_MS);
            const k = ease(t);
            const xDomain = [
                startDomain[0] + (targetXDomain[0] - startDomain[0]) * k,
                startDomain[1] + (targetXDomain[1] - startDomain[1]) * k,
            ];
            // A new array per frame: layers memoise on identity, and this is tens of
            // floats, not the megabytes the vertex buffers hold.
            const rows = new Float32Array(targetRows.length);
            for (let i = 0; i < rows.length; i++) {
                const a = startRows[i];
                const b = targetRows[i];
                rows[i] = a + (b - a) * k;
            }
            current.current = { xDomain, rows };
            setView({ xDomain, rows, isAnimating: t < 1 });
            handle.current = t < 1 ? requestAnimationFrame(step) : 0;
        };
        cancel();
        handle.current = requestAnimationFrame(step);
        return cancel;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [targetXDomain, targetRows, enabled]);
    return view;
}
/** Shorter than a move: this is a change of emphasis, not of what is on screen. */
const FADE_MS = 190;
/**
 * Tweens one number, for the layers whose *emphasis* changes rather than their
 * position.
 *
 * Pointing at a spine dims a million hairlines and lifts a few hundred, and both
 * are uniforms — so a frame here is one `drawArrays` with two floats changed,
 * with nothing rebuilt, re-uploaded, or even re-measured. That is cheaper than a
 * frame of `useAnimatedView`, which also replaces the row texture, so the two
 * take their budgets separately: see `FADE_FRAME_BUDGET_MS`.
 *
 * Reversing mid-flight works by construction — the tween starts from wherever
 * the value currently is, so sweeping on and off a spine never snaps.
 */
export function useAnimatedScalar(target, enabled) {
    const [value, setValue] = useState(target);
    const current = useRef(target);
    const handle = useRef(0);
    useEffect(() => {
        const cancel = () => {
            if (handle.current !== 0) {
                cancelAnimationFrame(handle.current);
                handle.current = 0;
            }
        };
        const from = current.current;
        if (Math.abs(from - target) < EPSILON)
            return;
        if (!enabled) {
            cancel();
            current.current = target;
            setValue(target);
            return;
        }
        const started = performance.now();
        const step = () => {
            const t = Math.min(1, (performance.now() - started) / FADE_MS);
            const next = from + (target - from) * ease(t);
            current.current = next;
            setValue(next);
            handle.current = t < 1 ? requestAnimationFrame(step) : 0;
        };
        cancel();
        handle.current = requestAnimationFrame(step);
        return cancel;
    }, [target, enabled]);
    return value;
}
