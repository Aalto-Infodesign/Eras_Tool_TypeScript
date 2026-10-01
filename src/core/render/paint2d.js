export function paintGeometry(ctx, geometry, options) {
    if (geometry === null || geometry.segmentCount === 0)
        return;
    const { target, xDomain, rows, rowCount, marginY, opacity, lineWidth, fade, background } = options;
    const { rowColors } = options;
    if (opacity <= 0)
        return;
    const [x0, x1] = xDomain;
    const span = Math.max(x1 - x0, 1e-6);
    const xFactor = target.width / span;
    const usable = Math.max(target.height - 2 * marginY, 1);
    const rowHeight = usable / Math.max(rowCount, 1);
    ctx.globalAlpha = opacity;
    ctx.lineWidth = lineWidth;
    ctx.lineCap = "butt";
    const { positions, colors, segmentCount } = geometry;
    const yOf = (row) => target.y + marginY + (row + 0.5) * rowHeight;
    if (rowColors !== undefined) {
        /*
         * One path and one gradient per *step*.
         *
         * Every segment on step `i` runs from row `i` to row `i + 1`, so the colour
         * transition is a function of y alone — and because y is affine along the
         * segment, a vertical gradient between the two rows reproduces the GPU's
         * per-vertex interpolation exactly rather than approximating it. The cost is
         * one gradient per step (single digits), not one per segment.
         */
        const byRow = new Map();
        for (let s = 0; s < segmentCount; s++) {
            const p = s * 4;
            const row = positions[p + 1];
            let path = byRow.get(row);
            if (path === undefined) {
                path = new Path2D();
                byRow.set(row, path);
            }
            path.moveTo(target.x + (positions[p] - x0) * xFactor, yOf(row));
            path.lineTo(target.x + (positions[p + 2] - x0) * xFactor, yOf(positions[p + 3]));
        }
        for (const [row, path] of byRow) {
            const from = rowColors[row] ?? "currentColor";
            const to = rowColors[row + 1] ?? from;
            if (from === to) {
                // A patient's single-event mark lies flat on its row, and a gradient
                // with no height to run down is a no-op the spec leaves undefined.
                ctx.strokeStyle = from;
            }
            else {
                const gradient = ctx.createLinearGradient(0, yOf(row), 0, yOf(row + 1));
                gradient.addColorStop(0, from);
                gradient.addColorStop(1, to);
                ctx.strokeStyle = gradient;
            }
            ctx.stroke(path);
        }
        ctx.globalAlpha = 1;
        return;
    }
    const paths = new Map();
    const pathFor = (rgb) => {
        let path = paths.get(rgb);
        if (path === undefined) {
            path = new Path2D();
            paths.set(rgb, path);
        }
        return path;
    };
    for (let s = 0; s < segmentCount; s++) {
        const p = s * 4;
        const c = s * 8;
        // `positions.y` is a state id; the row it sits on is a view property, and in
        // the small-multiples grid a different one in every panel.
        const ax = target.x + (positions[p] - x0) * xFactor;
        const ay = yOf(rows[positions[p + 1]] ?? 0);
        const bx = target.x + (positions[p + 2] - x0) * xFactor;
        const by = yOf(rows[positions[p + 3]] ?? 0);
        const mx = (ax + bx) / 2;
        const my = (ay + by) / 2;
        const sourceRgb = (colors[c] << 16) | (colors[c + 1] << 8) | colors[c + 2];
        const targetRgb = (colors[c + 4] << 16) |
            (colors[c + 5] << 8) |
            colors[c + 6];
        const first = pathFor(sourceRgb);
        first.moveTo(ax, ay);
        first.lineTo(mx, my);
        const second = pathFor(targetRgb);
        second.moveTo(mx, my);
        second.lineTo(bx, by);
    }
    for (const [rgb, path] of paths) {
        // Mixed once per colour rather than per segment — there are a handful of
        // states and up to a million segments.
        ctx.strokeStyle = `#${(fade > 0 ? mixToward(rgb, background, fade) : rgb)
            .toString(16)
            .padStart(6, "0")}`;
        ctx.stroke(path);
    }
    ctx.globalAlpha = 1;
}
/** Packed RGB mixed toward a 0–1 background colour. */
export function mixToward(rgb, background, fade) {
    const mix = (channel, target) => Math.round(channel + (target * 255 - channel) * fade);
    const r = mix((rgb >> 16) & 255, background[0]);
    const g = mix((rgb >> 8) & 255, background[1]);
    const b = mix(rgb & 255, background[2]);
    return (r << 16) | (g << 8) | b;
}
