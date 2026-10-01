/** Timing probes. The old code used console.time; these are collectable. */
export class Stopwatch {
    marks = [];
    measure(label, fn) {
        const t0 = performance.now();
        const result = fn();
        this.marks.push({ label, ms: performance.now() - t0 });
        return result;
    }
    add(label, ms) {
        this.marks.push({ label, ms });
    }
    get timings() {
        return this.marks;
    }
    get total() {
        return this.marks.reduce((sum, m) => sum + m.ms, 0);
    }
}
