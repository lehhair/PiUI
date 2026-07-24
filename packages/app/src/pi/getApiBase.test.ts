import { describe, expect, it } from "vitest"
import { getApiBase } from "./sessionApi"

describe("getApiBase", () => {
  it("uses empty base in browser so Vite proxy can work", () => {
    // vitest jsdom has window
    expect(getApiBase()).toBe("")
  })
})
