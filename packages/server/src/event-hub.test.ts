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
