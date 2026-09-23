/**
 * Matches the normalisation the original applied via lodash `snakeCase`, but
 * memoised: the old pipeline called it once per event (millions of calls over a
 * large file) even though a dataset only ever holds a few dozen distinct labels.
 */
const cache = new Map<string, string>()

export function snakeCase(input: string): string {
  const hit = cache.get(input)
  if (hit !== undefined) return hit

  const out = input
    .replace(/\W+/g, " ")
    .split(/ |\B(?=[A-Z])/)
    .filter((w) => w.length > 0)
    .map((w) => w.toLowerCase())
    .join("_")

  cache.set(input, out)
  return out
}
