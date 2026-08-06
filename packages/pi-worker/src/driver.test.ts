import assert from "node:assert/strict"
import test from "node:test"
import { getDriverMode } from "./driver.js"

test("getDriverMode accepts the native Pi driver aliases", () => {
  for (const value of ["pi", "1", "true", "real", "PI"]) {
    assert.equal(getDriverMode({ PIUI_DRIVER: value }), "pi")
  }
  assert.equal(getDriverMode({ PIUI_DRIVER: "mock" }), "mock")
  assert.equal(getDriverMode({}), "mock")
})

test("getDriverMode rejects unknown configuration instead of silently using mock", () => {
  assert.throws(() => getDriverMode({ PIUI_DRIVER: "typo" }), /PIUI_DRIVER/)
})
