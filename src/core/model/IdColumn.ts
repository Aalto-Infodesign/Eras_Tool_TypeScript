/**
 * Patient ids as one UTF-8 blob plus offsets, rather than a `string[]`.
 *
 * Ids are only ever read for tooltips and exports — a few per session — but a
 * `string[]` of 250k entries is 250k heap objects that must be structured-cloned
 * across the worker boundary, whereas two typed arrays are *transferred* (zero
 * copy) along with the rest of the store. Decoding is lazy and memoised.
 */
export class IdColumn {
  private readonly cache = new Map<number, string>()
  private decoder: TextDecoder | null = null

  constructor(
    readonly bytes: Uint8Array,
    readonly offsets: Uint32Array,
  ) {}

  static encode(ids: readonly string[]): IdColumn {
    const encoder = new TextEncoder()
    const offsets = new Uint32Array(ids.length + 1)

    // Ids are short and mostly ASCII; 4 bytes per char is a safe upper bound.
    let capacity = 0
    for (const id of ids) capacity += id.length * 4
    const scratch = new Uint8Array(capacity)

    let written = 0
    for (let i = 0; i < ids.length; i++) {
      offsets[i] = written
      const { written: n } = encoder.encodeInto(ids[i] as string, scratch.subarray(written))
      written += n ?? 0
    }
    offsets[ids.length] = written

    return new IdColumn(scratch.slice(0, written), offsets)
  }

  get length(): number {
    return this.offsets.length - 1
  }

  at(index: number): string {
    const hit = this.cache.get(index)
    if (hit !== undefined) return hit

    const start = this.offsets[index]
    const end = this.offsets[index + 1]
    if (start === undefined || end === undefined) return ""

    this.decoder ??= new TextDecoder()
    const value = this.decoder.decode(this.bytes.subarray(start, end))
    this.cache.set(index, value)
    return value
  }

  /** Materialises every id. Only for export paths, never for rendering. */
  toArray(): string[] {
    const out = new Array<string>(this.length)
    for (let i = 0; i < out.length; i++) out[i] = this.at(i)
    return out
  }
}
