import type { Geometry } from "./geometry.ts"

/**
 * Hit-testing without DOM nodes.
 *
 * SVG gave hover for free because every line was an element — that is exactly
 * what made large datasets unusable. With a single canvas the chart has to find
 * the segment under the pointer itself, so segments are bucketed into a uniform
 * grid over data space (x column × state row) built in the same CSR shape as the
 * store: a counting pass, then a fill pass, two flat typed arrays, no nested
 * arrays and no per-cell allocation.
 *
 * A query then tests only the handful of segments in the neighbouring cells.
 */
export class SegmentIndex {
  private readonly cellStart: Uint32Array
  private readonly cellItems: Uint32Array

  private constructor(
    readonly columns: number,
    readonly rows: number,
    readonly xDomain: readonly [number, number],
    cellStart: Uint32Array,
    cellItems: Uint32Array,
    private readonly geometry: Geometry,
    /** stateId → row, as the index was built with. */
    private readonly rowOf: Float32Array,
  ) {
    this.cellStart = cellStart
    this.cellItems = cellItems
  }

  static build(
    geometry: Geometry,
    rowCount: number,
    xDomain: readonly [number, number],
    /** stateId → row; `geometry.positions` carries ids, not rows. */
    rowOf: Float32Array,
    columns = 256,
  ): SegmentIndex {
    const rows = Math.max(1, rowCount)
    const cellCount = columns * rows
    const counts = new Uint32Array(cellCount + 1)

    const [x0, x1] = xDomain
    const span = Math.max(x1 - x0, 1e-6)
    const { positions, segmentCount } = geometry

    const columnOf = (x: number): number => {
      const c = Math.floor(((x - x0) / span) * columns)
      return c < 0 ? 0 : c >= columns ? columns - 1 : c
    }
    const rowClamp = (r: number): number => (r < 0 ? 0 : r >= rows ? rows - 1 : r)
    const rowAt = (stateId: number): number => rowClamp(Math.round(rowOf[stateId] ?? 0))

    // Pass 1 — count occupancy per cell.
    for (let s = 0; s < segmentCount; s++) {
      const p = s * 4
      const cA = columnOf(positions[p] as number)
      const cB = columnOf(positions[p + 2] as number)
      const rA = rowAt(positions[p + 1] as number)
      const rB = rowAt(positions[p + 3] as number)

      for (let c = Math.min(cA, cB); c <= Math.max(cA, cB); c++) {
        for (let r = Math.min(rA, rB); r <= Math.max(rA, rB); r++) {
          counts[r * columns + c + 1] = (counts[r * columns + c + 1] as number) + 1
        }
      }
    }

    // Prefix sum → cell start offsets.
    for (let i = 1; i <= cellCount; i++) {
      counts[i] = (counts[i] as number) + (counts[i - 1] as number)
    }
    const cellStart = counts
    const cursor = cellStart.slice(0, cellCount)
    const cellItems = new Uint32Array(cellStart[cellCount] as number)

    // Pass 2 — fill.
    for (let s = 0; s < segmentCount; s++) {
      const p = s * 4
      const cA = columnOf(positions[p] as number)
      const cB = columnOf(positions[p + 2] as number)
      const rA = rowAt(positions[p + 1] as number)
      const rB = rowAt(positions[p + 3] as number)

      for (let c = Math.min(cA, cB); c <= Math.max(cA, cB); c++) {
        for (let r = Math.min(rA, rB); r <= Math.max(rA, rB); r++) {
          const cell = r * columns + c
          cellItems[cursor[cell] as number] = s
          cursor[cell] = (cursor[cell] as number) + 1
        }
      }
    }

    return new SegmentIndex(columns, rows, xDomain, cellStart, cellItems, geometry, rowOf)
  }

  /**
   * Nearest segment to a data-space point, or `null` beyond `maxDistance`.
   * Distances are measured in *normalised* space (x scaled to 0–1, y in rows)
   * so the result does not depend on the current pixel size of the chart.
   */
  pick(
    x: number,
    row: number,
    maxDistance: number,
  ): { segment: number; patient: number; event: number; distance: number } | null {
    const [x0, x1] = this.xDomain
    const span = Math.max(x1 - x0, 1e-6)
    const nx = (x - x0) / span

    const column = Math.floor(nx * this.columns)
    const nearestRow = Math.round(row)

    let bestSegment = -1
    let bestDistance = maxDistance

    const { positions, segmentPatient, segmentEvent } = this.geometry
    // The pointer can sit between cells, so sweep one ring of neighbours.
    for (let c = column - 1; c <= column + 1; c++) {
      if (c < 0 || c >= this.columns) continue
      for (let r = nearestRow - 1; r <= nearestRow + 1; r++) {
        if (r < 0 || r >= this.rows) continue

        const cell = r * this.columns + c
        const start = this.cellStart[cell] as number
        const end = this.cellStart[cell + 1] as number

        for (let i = start; i < end; i++) {
          const s = this.cellItems[i] as number
          const p = s * 4
          const ax = ((positions[p] as number) - x0) / span
          const ay = this.rowOf[positions[p + 1] as number] ?? 0
          const bx = ((positions[p + 2] as number) - x0) / span
          const by = this.rowOf[positions[p + 3] as number] ?? 0

          const distance = pointToSegment(nx, row, ax, ay, bx, by)
          if (distance < bestDistance) {
            bestDistance = distance
            bestSegment = s
          }
        }
      }
    }

    if (bestSegment === -1) return null
    return {
      segment: bestSegment,
      patient: segmentPatient[bestSegment] as number,
      event: segmentEvent[bestSegment] as number,
      distance: bestDistance,
    }
  }
}

function pointToSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax
  const dy = by - ay
  const lengthSquared = dx * dx + dy * dy

  if (lengthSquared === 0) return Math.hypot(px - ax, py - ay)

  let t = ((px - ax) * dx + (py - ay) * dy) / lengthSquared
  t = t < 0 ? 0 : t > 1 ? 1 : t

  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
}
