import assert from "node:assert/strict"
import test from "node:test"
import type { CommandEnvelope } from "@piui/protocol"
import { SessionExecutor } from "./session-executor.ts"

function envelope(id: string, sessionId: string | undefined, type: string, params?: CommandEnvelope["params"]): CommandEnvelope {
  return { id, sessionId, type, params }
}

test("SessionExecutor serializes session commands and keeps sessions independent", async () => {
  const executor = new SessionExecutor()
  const order: string[] = []
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })

  const first = executor.submit(envelope("one", "a", "prompt"), async () => {
    order.push("a1:start")
    await gate
    order.push("a1:end")
    return 1
  })
  const second = executor.submit(envelope("two", "a", "compact"), async () => {
    order.push("a2")
    return 2
  })
  const other = executor.submit(envelope("three", "b", "prompt"), async () => {
    order.push("b1")
    return 3
  })

  await other.promise
  assert.deepEqual(order, ["a1:start", "b1"])
  assert.equal(second.record.status === "completed", false)
  release()
  await first.promise
  await second.promise
  assert.deepEqual(order, ["a1:start", "b1", "a1:end", "a2"])
  assert.equal(first.record.status, "completed")
  assert.equal(first.record.result, 1)
})

test("SessionExecutor runs catalog commands without waiting for session work", async () => {
  const executor = new SessionExecutor()
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const order: string[] = []

  const prompt = executor.submit(envelope("one", "a", "prompt"), async () => {
    order.push("prompt")
    await gate
    return undefined
  })
  const catalog = executor.submit(envelope("two", undefined, "session.list"), async () => {
    order.push("catalog")
    return undefined
  })

  await catalog.promise
  assert.deepEqual(order, ["prompt", "catalog"])
  release()
  await prompt.promise
})

test("SessionExecutor reuses command id and records failures", async () => {
  const executor = new SessionExecutor()
  let calls = 0
  const run = async () => {
    calls += 1
    if (calls === 1) return "first"
    return "second"
  }
  const env = envelope("same", "a", "prompt")
  const first = executor.submit(env, run)
  const second = executor.submit(env, run)
  assert.equal(second.reused, true)
  await first.promise
  await second.promise
  assert.equal(calls, 1)

  const failed = executor.submit(envelope("bad", "a", "prompt"), async () => {
    throw Object.assign(new Error("boom"), { code: "INVALID_REQUEST" })
  })
  await assert.rejects(failed.promise)
  assert.equal(failed.record.status, "failed")
  assert.equal(failed.record.error?.code, "INVALID_REQUEST")
})

test("SessionExecutor bounds retained commands and keeps unfinished ones", async () => {
  const executor = new SessionExecutor()
  for (let index = 0; index < 600; index += 1) {
    executor.submit(envelope(`done-${index}`, "a", "compact"), async () => index)
    await executor.get(`done-${index}`)!.status
  }
  await new Promise(resolve => setImmediate(resolve))
  const pending = executor.submit(envelope("pending", "a", "prompt"), () => new Promise(() => undefined))
  for (let index = 600; index < 700; index += 1) {
    await executor.submit(envelope(`later-${index}`, "b", "compact"), async () => index).promise
  }
  assert.ok(executor.get("pending"))
  assert.equal(executor.get("done-0"), undefined)
  void pending
})

test("SessionExecutor invalidates running and queued commands after a runtime crash", async () => {
  const executor = new SessionExecutor()
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const running = executor.submit(envelope("running", "a", "prompt"), async () => {
    await gate
    return "done"
  })
  const queued = executor.submit(envelope("queued", "a", "compact"), async () => "queued")
  await new Promise(resolve => setImmediate(resolve))

  executor.markRuntimeCrashed("a")
  assert.equal(running.record.status, "unknown_after_crash")
  assert.equal(queued.record.status, "cancelled")
  assert.equal(running.record.error?.retryable, true)
  release()
  await assert.rejects(running.promise)
  await assert.rejects(queued.promise)

  const after = executor.submit(envelope("after", "a", "prompt"), async () => "after")
  await after.promise
  assert.equal(after.record.status, "completed")
})

test("SessionExecutor closes a lane by cancelling queued work and interrupting the active command", async () => {
  const executor = new SessionExecutor()
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let started!: () => void
  const activeStarted = new Promise<void>(resolve => { started = resolve })
  let interrupted = false
  let disposed = false

  const active = executor.submit(envelope("active", "a", "prompt"), async () => {
    started()
    await gate
    return "active"
  })
  const queued = executor.submit(envelope("queued", "a", "compact"), async () => "queued")
  await activeStarted
  const closing = executor.close("a", {
    interrupt: async () => {
      interrupted = true
      release()
    },
    dispose: async () => {
      disposed = true
    },
  })

  await closing
  assert.equal(interrupted, true)
  assert.equal(disposed, true)
  assert.equal(await active.promise, "active")
  await assert.rejects(queued.promise, { code: "RUNTIME_CLOSING" })
  assert.equal(executor.isClosing("a"), true)
  assert.throws(
    () => executor.submit(envelope("after", "a", "prompt"), async () => "after"),
    { code: "RUNTIME_CLOSING" },
  )
})

test("SessionExecutor reports pending work for idle runtime reaping", async () => {
  const executor = new SessionExecutor()
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const pending = executor.submit(envelope("pending", "a", "prompt"), async () => {
    await gate
    return undefined
  })

  await new Promise(resolve => setImmediate(resolve))
  assert.equal(executor.hasPendingWork("a"), true)
  release()
  await pending.promise
  assert.equal(executor.hasPendingWork("a"), false)
})

test("SessionExecutor allows a detached session to be attached again", async () => {
  const executor = new SessionExecutor()
  const command = executor.submit(envelope("first", "a", "prompt"), async () => undefined)
  await command.promise
  await executor.close("a", { dispose: async () => undefined })
  assert.throws(
    () => executor.submit(envelope("blocked", "a", "prompt"), async () => undefined),
    { code: "RUNTIME_CLOSING" },
  )

  executor.resetSession("a")
  const reopened = executor.submit(envelope("reopened", "a", "prompt"), async () => "ok")
  assert.equal(await reopened.promise, "ok")
})
