import { asState, type StateId } from "../types.ts"
import { snakeCase } from "../util/snakeCase.ts"

/**
 * Interns state labels to `Uint16` ids.
 *
 * Every comparison and grouping downstream then works on integers: a typology
 * key becomes a hash over ids rather than `trajectory.join("-")`, and the state
 * column fits in 2 bytes per event instead of a string pointer.
 */
export class StateVocabulary {
  private readonly byName = new Map<string, StateId>()
  private readonly names: string[] = []

  /** Interns the *normalised* form of `raw`, returning a stable id. */
  intern(raw: string): StateId {
    const name = snakeCase(raw)
    const existing = this.byName.get(name)
    if (existing !== undefined) return existing

    if (this.names.length >= 0xffff) {
      throw new RangeError(`State vocabulary exceeded ${0xffff} entries`)
    }
    const id = asState(this.names.length)
    this.names.push(name)
    this.byName.set(name, id)
    return id
  }

  lookup(name: string): StateId | undefined {
    return this.byName.get(snakeCase(name))
  }

  nameOf(id: StateId): string {
    const name = this.names[id]
    if (name === undefined) throw new RangeError(`Unknown state id ${id}`)
    return name
  }

  get size(): number {
    return this.names.length
  }

  toArray(): readonly string[] {
    return this.names.slice()
  }
}
