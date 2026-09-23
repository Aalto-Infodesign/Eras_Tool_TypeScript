/**
 * Collapses duplicate rows into weighted unique points.
 *
 * Mean-shift over m unique points carrying multiplicity weights is
 * *mathematically identical* to mean-shift over the n original points — the
 * kernel mean is a weighted mean either way — so this is a free reduction of the
 * inner loop whenever durations repeat, which they do heavily (dates land on
 * whole years, and many patients share a transition profile).
 *
 * The original did the same collapse but only to pick seeds, and keyed it on
 * `JSON.stringify(row)` — a string allocation and a full string hash per row.
 * Here rows are hashed over their raw Float32 bytes and verified on collision.
 */
export interface WeightedPoints {
  readonly m: number
  readonly d: number
  /** `m × d` unique coordinates. */
  readonly points: Float32Array
  /** Multiplicity of each unique point. */
  readonly weights: Float64Array
  /** Unique point → index of the first original row that produced it. */
  readonly firstRow: Uint32Array
}

export function collapseDuplicates(rows: Float32Array, n: number, d: number): WeightedPoints {
  const buckets = new Map<number, number[]>()
  const points = new Float32Array(n * d)
  const weights = new Float64Array(n)
  const firstRow = new Uint32Array(n)

  const asInt = new Int32Array(rows.buffer, rows.byteOffset, n * d)
  let m = 0

  for (let i = 0; i < n; i++) {
    const base = i * d

    // FNV-1a over the row's raw bits: exact, and no string in sight.
    let hash = 0x811c9dc5
    for (let k = 0; k < d; k++) {
      hash ^= asInt[base + k] as number
      hash = Math.imul(hash, 0x01000193)
    }
    hash >>>= 0

    let bucket = buckets.get(hash)
    if (bucket === undefined) {
      bucket = []
      buckets.set(hash, bucket)
    }

    let found = -1
    for (const candidate of bucket) {
      if (sameRow(rows, base, candidate * d, d)) {
        found = candidate
        break
      }
    }

    if (found === -1) {
      const slot = m++
      points.set(rows.subarray(base, base + d), slot * d)
      weights[slot] = 1
      firstRow[slot] = i
      bucket.push(slot)
    } else {
      weights[found] = (weights[found] as number) + 1
    }
  }

  return {
    m,
    d,
    points: points.subarray(0, m * d),
    weights: weights.subarray(0, m),
    firstRow: firstRow.subarray(0, m),
  }
}

function sameRow(a: Float32Array, aBase: number, bBase: number, d: number): boolean {
  for (let k = 0; k < d; k++) {
    if (a[aBase + k] !== a[bBase + k]) return false
  }
  return true
}
