/** Timing probes. The old code used console.time; these are collectable. */

export interface Timing {
  readonly label: string
  readonly ms: number
}

export class Stopwatch {
  private readonly marks: Timing[] = []

  measure<T>(label: string, fn: () => T): T {
    const t0 = performance.now()
    const result = fn()
    this.marks.push({ label, ms: performance.now() - t0 })
    return result
  }

  add(label: string, ms: number): void {
    this.marks.push({ label, ms })
  }

  get timings(): readonly Timing[] {
    return this.marks
  }

  get total(): number {
    return this.marks.reduce((sum, m) => sum + m.ms, 0)
  }
}
