import assert from "node:assert/strict"
import test from "node:test"
import type { CommandRecordV2, CommandRequestV2, CommandTypeV2 } from "@piui/protocol"
import { SessionExecutor } from "./session-executor.ts"

function request<T extends CommandTypeV2>(
  commandId: string,
  sessionId: string,
  type: T,
  concurrency: CommandRequestV2<T>["concurrency"],
  payload: CommandRequestV2<T>["payload"],
): CommandRequestV2<T> {
  return { protocolVersion: 2, commandId, sessionId, type, concurrency, payload }
}

test("SessionExecutor serializes idle commands and keeps sessions independent", async () => {
  const executor = new SessionExecutor()
  const order: string[] = []
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })

  const first = executor.submit(
    request("one", "a", "session.prompt", "idle-only", { text: "one" }),
    async () => {
      order.push("a1:start")
      await gate
      order.push("a1:end")
      return 1
    },
  )
  const second = executor.submit(
    request("two", "a", "session.compact", "idle-only", {}),
    async () => { order.push("a2"); return 2 },
  )
  const other = executor.submit(
    request("three", "b", "session.prompt", "idle-only", { text: "three" }),
    async () => { order.push("b1"); return 3 },
  )

  await other.promise
  assert.deepEqual(order, ["a1:start", "b1"])
  release()
  assert.deepEqual(await Promise.all([first.promise, second.promise]), [1, 2])
  assert.deepEqual(order, ["a1:start", "b1", "a1:end", "a2"])
})

test("SessionExecutor runs control commands without waiting for idle work", async () => {
  const executor = new SessionExecutor()
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const prompt = executor.submit(
    request("prompt", "a", "session.prompt", "idle-only", { text: "work" }),
    async () => { await gate },
  )
  let controlled = false
  const control = executor.submit(
    request("follow-up", "a", "session.followUp", "run-control", { text: "next" }),
    async () => { controlled = true },
  )

  await control.promise
  assert.equal(controlled, true)
  release()
  await prompt.promise
})

test("SessionExecutor reuses commandId and records failures", async () => {
  const executor = new SessionExecutor()
  let calls = 0
  const input = request("same", "a", "session.prompt", "idle-only", { text: "same" })
  const first = executor.submit(input, async () => ++calls)
  const duplicate = executor.submit(input, async () => ++calls)
  assert.equal(await duplicate.promise, 1)
  assert.equal(first.promise, duplicate.promise)
  assert.equal(calls, 1)
  assert.equal(executor.get("same")?.status, "completed")

  const failed = executor.submit(
    request("failed", "a", "session.compact", "idle-only", {}),
    async () => { throw Object.assign(new Error("bad"), { code: "INVALID_REQUEST" }) },
  )
  await assert.rejects(failed.promise, /bad/)
  assert.deepEqual(executor.get("failed")?.error, { code: "INVALID_REQUEST", message: "bad" })
})

test("SessionExecutor emits immutable command status updates", async () => {
  const updates: CommandRecordV2[] = []
  const executor = new SessionExecutor(record => updates.push(record))
  const command = executor.submit(
    request("command-events", "session-a", "session.prompt", "idle-only", { text: "done" }),
    async () => "done",
  )
  await command.promise

  assert.deepEqual(updates.map(update => update.status), ["accepted", "running", "completed"])
  assert.equal(updates[0]?.startedAt, undefined)
  assert.equal(updates[2]?.completedAt !== undefined, true)
})

test("SessionExecutor invalidates running and queued commands after a runtime crash", async () => {
  const executor = new SessionExecutor()
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let queuedRan = false
  const running = executor.submit(
    request("running", "session-a", "session.prompt", "idle-only", { text: "running" }),
    async () => { await gate },
  )
  const queued = executor.submit(
    request("queued", "session-a", "session.prompt", "idle-only", { text: "queued" }),
    async () => { queuedRan = true },
  )
  await new Promise<void>(resolve => setImmediate(resolve))

  executor.markRuntimeCrashed("session-a")
  assert.equal(executor.get("running")?.status, "unknown_after_crash")
  assert.equal(executor.get("queued")?.status, "cancelled")
  release()
  const results = await Promise.allSettled([running.promise, queued.promise])
  assert.deepEqual(results.map(result => result.status), ["rejected", "rejected"])
  assert.equal(queuedRan, false)
  assert.equal(executor.get("running")?.status, "unknown_after_crash")
  assert.equal(executor.get("queued")?.status, "cancelled")
})
