import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { listModelsForUi } from "./models.ts"

describe("listModelsForUi", () => {
  it("returns mock model when driver is mock", async () => {
    const prev = process.env.PIUI_DRIVER
    process.env.PIUI_DRIVER = "mock"
    try {
      const r = await listModelsForUi()
      assert.equal(r.driver, "mock")
      assert.ok(r.models.length >= 1)
      assert.equal(r.models[0]?.id, "mock")
    } finally {
      if (prev === undefined) delete process.env.PIUI_DRIVER
      else process.env.PIUI_DRIVER = prev
    }
  })
})
