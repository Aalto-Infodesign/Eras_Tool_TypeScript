/**
 * Which patients are currently in view.
 *
 * The old pipeline expressed a filter as a *new array of patient objects*, then
 * re-ran the entire trajectory and silhouette derivation over it — so dragging a
 * slider reallocated and re-derived the whole dataset on every frame.
 *
 * A Selection is one byte per patient in a buffer that is allocated once and
 * rewritten in place. Filtering 250k patients is then a linear scan over 250 KB:
 * fast enough to run synchronously inside a pointer-move handler.
 */
export class Selection {
    patientCount;
    /** 1 = visible. Length is `patientCount`. */
    mask;
    compacted = null;
    size = 0;
    constructor(patientCount) {
        this.patientCount = patientCount;
        this.mask = new Uint8Array(patientCount);
        this.mask.fill(1);
        this.size = patientCount;
    }
    /** Marks the compacted index list stale after a caller writes `mask` directly. */
    invalidate(count) {
        this.size = count;
        this.compacted = null;
    }
    get count() {
        return this.size;
    }
    get isEverything() {
        return this.size === this.patientCount;
    }
    has(patient) {
        return this.mask[patient] === 1;
    }
    /**
     * Ascending list of visible patient indices, built on demand and cached.
     * Iterating this beats scanning the mask when the selection is sparse.
     */
    indices() {
        if (this.compacted !== null)
            return this.compacted;
        const out = new Uint32Array(this.size);
        let n = 0;
        for (let p = 0; p < this.patientCount; p++) {
            if (this.mask[p] === 1)
                out[n++] = p;
        }
        this.compacted = out.subarray(0, n);
        return this.compacted;
    }
    /** Number of events covered — the render cost of this selection. */
    eventCount(store) {
        if (this.isEverything)
            return store.eventCount;
        let total = 0;
        const indices = this.indices();
        for (let i = 0; i < indices.length; i++) {
            const p = indices[i];
            total += store.offsets[p + 1] - store.offsets[p];
        }
        return total;
    }
}
