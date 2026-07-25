import assert from "node:assert/strict"
import test from "node:test"
import type { CommandRecordV1 } from "@piui/protocol"
import { SessionExecutor } from "./session-executor.ts"

test("SessionExecutor serializes one session and keeps sessions independent", async () => {
  const executor = new SessionExecutor()
  const order: string[] = []
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })

  const first = executor.submit("a", "one", "prompt", async () => {
    order.push("a1:start")
    await gate
    order.push("a1:end")
    return 1
  })
  const second = executor.submit("a", "two", "compact", async () => {
    order.push("a2")
    return 2
  })
  const other = executor.submit("b", "three", "prompt", async () => {
    order.push("b1")
    return 3
  })

  await other.promise
  assert.deepEqual(order, ["a1:start", "b1"])
  release()
  assert.deepEqual(await Promise.all([first.promise, second.promise]), [1, 2])
  assert.deepEqual(order, ["a1:start", "b1", "a1:end", "a2"])
})

test("SessionExecutor reuses commandId and records failures", async () => {
  const executor = new SessionExecutor()
  let calls = 0
  const first = executor.submit("a", "same", "prompt", async () => ++calls)
  const duplicate = executor.submit("a", "same", "prompt", async () => ++calls)
  assert.equal(await duplicate.promise, 1)
  assert.equal(first.promise, duplicate.promise)
  assert.equal(calls, 1)
  assert.equal(executor.get("same")?.status, "completed")

  const failed = executor.submit("a", "failed", "compact", async () => {
    throw Object.assign(new Error("bad"), { code: "INVALID_REQUEST" })
  })
  await assert.rejects(failed.promise, /bad/)
  assert.deepEqual(executor.get("failed")?.error, { code: "INVALID_REQUEST", message: "bad" })
})

test("SessionExecutor emits immutable command status updates", async () => {
  const updates: CommandRecordV1[] = []
  const executor = new SessionExecutor(record => updates.push(record))

  const command = executor.submit("session-a", "command-events", "prompt", async () => "done")
  await command.promise

  assert.deepEqual(updates.map(update => update.status), ["accepted", "running", "completed"])
  assert.equal(updates[0]?.status, "accepted")
  assert.equal(updates[0]?.startedAt, undefined)
  assert.equal(updates[2]?.completedAt !== undefined, true)
})
