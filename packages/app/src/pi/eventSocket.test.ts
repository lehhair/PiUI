import {
  EVENT_WS_SUBPROTOCOL_V2,
  eventStreamKeyV2,
  type ExtensionUiSnapshotV1,
  type PiNativeEntriesPageV1,
  type SessionSnapshotV1,
} from "@piui/protocol"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { messageStore } from "../store/messageStore"
import { applySnapshotToUi } from "./applySnapshot"
import { PiEventSocket } from "./eventSocket"
import { clearPiSessionIndex } from "./piSessionIndex"
import { nativeSessionStore } from "./nativeSessionStore"

const { fetchSnapshot, fetchPiNativeBranchPage, fetchExtensionUiSnapshot } = vi.hoisted(() => ({
  fetchSnapshot: vi.fn<(id: string) => Promise<SessionSnapshotV1>>(),
  fetchPiNativeBranchPage: vi.fn<(id: string) => Promise<PiNativeEntriesPageV1>>(),
  fetchExtensionUiSnapshot: vi.fn<(id: string) => Promise<ExtensionUiSnapshotV1>>(),
}))

vi.mock("./sessionApi", async importOriginal => {
  const original = await importOriginal<typeof import("./sessionApi")>()
  return { ...original, fetchSnapshot, fetchPiNativeBranchPage, fetchExtensionUiSnapshot }
})

class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  static OPEN = 1
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  readyState = FakeWebSocket.OPEN
  protocol: string
  sent: string[] = []

  constructor(_url: string, protocol?: string | string[]) {
    this.protocol = Array.isArray(protocol) ? protocol[0] ?? "" : protocol ?? ""
    FakeWebSocket.instances.push(this)
  }
  send(data: string) { this.sent.push(data) }
  close() { this.readyState = 3; this.onclose?.() }
}

function snapshot(revision = 1, leafId = "u1", sequence = revision): SessionSnapshotV1 {
  return {
    protocolVersion: 1,
    epoch: "snapshot-epoch",
    sequence,
    session: {
      id: "active",
      directory: "/workspace",
      driverId: "pi",
      driverSessionId: "active",
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
      queue: { steering: [], followUp: [], steeringMode: "one-at-a-time", followUpMode: "one-at-a-time" },
      retry: { phase: "idle", autoEnabled: false },
      compaction: { autoEnabled: false, operation: { type: "none" } },
      tools: [],
      activeTools: [],
    },
    native: {
      namespace: "pi",
      schemaVersion: 1,
      sdkVersion: "0.81.1",
      revision,
      epoch: "native-epoch",
      header: null,
      leafId,
      entryCount: leafId === "a1" ? 2 : 1,
    },
  } as unknown as SessionSnapshotV1
}

function page(head: SessionSnapshotV1["native"], assistantText?: string): PiNativeEntriesPageV1 {
  return {
    head,
    items: [
      { type: "message", id: "u1", parentId: null, timestamp: 1, message: { role: "user", content: "question" } },
      ...(assistantText ? [{ type: "message", id: "a1", parentId: "u1", timestamp: 2, message: { role: "assistant", content: assistantText } }] : []),
    ],
    hasMore: false,
  }
}

function send(ws: FakeWebSocket, value: unknown): void {
  ws.onmessage?.({ data: JSON.stringify(value) })
}

