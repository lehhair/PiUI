import { describe, expect, it } from "vitest"
import { getApiBase } from "./httpClient"

describe("getApiBase", () => {
  it("uses empty base in browser so Vite proxy can work", () => {
    // vitest jsdom has window
    expect(getApiBase()).toBe("")
  })
})
