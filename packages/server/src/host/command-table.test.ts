import assert from "node:assert/strict"
import { test } from "node:test"
import { HOST_COMMAND_SPECS } from "@piui/protocol"
import { HOST_CAPABILITIES } from "./command-table.ts"

test("host capabilities bind exactly the declared command specs", () => {
  const declared = HOST_COMMAND_SPECS.map(spec => spec.name).sort()
  const bound = HOST_CAPABILITIES.map(item => item.capability.name).sort()
  assert.deepEqual(bound, declared)
  for (const item of HOST_CAPABILITIES) {
    assert.equal(typeof item.handler, "function", `${item.capability.name} is missing a handler`)
  }
})
