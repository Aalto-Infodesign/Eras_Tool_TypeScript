import { describe, expect, it } from "vitest";
import { niceBins, niceStep, niceTicks } from "../render/scales.ts";
import { histogram } from "../stats/distributions.ts";
describe("niceStep", () => {
    it("rounds to 1, 2 or 5 times a power of ten", () => {
        expect(niceStep(10, 10)).toBe(1);
        expect(niceStep(10, 5)).toBe(2);
        expect(niceStep(10, 2)).toBe(5);
        expect(niceStep(100, 10)).toBe(10);
        expect(niceStep(1, 30)).toBeCloseTo(0.05);
        expect(niceStep(5, 30)).toBeCloseTo(0.2);
    });
    it("is zero when there is nothing to cut", () => {
        expect(niceStep(0, 10)).toBe(0);
        expect(niceStep(-1, 10)).toBe(0);
        expect(niceStep(10, 0)).toBe(0);
        expect(niceStep(Number.NaN, 10)).toBe(0);
        expect(niceStep(Infinity, 10)).toBe(0);
    });
});
describe("niceTicks", () => {
    it("labels round values inside the domain", () => {
        expect(niceTicks(0, 10, 5)).toEqual([0, 2, 4, 6, 8, 10]);
        expect(niceTicks(1.3, 8.7, 5)).toEqual([2, 4, 6, 8]);
        expect(niceTicks(1990, 2025, 4)).toEqual([1990, 2000, 2010, 2020]);
    });
    it("lands on the decimal rather than beside it", () => {
        // 0.1 * 3 is 0.30000000000000004; the tick must read 0.3.
        expect(niceTicks(0, 1, 10)).toEqual([0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1]);
    });
    it("copes with reversed, degenerate and non-finite domains", () => {
        expect(niceTicks(10, 0, 5)).toEqual([0, 2, 4, 6, 8, 10]);
        expect(niceTicks(3, 3, 5)).toEqual([3]);
        expect(niceTicks(Number.NaN, 3, 5)).toEqual([]);
    });
});
describe("niceBins", () => {
    it("snaps the domain outward to round bin edges", () => {
        const bins = niceBins(0.13, 4.91);
        expect(bins.step).toBeCloseTo(0.2);
        expect(bins.lo).toBe(0);
        expect(bins.hi).toBe(5);
        expect(bins.bins).toBe(25);
        expect(bins.lo).toBeLessThanOrEqual(0.13);
        expect(bins.hi).toBeGreaterThanOrEqual(4.91);
    });
    it("keeps a domain already on round numbers", () => {
        expect(niceBins(0, 30)).toEqual({ lo: 0, hi: 30, step: 1, bins: 30 });
    });
    it("aims for about the target number of bins", () => {
        for (const [lo, hi] of [
            [0, 1],
            [1990, 2025],
            [0.001, 0.37],
            [-3, 170],
        ]) {
            const { bins } = niceBins(lo, hi, 30);
            expect(bins).toBeGreaterThanOrEqual(12);
            expect(bins).toBeLessThanOrEqual(70);
        }
    });
    it("widens a single value by a step either side", () => {
        const bins = niceBins(2.5, 2.5);
        expect(bins.lo).toBeCloseTo(2.5 - bins.step);
        expect(bins.hi).toBeCloseTo(2.5 + bins.step);
        expect(bins.bins).toBe(2);
    });
    it("gives an empty input a harmless frame", () => {
        const bins = niceBins(Infinity, -Infinity);
        expect(bins.lo).toBe(0);
        expect(bins.hi).toBe(1);
        expect(bins.bins).toBeGreaterThan(0);
    });
    it("feeds histogram bins whose edges read as written", () => {
        const values = Float64Array.of(0.1, 2.1, 2.2, 2.45, 4.9);
        const { lo, hi, step, bins } = niceBins(0.1, 4.9, 10);
        const distribution = histogram(values, values.length, [lo, hi], bins);
        expect(step).toBe(0.5);
        expect(distribution.binWidth).toBe(step);
        // 2.1, 2.2 and 2.45 all sit in the 2.0–2.5 bin.
        expect(distribution.counts[Math.floor((2 - lo) / step)]).toBe(3);
    });
});
