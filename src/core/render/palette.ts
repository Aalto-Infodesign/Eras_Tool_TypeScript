/**
 * State colours as packed RGBA bytes.
 *
 * The chart needs a colour per *vertex* of a million-segment buffer, so the
 * palette is materialised once into a `Uint8Array` the geometry builder can copy
 * from. Resolving `palette[state]` to an `hsl(...)` string per segment — as the
 * SVG version did — would mean a string parse per drawn line.
 */

export interface Palette {
  /** RGBA, 4 bytes per state, indexed by `StateId`. */
  readonly bytes: Uint8Array
  /** CSS strings for legends, labels and the DOM overlay. */
  readonly css: readonly string[]
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = l - c / 2

  let r = 0
  let g = 0
  let b = 0
  if (h < 60) [r, g, b] = [c, x, 0]
  else if (h < 120) [r, g, b] = [x, c, 0]
  else if (h < 180) [r, g, b] = [0, c, x]
  else if (h < 240) [r, g, b] = [0, x, c]
  else if (h < 300) [r, g, b] = [x, 0, c]
  else [r, g, b] = [c, 0, x]

  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)]
}

/**
 * Evenly spaced hues walked by the golden angle rather than sequentially, so
 * adjacent states in the vertical ordering never get adjacent hues.
 */
export function buildPalette(stateCount: number, rotation = 0): Palette {
  const bytes = new Uint8Array(stateCount * 4)
  const css: string[] = new Array<string>(stateCount)

  for (let i = 0; i < stateCount; i++) {
    const hue = (rotation + i * 137.508) % 360
    const saturation = 0.62
    const lightness = 0.55

    const [r, g, b] = hslToRgb(hue, saturation, lightness)
    bytes[i * 4 + 0] = r
    bytes[i * 4 + 1] = g
    bytes[i * 4 + 2] = b
    bytes[i * 4 + 3] = 255
    css[i] = `hsl(${hue.toFixed(1)} ${saturation * 100}% ${lightness * 100}%)`
  }

  return { bytes, css }
}
