import type { TrajectoryStore } from "../types.ts"

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
  /** 1 = visible. Length is `patientCount`. */
  readonly mask: Uint8Array
  private compacted: Uint32Array | null = null
  private size = 0

  constructor(readonly patientCount: number) {
    this.mask = new Uint8Array(patientCount)
    this.mask.fill(1)
    this.size = patientCount
  }

  /** Marks the compacted index list stale after a caller writes `mask` directly. */
  invalidate(count: number): void {
    this.size = count
    this.compacted = null
  }

  get count(): number {
    return this.size
  }

  get isEverything(): boolean {
    return this.size === this.patientCount
  }

  has(patient: number): boolean {
    return this.mask[patient] === 1
  }

  /**
   * Ascending list of visible patient indices, built on demand and cached.
   * Iterating this beats scanning the mask when the selection is sparse.
   */
  indices(): Uint32Array {
    if (this.compacted !== null) return this.compacted

    const out = new Uint32Array(this.size)
    let n = 0
    for (let p = 0; p < this.patientCount; p++) {
      if (this.mask[p] === 1) out[n++] = p
    }
    this.compacted = out.subarray(0, n)
    return this.compacted
  }

  /** Number of events covered — the render cost of this selection. */
  eventCount(store: TrajectoryStore): number {
    if (this.isEverything) return store.eventCount
    let total = 0
    const indices = this.indices()
    for (let i = 0; i < indices.length; i++) {
      const p = indices[i] as number
      total += (store.offsets[p + 1] as number) - (store.offsets[p] as number)
    }
    return total
  }
}
