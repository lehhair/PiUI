import assert from "node:assert/strict"
import test from "node:test"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { SessionRuntimeRegistry } from "./session-registry.ts"

test("SessionRuntimeRegistry coalesces concurrent opens for one session file", async () => {
  const registry = new SessionRuntimeRegistry()
  let calls = 0
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })

  const first = registry.openFlight(join(tmpdir(), "session.jsonl"), async () => {
    calls += 1
    await gate
    return "opened"
  })
  const second = registry.openFlight(join(tmpdir(), "session.jsonl").replaceAll("/", "\\"), async () => "wrong")

  release()
  assert.equal(await first, "opened")
  assert.equal(await second, "opened")
  assert.equal(calls, 1)
})

test("SessionRuntimeRegistry removes completed attach flights", async () => {
  const registry = new SessionRuntimeRegistry()
  let calls = 0
  const operation = async () => {
    calls += 1
    return { sessionId: "session", cwd: ".", worker: undefined as never }
  }

  await registry.attachFlight("session", operation)
  await registry.attachFlight("session", operation)
  assert.equal(calls, 2)
})
