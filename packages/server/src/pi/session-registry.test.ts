import assert from "node:assert/strict"
import test from "node:test"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { SessionRuntimeRegistry } from "./session-registry.ts"

// 反斜杠变体归并是 Windows 路径语义；POSIX 上 \ 是合法文件名字符，两个
// 键本来就不同，这个用例只在 win32 有意义
test("SessionRuntimeRegistry coalesces concurrent opens for one session file", { skip: process.platform !== "win32" }, async () => {
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

test("SessionRuntimeRegistry aborts an open only after its last waiter leaves", async () => {
  const registry = new SessionRuntimeRegistry()
  const firstController = new AbortController()
  const secondController = new AbortController()
  let aborted = false

  const operation = registry.openFlight("shared-session.jsonl", async signal => {
    await new Promise<void>((_, reject) => {
      signal.addEventListener("abort", () => {
        aborted = true
        reject(Object.assign(new Error("open aborted"), { code: "REQUEST_ABORTED" }))
      }, { once: true })
    })
    return "opened"
  }, firstController.signal)
  const second = registry.openFlight("shared-session.jsonl", async () => "wrong", secondController.signal)

  firstController.abort()
  await assert.rejects(operation, { code: "REQUEST_ABORTED" })
  assert.equal(aborted, false)

  secondController.abort()
  await assert.rejects(second, { code: "REQUEST_ABORTED" })
  assert.equal(aborted, true)
})

test("SessionRuntimeRegistry does not reuse an open flight after its last waiter aborts", async () => {
  const registry = new SessionRuntimeRegistry()
  const controller = new AbortController()
  let calls = 0

  const first = registry.openFlight("abandoned-session.jsonl", async signal => {
    calls += 1
    if (signal.aborted) throw Object.assign(new Error("open aborted"), { code: "REQUEST_ABORTED" })
    return "first"
  }, controller.signal)

  controller.abort()
  await assert.rejects(first, { code: "REQUEST_ABORTED" })
  assert.equal(await registry.openFlight("abandoned-session.jsonl", async () => {
    calls += 1
    return "second"
  }), "second")
  assert.equal(calls, 2)
})
