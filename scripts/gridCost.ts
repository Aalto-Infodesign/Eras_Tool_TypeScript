/**
 * What the small-multiples grid actually draws, and what sampling saves.
 *
 *   npx tsx scripts/gridCost.ts public/data/generated/data_250k.json
 *
 * The grid opens on the biggest typologies, which is the worst case by
 * construction: on both sample datasets one cohort is several times the size of
 * the next, and it was being drawn in full into a panel a few hundred pixels
 * across. This prints the segment counts the panels carry at each budget, which
 * is what the paint loop pays for.
 */

import { readFileSync } from "node:fs"

import { buildGeometry } from "../src/core/render/geometry.ts"
import { buildPalette } from "../src/core/render/palette.ts"
import { ingest } from "../src/core/parse/ingest.ts"
import { buildTypologies } from "../src/core/stats/typologies.ts"

const path = process.argv[2] ?? "public/data/data_25k.json"
const { store } = ingest(readFileSync(path, "utf8"), path)
const typologies = buildTypologies(store)

/** `MAX_PANELS` in `SmallMultiples`. */
const PANELS = 24
const shown = typologies.slice(0, PANELS)

const options = {
  axis: "age" as const,
  color: { kind: "state" as const, palette: buildPalette(store.stateNames.length) },
  rowsFrom: "position" as const,
}

console.log(
  `${path} — ${store.patientCount.toLocaleString()} patients, ${typologies.length.toLocaleString()} typologies`,
)
console.log(`biggest ${PANELS}: ${shown.map((t) => t.size.toLocaleString()).join(", ")}\n`)

for (const budget of [Infinity, 4000, 1200]) {
  let segments = 0
  let drawnTotal = 0

  const t = performance.now()
  for (const typology of shown) {
    const members = Array.from(typology.patients)
    const stride = Math.max(1, Math.ceil(members.length / budget))
    const drawn = stride === 1 ? members : members.filter((_, i) => i % stride === 0)
    drawnTotal += drawn.length
    segments += buildGeometry(store, Uint32Array.from(drawn), options).segmentCount
  }

  const label = budget === Infinity ? "unsampled" : `budget ${budget}`
  console.log(
    `${label.padEnd(14)} ${drawnTotal.toLocaleString().padStart(9)} patients  ` +
      `${segments.toLocaleString().padStart(9)} segments  ` +
      `build ${(performance.now() - t).toFixed(1)}ms`,
  )
}
