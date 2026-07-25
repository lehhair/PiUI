import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  PI_CAPABILITY_IDS,
  PI_PARITY_SDK_VERSION,
  PROTOCOL_V2,
  SUPPORTED_PROTOCOL_VERSIONS,
  eventStreamKeyV2,
  parseEventStreamKeyV2,
  type EventEnvelopeV2,
  type CommandRequestV2,
  type SessionSnapshotV1,
} from "./index.js"

describe("protocol v2 foundation", () => {
  it("pins the Pi parity and supported protocol versions", () => {
    assert.equal(PI_PARITY_SDK_VERSION, "0.81.1")
    assert.equal(PROTOCOL_V2, 2)
    assert.deepEqual(SUPPORTED_PROTOCOL_VERSIONS, [1, 2])
  })

  it("keeps capability identifiers unique", () => {
    assert.equal(new Set(PI_CAPABILITY_IDS).size, PI_CAPABILITY_IDS.length)
  })

  it("uses scoped cursors and typed event payloads", () => {
    const event: EventEnvelopeV2<"session.runtime.replaced"> = {
      protocolVersion: 2,
      stream: { kind: "session", id: "session-1" },
      cursor: { epoch: "epoch-1", sequence: 3 },
      eventId: "event-3",
      timestamp: "2026-07-25T00:00:00.000Z",
      type: "session.runtime.replaced",
      payload: { sessionId: "session-1", workerGeneration: "worker-1" },
    }
    assert.equal(event.stream.kind, "session")
    assert.equal(event.payload.workerGeneration, "worker-1")
    assert.equal(eventStreamKeyV2(event.stream), "session:session-1")
    assert.deepEqual(parseEventStreamKeyV2("session:session-1"), event.stream)
  })

  it("declares command concurrency explicitly", () => {
    const command: CommandRequestV2<"session.navigateTree"> = {
      protocolVersion: 2,
      commandId: "command-1",
      type: "session.navigateTree",
      concurrency: "idle-only",
      sessionId: "session-1",
      payload: { entryId: "entry-1", summarizeAbandonedBranch: true },
    }
    assert.equal(command.concurrency, "idle-only")
    assert.equal(command.payload.entryId, "entry-1")
  })

  it("types native Pi tree entries and replacement commands", () => {
    const native: SessionSnapshotV1["native"] = {
      namespace: "pi",
      schemaVersion: 1,
      leafId: "entry-1",
      entries: [{
        type: "message",
        id: "entry-1",
        parentId: null,
        timestamp: "2026-01-01T00:00:00.000Z",
        role: "user",
        preview: "hello",
      }],
      tree: [],
    }
    const fork: CommandRequestV2<"session.fork"> = {
      protocolVersion: 2,
      commandId: "fork-1",
      type: "session.fork",
      concurrency: "idle-only",
      sessionId: "session-1",
      payload: { entryId: "entry-1", position: "before" },
    }
    assert.equal(native.entries[0]?.type, "message")
    assert.equal(fork.payload.position, "before")
  })
})
