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

  it("returns the complete Pi-native model without mapping it", async () => {
    const model = {
      id: "reasoning-model",
      name: "Reasoning model",
      api: "test-api",
      provider: "test",
      baseUrl: "https://example.test",
      reasoning: true,
      thinkingLevelMap: { xhigh: "xhigh" },
      input: ["text", "image"] as Array<"text" | "image">,
      cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
      contextWindow: 100,
      maxTokens: 10,
      compat: { custom: true },
      futureField: { retained: true },
    }
    const result = await listModelsForUi("pi", async () => [model])

    assert.deepEqual(result.models[0], model)
  })
})
