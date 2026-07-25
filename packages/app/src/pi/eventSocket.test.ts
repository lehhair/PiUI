import type { EventEnvelopeV1, SessionSnapshotV1 } from "@piui/protocol"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { applySnapshotToUi } from "./applySnapshot"
import { PiEventSocket } from "./eventSocket"
import { clearPiSessionIndex } from "./piSessionIndex"
import { sessionProjectionStore } from "./sessionProjectionStore"

const { fetchSnapshot } = vi.hoisted(() => ({
  fetchSnapshot: vi.fn<(id: string) => Promise<SessionSnapshotV1>>(),
}))

vi.mock("./sessionApi", async importOriginal => {
  const original = await importOriginal<typeof import("./sessionApi")>()
  return { ...original, fetchSnapshot }
})

class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null

  constructor(_url: string) { FakeWebSocket.instances.push(this) }
  close() { this.onclose?.() }
}

function snapshot(id: string, sequence: number, text: string): SessionSnapshotV1 {
  return {
    protocolVersion: 1,
    epoch: "session-epoch",
    sequence,
    session: {
      id,
      workspaceId: "workspace",
      driverId: "pi",
      driverSessionId: id,
      state: "idle",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    runtime: {
      attached: true,
      thinkingLevel: "off",
      availableThinkingLevels: ["off"],
      isStreaming: false,
      isCompacting: false,
      queue: { steering: [], followUp: [] },
      activeTools: [],
    },
    timeline: [{ type: "user", id: `entry-${id}`, entryId: `entry-${id}`, timestamp: 1, text }],
    native: { namespace: "pi", schemaVersion: 1, leafId: `entry-${id}`, entries: [], tree: [] },
  }
}

function envelope(sequence: number, payload: SessionSnapshotV1): EventEnvelopeV1 {
  return {
    protocolVersion: 1,
    epoch: "event-epoch",
    sequence,
    eventId: `event-${sequence}`,
    sessionId: payload.session.id,
    timestamp: "2026-01-01T00:00:00.000Z",
    type: "session.snapshot",
    payload,
  }
}

describe("PiEventSocket", () => {
  beforeEach(() => {
    sessionProjectionStore.clear()
    clearPiSessionIndex()
    FakeWebSocket.instances = []
    fetchSnapshot.mockReset()
    fetchSnapshot.mockRejectedValue(new Error("not available in unit test"))
    vi.stubGlobal("WebSocket", FakeWebSocket)
  })

  it("isolates background snapshots and rejects old event sequences", () => {
    applySnapshotToUi(snapshot("active", 1, "active"))
    const socket = new PiEventSocket()
    socket.connect()
    const ws = FakeWebSocket.instances[0]
    expect(ws).toBeDefined()

    ws?.onmessage?.({ data: JSON.stringify({ channel: "event", event: envelope(1, snapshot("background", 1, "background")) }) })
    expect(sessionProjectionStore.getActiveSessionId()).toBe("active")
    expect(sessionProjectionStore.getTimeline("background")[0]).toMatchObject({ text: "background" })

    ws?.onmessage?.({ data: JSON.stringify({ channel: "event", event: envelope(3, snapshot("active", 3, "new")) }) })
    ws?.onmessage?.({ data: JSON.stringify({ channel: "event", event: envelope(2, snapshot("active", 2, "old")) }) })
    expect(sessionProjectionStore.getTimeline("active")[0]).toMatchObject({ text: "new" })
    socket.close()
  })
})
