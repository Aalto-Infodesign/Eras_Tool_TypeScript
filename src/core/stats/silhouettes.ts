import type { IdColumn } from "../model/IdColumn.ts"
import type { Typology } from "../types.ts"

/**
 * The operations behind the silhouette cards.
 *
 * A "silhouette" is a typology drawn as its shape: the ordered state sequence
 * plotted against the chart's own row ordering, so a card is a thumbnail of the
 * lines it stands for. Everything here is pure and index-based — the React layer
 * only lays the results out.
 */

/** Distinct state ids in order of first appearance. `A-B-A-C` → `[A, B, C]`. */
export function uniqueStates(states: Uint16Array): number[] {
  const seen = new Set<number>()
  const out: number[] = []
  for (let i = 0; i < states.length; i++) {
    const state = states[i] as number
    if (seen.has(state)) continue
    seen.add(state)
    out.push(state)
  }
  return out
}

/**
 * Reorders the chart's rows so this typology reads top-to-bottom as a staircase.
 *
 * The original's "order states" button, which did `uniq(name.split("-"))` and
 * appended `xor(statesOrder, newOrder)`. That `xor` is a symmetric difference,
 * so it silently *dropped* any state the typology visited twice — the state was
 * in both lists, so it appeared in neither result, and the row vanished from
 * the chart. Here the leftovers are the states not in the sequence, which is
 * what was meant, and they keep their relative order instead of lodash's.
 */
export function orderFromTypology(
  states: Uint16Array,
  current: readonly number[],
): readonly number[] {
  const lead = uniqueStates(states)
  const inLead = new Set(lead)
  // Only states the caller already knows about: a typology can name a state
  // that `current` has since had removed, and inventing a row for it would put
  // an empty band in the chart.
  const known = new Set(current)

  return [...lead.filter((state) => known.has(state)), ...current.filter((s) => !inLead.has(s))]
}

/**
 * How many of each typology's patients survive `mask`, in the same order.
 *
 * One linear pass over every membership list, which together hold each patient
 * exactly once — so this costs one read per patient in the cohort, not one per
 * patient per typology.
 */
export function filteredSizes(
  typologies: readonly Typology[],
  mask: Uint8Array,
): Uint32Array {
  const out = new Uint32Array(typologies.length)

  for (let t = 0; t < typologies.length; t++) {
    const patients = (typologies[t] as Typology).patients
    let live = 0
    for (let i = 0; i < patients.length; i++) {
      if (mask[patients[i] as number] === 1) live += 1
    }
    out[t] = live
  }

  return out
}

/**
 * Patient ids across a set of typologies, for export.
 *
 * `mask` narrows each group to the patients currently passing the filters, which
 * is what the original exported when a filter was live (its `filtered`
 * trajectories); pass `null` to take the groups whole.
 */
export function typologyIds(
  typologies: readonly Typology[],
  ids: IdColumn,
  mask: Uint8Array | null,
): string[] {
  const out: string[] = []
  for (const typology of typologies) {
    const { patients } = typology
    for (let i = 0; i < patients.length; i++) {
      const patient = patients[i] as number
      if (mask === null || mask[patient] === 1) out.push(ids.at(patient))
    }
  }
  return out
}

/**
 * Row labels for one sequence, numbering the repeats: `a`, `b`, `a (2)`, `c`.
 *
 * A focused typology draws a rule per *step*, so a state it revisits appears
 * twice — two rules, same name, same colour. Without the ordinal they read as a
 * duplicate rather than as a return, which is the one thing that view exists to
 * show. Only states that actually repeat are numbered; adding `(1)` to every
 * label would be noise on the sequences that never come back.
 */
export function sequenceLabels(
  states: Uint16Array,
  stateNames: readonly string[],
): string[] {
  const total = new Map<number, number>()
  for (let i = 0; i < states.length; i++) {
    const state = states[i] as number
    total.set(state, (total.get(state) ?? 0) + 1)
  }

  const seen = new Map<number, number>()
  const out: string[] = []

  for (let i = 0; i < states.length; i++) {
    const state = states[i] as number
    const name = stateNames[state] ?? String(state)
    const visit = (seen.get(state) ?? 0) + 1
    seen.set(state, visit)
    out.push((total.get(state) ?? 1) > 1 ? `${name} (${visit})` : name)
  }

  return out
}
