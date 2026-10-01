import { jsx as _jsx, Fragment as _Fragment, jsxs as _jsxs } from "react/jsx-runtime";
import { useCallback, useEffect, useRef, useState } from "react";
const TRACK_HEIGHT = 8;
const HANDLE_WIDTH = 7;
const HANDLE_HEIGHT = 18;
const HEIGHT = 24;
/**
 * Two handles on one track.
 *
 * The two native `<input type="range">` elements this replaces could express a
 * range only by stacking two sliders, which is why the old panel showed the
 * bounds as text and left you to infer the band. Here the band *is* the control:
 * it lines up pixel for pixel with the distribution drawn above it, so a handle
 * lands on a feature of the data rather than on a number.
 *
 * The handle position is local state while dragging and only syncs down from
 * `value` when a drag is not in progress. That is what keeps the handle glued to
 * the pointer no matter what the commit costs downstream — the original made the
 * same split, and called it out as "never debounced, always instant".
 */
export function RangeSlider({ bounds, value, width, inverted, onChange, onPreview, onHoverX, }) {
    const [lo, hi] = bounds;
    const span = Math.max(hi - lo, 1e-9);
    const committed = value ?? bounds;
    const [local, setLocal] = useState(committed);
    const [dragging, setDragging] = useState(null);
    // While dragging, this component is the source of truth; outside a drag the
    // store is (a reset, a chip's ✕, a reshape that moved the extents).
    useEffect(() => {
        if (dragging === null)
            setLocal(committed);
    }, [dragging, committed[0], committed[1]]); // eslint-disable-line react-hooks/exhaustive-deps
    const trackRef = useRef(null);
    const usable = Math.max(width - HANDLE_WIDTH, 1);
    const toPixels = useCallback((v) => ((v - lo) / span) * usable, [lo, span, usable]);
    const toValue = useCallback((clientX) => {
        const rect = trackRef.current?.getBoundingClientRect();
        if (rect === undefined)
            return lo;
        const x = Math.max(0, Math.min(clientX - rect.left, usable));
        return lo + (x / usable) * span;
    }, [lo, span, usable]);
    // Commits are coalesced to one per frame: a pointer fires many more moves than
    // there are frames, and each commit re-runs the filter and the layers behind it.
    const pending = useRef(null);
    const frame = useRef(0);
    const commit = useCallback((next) => {
        pending.current = next;
        if (frame.current !== 0)
            return;
        frame.current = requestAnimationFrame(() => {
            frame.current = 0;
            if (pending.current !== null)
                onChange(pending.current);
            pending.current = null;
        });
    }, [onChange]);
    /**
     * Sends whatever the last frame did not, synchronously.
     *
     * Handing the preview back at the end of a drag only works if the commit has
     * already landed — otherwise the display falls back to a committed value that
     * is one frame stale, and the band jumps backwards before catching up.
     */
    const flush = useCallback(() => {
        if (frame.current !== 0) {
            cancelAnimationFrame(frame.current);
            frame.current = 0;
        }
        if (pending.current !== null) {
            onChange(pending.current);
            pending.current = null;
        }
    }, [onChange]);
    useEffect(() => () => {
        if (frame.current !== 0)
            cancelAnimationFrame(frame.current);
    }, []);
    const end = useCallback(() => {
        flush();
        setDragging(null);
        onPreview?.(null);
    }, [flush, onPreview]);
    const move = useCallback((handle, at) => {
        const next = handle === "min"
            ? [Math.min(at, local[1]), local[1]]
            : [local[0], Math.max(at, local[0])];
        setLocal(next);
        onPreview?.(next);
        commit(next);
    }, [local, commit, onPreview]);
    const start = (event) => {
        const at = toValue(event.clientX);
        // Grab whichever handle is nearer, so the track is draggable anywhere.
        const handle = Math.abs(at - local[0]) <= Math.abs(at - local[1]) ? "min" : "max";
        event.currentTarget.setPointerCapture(event.pointerId);
        setDragging(handle);
        move(handle, at);
    };
    const minX = toPixels(local[0]);
    const maxX = toPixels(local[1]);
    return (_jsxs("svg", { className: "slider", width: width, height: HEIGHT, onPointerDown: start, onPointerMove: (event) => {
            onHoverX?.(toPixels(toValue(event.clientX)) + HANDLE_WIDTH / 2);
            if (dragging !== null)
                move(dragging, toValue(event.clientX));
        }, onPointerUp: (event) => {
            event.currentTarget.releasePointerCapture(event.pointerId);
            end();
        }, 
        // A cancelled pointer (a touch interrupted, a context menu) never sends an
        // up, and without this the slider would stay latched to a drag that is over.
        onPointerCancel: end, onPointerLeave: () => onHoverX?.(null), children: [_jsxs("g", { transform: `translate(${HANDLE_WIDTH / 2} ${(HEIGHT - TRACK_HEIGHT) / 2})`, children: [_jsx("rect", { className: "slider__track", x: 0, width: usable, height: TRACK_HEIGHT, rx: 2 }), inverted ? (_jsxs(_Fragment, { children: [_jsx("rect", { className: "slider__range", x: 0, width: Math.max(minX, 0), height: TRACK_HEIGHT }), _jsx("rect", { className: "slider__range", x: maxX, width: Math.max(usable - maxX, 0), height: TRACK_HEIGHT })] })) : (_jsx("rect", { className: "slider__range", x: minX, width: Math.max(maxX - minX, 0), height: TRACK_HEIGHT })), _jsx("rect", { ref: trackRef, x: 0, width: usable, height: TRACK_HEIGHT, fill: "transparent" })] }), ["min", "max"].map((handle) => (_jsx("rect", { className: "slider__handle", "data-active": dragging === handle, x: (handle === "min" ? minX : maxX), y: (HEIGHT - HANDLE_HEIGHT) / 2, width: HANDLE_WIDTH, height: HANDLE_HEIGHT, rx: 2 }, handle)))] }));
}
