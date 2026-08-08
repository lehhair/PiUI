import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { readEffectiveSettings } from "./catalog.ts"

describe("readEffectiveSettings", () => {
  it("returns the effective settings object when present", () => {
    const settings = { defaultProvider: "anthropic", compaction: { enabled: true } }
    assert.deepEqual(readEffectiveSettings({ settings }, "0.84.0"), settings)
  })

  it("fails loud with the SDK version when the effective object is missing or malformed", () => {
    assert.throws(
      () => readEffectiveSettings({}, "0.99.0"),
      error => {
        const message = error instanceof Error ? error.message : String(error)
        return (error as { code?: string }).code === "PI_SDK_INCOMPATIBLE"
          && message.includes("0.99.0")
          && message.includes("settings")
      },
    )
    assert.throws(() => readEffectiveSettings({ settings: null }, "0.84.0"), { code: "PI_SDK_INCOMPATIBLE" })
    assert.throws(() => readEffectiveSettings({ settings: [] }, "0.84.0"), { code: "PI_SDK_INCOMPATIBLE" })
  })
})
