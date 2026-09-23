/**
 * RFC 4180 reader for tab- and comma-separated event tables.
 *
 * Same contract as the original `dataHelpers.readDelimitedRows`, but it slices
 * fields out of the source string instead of accumulating them character by
 * character (`field += c`). That inner loop was O(n) *allocations* over the file
 * — on an 8 MB import it dominates parse time. Here the unquoted fast path does
 * one `slice` per field and quotes are only re-assembled when actually escaped.
 */

export type Delimiter = "\t" | ","

/** Sniffed from the header rather than the extension, so a generic `.txt` still parses. */
export function sniffDelimiter(header: string): Delimiter {
  let commas = 0
  let tabs = 0
  for (let i = 0; i < header.length; i++) {
    const c = header.charCodeAt(i)
    if (c === 44) commas++
    else if (c === 9) tabs++
  }
  return commas > tabs ? "," : "\t"
}

const QUOTE = 34
const CR = 13
const LF = 10

export function readRows(text: string, delimiter: Delimiter): string[][] {
  const delim = delimiter.charCodeAt(0)
  const rows: string[][] = []
  let row: string[] = []

  const len = text.length
  let i = 0

  while (i < len) {
    let field: string

    if (text.charCodeAt(i) === QUOTE) {
      // Quoted field: scan to the closing quote, handling "" escapes.
      i += 1
      const start = i
      let parts: string[] | null = null

      for (;;) {
        const next = text.indexOf('"', i)
        if (next === -1) {
          field = parts ? parts.join("") + text.slice(i) : text.slice(start)
          i = len
          break
        }
        if (text.charCodeAt(next + 1) === QUOTE) {
          parts ??= []
          parts.push(text.slice(i, next + 1)) // keep one of the two quotes
          i = next + 2
          continue
        }
        const tail = text.slice(i, next)
        field = parts ? parts.join("") + tail : text.slice(start, next)
        i = next + 1
        break
      }
    } else {
      // Unquoted fast path: run to the next delimiter or line break.
      const start = i
      while (i < len) {
        const c = text.charCodeAt(i)
        if (c === delim || c === LF || c === CR) break
        i += 1
      }
      field = text.slice(start, i)
    }

    row.push(field)

    const c = text.charCodeAt(i)
    if (c === delim) {
      i += 1
    } else if (c === CR || c === LF) {
      rows.push(row)
      row = []
      i += c === CR && text.charCodeAt(i + 1) === LF ? 2 : 1
    } else {
      break // end of input
    }
  }

  if (row.length > 0) rows.push(row)
  return rows
}

/** Raw cell table (header row included). Strips a UTF-8 BOM if present. */
export function readDelimitedRows(text: string): string[][] {
  const clean = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const firstBreak = clean.search(/\r|\n/)
  const header = firstBreak === -1 ? clean : clean.slice(0, firstBreak)
  return readRows(clean, sniffDelimiter(header))
}
