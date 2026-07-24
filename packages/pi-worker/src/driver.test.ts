import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { getDriverMode } from "./index.js"

describe("getDriverMode", () => {
  it("defaults to mock", () => {
    assert.equal(getDriverMode({}), "mock")
    assert.equal(getDriverMode({ PIUI_DRIVER: "mock" }), "mock")
  })

  it("enables pi when requested", () => {
    assert.equal(getDriverMode({ PIUI_DRIVER: "pi" }), "pi")
    assert.equal(getDriverMode({ PIUI_USE_REAL_PI: "1" }), "pi")
    assert.equal(getDriverMode({ PIUI_DRIVER: "real" }), "pi")
  })
})