describe("PiEventSocket native session events", () => {
  beforeEach(() => {
    messageStore.clearAll()
    nativeSessionStore.clear()
    clearPiSessionIndex()
    FakeWebSocket.instances = []
    fetchSnapshot.mockReset()
    fetchPiNativeBranchPage.mockReset()
    fetchExtensionUiSnapshot.mockReset()
    fetchExtensionUiSnapshot.mockImplementation(async sessionId => ({
      sessionId,
      state: { revision: 0, statuses: {}, workingVisible: true, widgets: {}, editorText: "", toolsExpanded: false },
      pending: [],
    }))
    vi.stubGlobal("WebSocket", FakeWebSocket)
  })

  it("resyncs a session with both snapshot and native entries page", async () => {
    const initial = snapshot()
    applySnapshotToUi(initial, { nativePage: page(initial.native) })
    const resynced = snapshot(2, "a1")
    fetchSnapshot.mockResolvedValue(resynced)
    fetchPiNativeBranchPage.mockResolvedValue(page(resynced.native, "resynced"))

    const socket = new PiEventSocket()
    socket.connect()
    const ws = FakeWebSocket.instances[0]!
    ws.onopen?.()
    expect(ws.protocol).toBe(EVENT_WS_SUBPROTOCOL_V2)
    const key = eventStreamKeyV2({ kind: "session", id: "active" })
    send(ws, {
      channel: "control",
      type: "resync_required",
      streams: { [key]: { cursor: { epoch: "event-epoch", sequence: 0 }, reason: "missing_cursor" } },
    })

    await vi.waitFor(() => expect(messageStore.getVisibleMessages("active").at(-1)?.parts[0]).toMatchObject({ text: "resynced" }))
    expect(fetchSnapshot).toHaveBeenCalledWith("active")
    expect(fetchPiNativeBranchPage).toHaveBeenCalledWith("active")
    socket.close()
  })

  it("continues native message updates after resync restores a live Pi message", async () => {
    const running = snapshot()
    running.session.state = "running"
    running.runtime.isStreaming = true
    applySnapshotToUi(running, { nativePage: page(running.native) })
    fetchSnapshot.mockResolvedValue(running)
    fetchPiNativeBranchPage.mockResolvedValue({
      ...page(running.native),
      liveMessage: { role: "assistant", content: [{ type: "text", text: "before refresh" }] },
    })

    const socket = new PiEventSocket()
    socket.connect()
    const ws = FakeWebSocket.instances[0]!
    ws.onopen?.()
    const key = eventStreamKeyV2({ kind: "session", id: "active" })
    send(ws, {
      channel: "control",
      type: "resync_required",
      streams: { [key]: { cursor: { epoch: "event-epoch", sequence: 4 }, reason: "missing_cursor" } },
    })
    await vi.waitFor(() => expect(messageStore.getVisibleMessages("active").at(-1)?.parts[0]).toMatchObject({
      text: "before refresh",
    }))

    send(ws, {
      channel: "event",
      event: {
        protocolVersion: 2,
        stream: { kind: "session", id: "active" },
        cursor: { epoch: "event-epoch", sequence: 5 },
        eventId: "native-after-refresh",
        timestamp: "2026-01-01T00:00:00.000Z",
        type: "session.native.event",
        payload: {
          sessionId: "active",
          event: {
            type: "message_update",
            message: { role: "assistant", content: [{ type: "text", text: "after refresh" }] },
          },
        },
      },
    })
    expect(messageStore.getVisibleMessages("active").at(-1)?.parts[0]).toMatchObject({ text: "after refresh" })
    socket.close()
  })

  it("projects raw native streaming events and replaces transient data after native revision advances", async () => {
    const initial = snapshot()
    applySnapshotToUi(initial, { nativePage: page(initial.native) })
    fetchSnapshot.mockResolvedValue(initial)
    fetchPiNativeBranchPage.mockResolvedValue(page(initial.native))
    const socket = new PiEventSocket()
    socket.connect()
    const ws = FakeWebSocket.instances[0]!
    ws.onopen?.()
    const key = eventStreamKeyV2({ kind: "session", id: "active" })
    send(ws, {
      channel: "control",
      type: "resync_required",
      streams: { [key]: { cursor: { epoch: "event-epoch", sequence: 0 }, reason: "missing_cursor" } },
    })
    await vi.waitFor(() => expect(JSON.parse(ws.sent.at(-1) ?? "{}").cursors?.[key]?.sequence).toBe(0))

    const nativeEnvelope = (sequence: number, event: unknown) => ({
      channel: "event",
      event: {
        protocolVersion: 2,
        stream: { kind: "session", id: "active" },
        cursor: { epoch: "event-epoch", sequence },
        eventId: `native-${sequence}`,
        timestamp: "2026-01-01T00:00:00.000Z",
        type: "session.native.event",
        payload: { sessionId: "active", event },
      },
    })
    send(ws, nativeEnvelope(1, { type: "message_start", message: { role: "assistant", content: [] } }))
    send(ws, nativeEnvelope(2, {
      type: "message_update",
      message: { role: "assistant", content: [{ type: "text", text: "partial" }] },
    }))
    expect(messageStore.getVisibleMessages("active").at(-1)?.parts[0]).toMatchObject({ text: "partial" })
    expect(messageStore.getIsStreaming("active")).toBe(true)

    const persisted = snapshot(2, "a1", 2)
    fetchPiNativeBranchPage.mockResolvedValue(page(persisted.native, "complete"))
    send(ws, {
      channel: "event",
      event: {
        protocolVersion: 2,
        stream: { kind: "session", id: "active" },
        cursor: { epoch: "event-epoch", sequence: 3 },
        eventId: "snapshot-3",
        timestamp: "2026-01-01T00:00:00.000Z",
        type: "session.snapshot.updated",
        payload: { sessionId: "active", reason: "runtime", snapshot: persisted },
      },
    })
    await vi.waitFor(() => expect(messageStore.getVisibleMessages("active").at(-1)?.parts[0]).toMatchObject({ text: "complete" }))
    expect(nativeSessionStore.getStreamingEntryIds("active").size).toBe(0)
    socket.close()
  })
})
