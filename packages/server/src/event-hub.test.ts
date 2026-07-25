import assert from "node:assert/strict"
import test from "node:test"
import { EventHub } from "./event-hub.ts"

test("EventHub replays retained events and requires resync for stale cursors", () => {
  const hub = new EventHub(2)
  const initial = hub.getCursor()
  hub.publish({ type: "one", payload: 1 })
  const afterOne = hub.getCursor()
  hub.publish({ type: "two", payload: 2 })
  hub.publish({ type: "three", payload: 3 })

  const replay = hub.replaySince(afterOne)
  assert.equal(replay.resyncRequired, false)
  assert.deepEqual(replay.events.map(event => event.type), ["two", "three"])
  assert.equal(hub.replaySince(initial).resyncRequired, true)
  assert.equal(hub.replaySince({ epoch: "old-server", sequence: 0 }).resyncRequired, true)
})

test("EventHub keeps v2 sequence and history independent per stream", () => {
  const hub = new EventHub(2)
  const one = { kind: "session" as const, id: "one" }
  const two = { kind: "session" as const, id: "two" }
  const oneStart = hub.getCursorV2(one)
  const twoStart = hub.getCursorV2(two)

  hub.publishV2(one, "command.updated", { commandId: "one-1", sessionId: "one", status: "running" })
  hub.publishV2(two, "command.updated", { commandId: "two-1", sessionId: "two", status: "running" })
  hub.publishV2(one, "command.updated", { commandId: "one-2", sessionId: "one", status: "completed" })

  assert.equal(hub.getCursorV2(one).sequence, 2)
  assert.equal(hub.getCursorV2(two).sequence, 1)
  assert.deepEqual(
    hub.replaySinceV2(two, twoStart).events.map(event =>
      (event.payload as { commandId?: string }).commandId),
    ["two-1"],
  )

  hub.publishV2(one, "command.updated", { commandId: "one-3", sessionId: "one", status: "completed" })
  assert.equal(hub.replaySinceV2(one, oneStart).reason, "history_expired")
  assert.equal(hub.replaySinceV2(two, twoStart).resyncRequired, false)
})

test("EventHub resets only the selected v2 stream", () => {
  const hub = new EventHub()
  const server = { kind: "server" as const, id: "server" }
  const session = { kind: "session" as const, id: "session-1" }
  const serverCursor = hub.getCursorV2(server)
  const sessionCursor = hub.getCursorV2(session)

  hub.resetEpochV2(session)

  assert.deepEqual(hub.getCursorV2(server), serverCursor)
  assert.notEqual(hub.getCursorV2(session).epoch, sessionCursor.epoch)
  assert.equal(hub.replaySinceV2(session, sessionCursor).reason, "epoch_mismatch")
})
