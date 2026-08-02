import assert from "node:assert/strict"
import test from "node:test"
import { shouldRequireVerifiedSdk } from "./sdk-host.ts"

test("external SDK verification is strict unless explicitly disabled", () => {
  assert.equal(shouldRequireVerifiedSdk({}), true)
  assert.equal(shouldRequireVerifiedSdk({ PIUI_SDK_STRICT: "1" }), true)
  assert.equal(shouldRequireVerifiedSdk({ PIUI_SDK_STRICT: "0" }), false)
})
