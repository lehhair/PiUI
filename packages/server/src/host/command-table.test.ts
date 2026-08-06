import assert from "node:assert/strict"
import { test } from "node:test"
import { HOST_COMMAND_SPECS } from "@piui/protocol"
import { HOST_CAPABILITIES, HostRuntime } from "./command-table.ts"

test("host capabilities bind exactly the declared command specs", () => {
  const declared = HOST_COMMAND_SPECS.map(spec => spec.name).sort()
  const bound = HOST_CAPABILITIES.map(item => item.capability.name).sort()
  assert.deepEqual(bound, declared)
  for (const item of HOST_CAPABILITIES) {
    assert.equal(typeof item.handler, "function", `${item.capability.name} is missing a handler`)
  }
})

test("execute rejects malformed params at the edge before reaching handlers", async () => {
  const runtime = new HostRuntime({} as never)
  await assert.rejects(
    runtime.execute("git.diff", { workspacePath: 42 } as never),
    (error: Error & { code?: string }) => error.code === "INVALID_REQUEST" && /workspacePath must be a string/.test(error.message),
  )
  await assert.rejects(
    runtime.execute("terminals.create", {} as never),
    (error: Error & { code?: string }) => error.code === "INVALID_REQUEST",
  )
})
