import assert from "node:assert/strict"
import test from "node:test"
import { EventHub } from "./event-hub.ts"

test("EventHub replays retained events and requires resync for stale cursors", () => {
  const hub = new EventHub(2)
  const stream = { kind: "session" as const, id: "one" }
  const initial = hub.getCursor(stream)
  hub.publish(stream, "pi.event", { seq: 1 })
  const afterOne = hub.getCursor(stream)
  hub.publish(stream, "pi.event", { seq: 2 })
  hub.publish(stream, "pi.event", { seq: 3 })

  const replay = hub.replaySince(stream, afterOne)
  assert.equal(replay.resyncRequired, false)
  assert.deepEqual(replay.events.map(event => (event.payload as { seq: number }).seq), [2, 3])
  assert.equal(hub.replaySince(stream, initial).reason, "history_expired")
  assert.equal(hub.replaySince(stream, { epoch: "old-server", sequence: 0 }).reason, "epoch_mismatch")
  assert.equal(hub.replaySince(stream).reason, "missing_cursor")
})

test("EventHub keeps sequence and history independent per stream", () => {
  const hub = new EventHub(2)
  const one = { kind: "session" as const, id: "one" }
  const two = { kind: "session" as const, id: "two" }
  const oneStart = hub.getCursor(one)
  const twoStart = hub.getCursor(two)

  hub.publish(one, "command.updated", { commandId: "one-1" })
  hub.publish(two, "command.updated", { commandId: "two-1" })
  hub.publish(one, "command.updated", { commandId: "one-2" })

  assert.equal(hub.getCursor(one).sequence, 2)
  assert.equal(hub.getCursor(two).sequence, 1)
  assert.deepEqual(
    hub.replaySince(two, twoStart).events.map(event => (event.payload as { commandId?: string }).commandId),
    ["two-1"],
  )

  hub.publish(one, "command.updated", { commandId: "one-3" })
  assert.equal(hub.replaySince(one, oneStart).reason, "history_expired")
  assert.equal(hub.replaySince(two, twoStart).resyncRequired, false)
})

test("EventHub resets only the selected stream", () => {
  const hub = new EventHub()
  const server = { kind: "server" as const, id: "server" }
  const session = { kind: "session" as const, id: "session-1" }

  hub.publish(server, "sessions.updated", { seq: 1 })
  hub.publish(session, "pi.event", { seq: 1 })
  const serverCursor = hub.getCursor(server)

  hub.resetEpoch(session)
  assert.equal(hub.getCursor(session).sequence, 0)
  assert.equal(hub.replaySince(session).reason, "missing_cursor")

  hub.publish(server, "sessions.updated", { seq: 2 })
  const replay = hub.replaySince(server, serverCursor)
  assert.equal(replay.resyncRequired, false)
  assert.deepEqual(replay.events.map(event => (event.payload as { seq: number }).seq), [2])
})

test("EventHub notifies subscribers", () => {
  const hub = new EventHub()
  const stream = { kind: "session" as const, id: "one" }
  const seen: string[] = []
  const off = hub.subscribe(event => {
    if (event.channel === "pi.event") seen.push(String((event.payload as { seq: number }).seq))
  })
  hub.publish(stream, "pi.event", { seq: 1 })
  hub.publish(stream, "session.head", { seq: 2 })
  off()
  hub.publish(stream, "pi.event", { seq: 3 })
  assert.deepEqual(seen, ["1"])
})
