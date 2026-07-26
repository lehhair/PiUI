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

  it("returns Pi-native thinking levels with each model", async () => {
    const result = await listModelsForUi("pi", async () => [{
      id: "reasoning-model",
      name: "Reasoning model",
      providerId: "test",
      family: "test",
      contextLimit: 100,
      outputLimit: 10,
      supportsReasoning: true,
      thinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh"],
      supportsImages: false,
    }])

    assert.deepEqual(result.models[0]?.variants, ["off", "minimal", "low", "medium", "high", "xhigh"])
  })
})
