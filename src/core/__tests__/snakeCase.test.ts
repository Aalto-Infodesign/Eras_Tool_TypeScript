import { describe, expect, it } from "vitest"

import { snakeCase } from "../util/snakeCase.ts"

describe("snakeCase", () => {
  it("keeps an all-caps label whole", () => {
    expect(snakeCase("DX")).toBe("dx")
    expect(snakeCase("SLEEP PROBLEMS")).toBe("sleep_problems")
    expect(snakeCase("SLEEP_PROBLEMS")).toBe("sleep_problems")
    expect(snakeCase("LOSS-OF-INDEP")).toBe("loss_of_indep")
  })

  it("splits camel case, and a capital run from the word after it", () => {
    expect(snakeCase("sleepProblems")).toBe("sleep_problems")
    expect(snakeCase("GaitTremorProblems")).toBe("gait_tremor_problems")
    expect(snakeCase("XMLHttp")).toBe("xml_http")
  })

  it("leaves an already normalised label alone", () => {
    expect(snakeCase("loss_of_indep")).toBe("loss_of_indep")
    expect(snakeCase("dx")).toBe("dx")
  })

  it("separates on punctuation and digits, as lodash does", () => {
    expect(snakeCase("Parkinson's disease")).toBe("parkinson_s_disease")
    expect(snakeCase("  Stage 2  ")).toBe("stage_2")
    expect(snakeCase("stage2")).toBe("stage_2")
  })

  it("keeps accented letters", () => {
    expect(snakeCase("Päivä HOITO")).toBe("päivä_hoito")
    expect(snakeCase("ÉTAT")).toBe("état")
  })
})
