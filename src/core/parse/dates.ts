/**
 * Calendar date → fractional year (e.g. 1997-07-02 → 1997.4986).
 *
 * Ported from `numberHelpers.dateToFractionalYear`, with three changes:
 *  - a bare `YYYY` is accepted (the demo TSV's `date` column is just a year);
 *  - an unparseable value returns `null` instead of throwing, so one bad cell
 *    cannot abort a whole import;
 *  - the common ISO / `DD-MM-YYYY` shapes avoid `new Date` string parsing.
 */

const YEAR_MS_CACHE = new Map<number, { start: number; span: number }>()

function yearBounds(year: number): { start: number; span: number } {
  const hit = YEAR_MS_CACHE.get(year)
  if (hit) return hit
  const start = new Date(year, 0, 1).getTime()
  const span = new Date(year + 1, 0, 1).getTime() - start
  const bounds = { start, span }
  YEAR_MS_CACHE.set(year, bounds)
  return bounds
}

function fromDate(date: Date): number | null {
  const time = date.getTime()
  if (Number.isNaN(time)) return null
  const year = date.getFullYear()
  const { start, span } = yearBounds(year)
  return year + (time - start) / span
}

export function dateToFractionalYear(input: string | number | Date): number | null {
  if (input instanceof Date) return fromDate(input)
  if (typeof input === "number") {
    // A plain year (1969) is a year, not a Unix timestamp 1.97s after the epoch.
    if (input > 1000 && input < 3000) return input
    return fromDate(new Date(input))
  }

  const raw = input.trim()
  if (raw === "") return null

  // Bare year — by far the most common case in these files, so check it first.
  if (/^\d{4}(\.\d+)?$/.test(raw)) return Number(raw)

  const normalized = raw.replace(/[./]/g, "-")

  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(normalized)
  if (iso) {
    return fromDate(new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])))
  }

  const european = /^(\d{1,2})-(\d{1,2})-(\d{4})/.exec(normalized)
  if (european) {
    return fromDate(new Date(Number(european[3]), Number(european[2]) - 1, Number(european[1])))
  }

  return fromDate(new Date(raw))
}
