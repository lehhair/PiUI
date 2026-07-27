import {
  EVENT_WS_SUBPROTOCOL_V2,
  eventStreamKeyV2,
  type EventEnvelopeV1,
  type EventEnvelopeV2,
  type ExtensionUiSnapshotV1,
  type SessionSnapshotV1,
} from "@piui/protocol"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { applySnapshotToUi } from "./applySnapshot"
import { PiEventSocket } from "./eventSocket"
import { clearPiSessionIndex } from "./piSessionIndex"
import { sessionProjectionStore } from "./sessionProjectionStore"

const { fetchSnapshot, fetchExtensionUiSnapshot } = vi.hoisted(() => ({
  fetchSnapshot: vi.fn<(id: string) => Promise<SessionSnapshotV1>>(),
  fetchExtensionUiSnapshot: vi.fn<(id: string) => Promise<ExtensionUiSnapshotV1>>(),
}))

vi.mock("./sessionApi", async importOriginal => {
  const original = await importOriginal<typeof import("./sessionApi")>()
  return { ...original, fetchSnapshot, fetchExtensionUiSnapshot }
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
    this.protocol = Array.isArray(protocol) ? (protocol[0] ?? "") : (protocol ?? "")
    FakeWebSocket.instances.push(this)
  }
  send(data: string) { this.sent.push(data) }
  close() { this.readyState = 3; this.onclose?.() }
}

function snapshot(id: string, sequence: number, text: string): SessionSnapshotV1 {
  return {
    protocolVersion: 1,
    epoch: "session-epoch",
    sequence,
    session: {
      id,
      directory: "/workspace",
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
      queue: { steering: [], followUp: [], steeringMode: "one-at-a-time", followUpMode: "one-at-a-time" },
      retry: { phase: "idle", autoEnabled: false },
      compaction: { autoEnabled: false, operation: { type: "none" } },
      tools: [],
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

function envelopeV2(sequence: number, payload: SessionSnapshotV1): EventEnvelopeV2<"session.snapshot.updated"> {
  return {
    protocolVersion: 2,
    stream: { kind: "session", id: payload.session.id },
    cursor: { epoch: "stream-epoch", sequence },
    eventId: `event-v2-${sequence}`,
    timestamp: "2026-01-01T00:00:00.000Z",
    type: "session.snapshot.updated",
    payload: { sessionId: payload.session.id, reason: "runtime", snapshot: payload },
  }
}

describe("PiEventSocket", () => {
  beforeEach(() => {
    sessionProjectionStore.clear()
    clearPiSessionIndex()
    FakeWebSocket.instances = []
    fetchSnapshot.mockReset()
    fetchSnapshot.mockRejectedValue(new Error("not available in unit test"))
    fetchExtensionUiSnapshot.mockReset()
    fetchExtensionUiSnapshot.mockImplementation(async sessionId => ({
      sessionId,
      state: {
        revision: 0,
        statuses: {},
        workingVisible: true,
        widgets: {},
        editorText: "",
        toolsExpanded: false,
      },
      pending: [],
    }))
    vi.stubGlobal("WebSocket", FakeWebSocket)
  })

  it("isolates background snapshots and resyncs legacy event gaps before advancing", async () => {
    applySnapshotToUi(snapshot("active", 1, "active"))
    const socket = new PiEventSocket()
    socket.connect()
    const ws = FakeWebSocket.instances[0]
    expect(ws).toBeDefined()

    ws?.onmessage?.({ data: JSON.stringify({ channel: "event", event: envelope(1, snapshot("background", 1, "background")) }) })
    expect(sessionProjectionStore.getActiveSessionId()).toBe("active")
    expect(sessionProjectionStore.getTimeline("background")[0]).toMatchObject({ text: "background" })

    fetchSnapshot.mockImplementation(async id => snapshot(id, 3, id === "active" ? "new" : "background"))
    ws?.onmessage?.({ data: JSON.stringify({ channel: "event", event: envelope(3, snapshot("active", 3, "ignored-gap")) }) })
    await vi.waitFor(() => {
      expect(sessionProjectionStore.getTimeline("active")[0]).toMatchObject({ text: "new" })
    })
    ws?.onmessage?.({ data: JSON.stringify({ channel: "event", event: envelope(2, snapshot("active", 2, "old")) }) })
    expect(sessionProjectionStore.getTimeline("active")[0]).toMatchObject({ text: "new" })
    socket.close()
  })

  it("subscribes with cursor maps and applies contiguous v2 session events", async () => {
    applySnapshotToUi(snapshot("active", 1, "base"))
    fetchSnapshot.mockResolvedValue(snapshot("active", 2, "resynced"))
    const socket = new PiEventSocket()
    socket.connect()
    const ws = FakeWebSocket.instances[0]
    ws?.onopen?.()

    const initialSubscribe = JSON.parse(ws?.sent[0] ?? "{}") as { streams?: Array<{ kind: string; id: string }> }
    expect(ws?.protocol).toBe(EVENT_WS_SUBPROTOCOL_V2)
    expect(initialSubscribe.streams).toContainEqual({ kind: "session", id: "active" })
    expect(initialSubscribe.streams).toContainEqual({ kind: "workspace", id: "/workspace" })

    const key = eventStreamKeyV2({ kind: "session", id: "active" })
    ws?.onmessage?.({
      data: JSON.stringify({
        channel: "control",
        type: "resync_required",
        streams: { [key]: { cursor: { epoch: "stream-epoch", sequence: 0 }, reason: "missing_cursor" } },
      }),
    })
    await vi.waitFor(() => {
      expect(sessionProjectionStore.getTimeline("active")[0]).toMatchObject({ text: "resynced" })
    })
    const resubscribe = JSON.parse(ws?.sent.at(-1) ?? "{}") as { streams?: Array<{ kind: string; id: string }> }
    expect(resubscribe.streams).toContainEqual({ kind: "server", id: "server" })
    expect(resubscribe.streams).toContainEqual({ kind: "workspace", id: "/workspace" })
    expect(resubscribe.streams).toContainEqual({ kind: "session", id: "active" })

    ws?.onmessage?.({
      data: JSON.stringify({ channel: "event", event: envelopeV2(1, snapshot("active", 3, "live")) }),
    })
    expect(sessionProjectionStore.getTimeline("active")[0]).toMatchObject({ text: "live" })
    socket.close()
  })

  it("recovers a gapped v2 stream from ordered replay", async () => {
    applySnapshotToUi(snapshot("active", 1, "base"))
    fetchSnapshot.mockResolvedValue(snapshot("active", 2, "resynced"))
    const socket = new PiEventSocket()
    socket.connect()
    const ws = FakeWebSocket.instances[0]
    ws?.onopen?.()
    const key = eventStreamKeyV2({ kind: "session", id: "active" })
    ws?.onmessage?.({
      data: JSON.stringify({
        channel: "control",
        type: "resync_required",
        streams: { [key]: { cursor: { epoch: "stream-epoch", sequence: 0 }, reason: "missing_cursor" } },
      }),
    })
    await vi.waitFor(() => expect(sessionProjectionStore.getTimeline("active")[0]).toMatchObject({ text: "resynced" }))

    ws?.onmessage?.({
      data: JSON.stringify({ channel: "event", event: envelopeV2(3, snapshot("active", 3, "must-not-apply")) }),
    })
    const subscriptionsAfterGap = ws?.sent.length
    ws?.onmessage?.({
      data: JSON.stringify({ channel: "event", event: envelopeV2(4, snapshot("active", 4, "also-gapped")) }),
    })
    expect(ws?.sent.length).toBe(subscriptionsAfterGap)
    expect(sessionProjectionStore.getTimeline("active")[0]).toMatchObject({ text: "resynced" })
    expect(ws?.sent.some(raw => JSON.parse(raw).cursors?.[key]?.sequence === 0)).toBe(true)

    ws?.onmessage?.({ data: JSON.stringify({ channel: "event", event: envelopeV2(1, snapshot("active", 3, "replay-1")) }) })
    ws?.onmessage?.({ data: JSON.stringify({ channel: "event", event: envelopeV2(2, snapshot("active", 4, "replay-2")) }) })
    ws?.onmessage?.({ data: JSON.stringify({ channel: "event", event: envelopeV2(3, snapshot("active", 5, "replay-3")) }) })
    expect(sessionProjectionStore.getTimeline("active")[0]).toMatchObject({ text: "replay-3" })
    socket.close()
  })

  it("delivers workspace file and Git invalidation events", async () => {
    applySnapshotToUi(snapshot("active", 1, "base"))
    const socket = new PiEventSocket()
    socket.connect()
    const ws = FakeWebSocket.instances[0]
    ws?.onopen?.()
    const workspaceKey = eventStreamKeyV2({ kind: "workspace", id: "/workspace" })
    ws?.onmessage?.({
      data: JSON.stringify({
        channel: "control",
        type: "resync_required",
        streams: { [workspaceKey]: { cursor: { epoch: "workspace-epoch", sequence: 0 }, reason: "missing_cursor" } },
      }),
    })
    await vi.waitFor(() => expect(JSON.parse(ws?.sent.at(-1) ?? "{}").cursors?.[workspaceKey]?.sequence).toBe(0))

    const fileListener = vi.fn()
    const gitListener = vi.fn()
    window.addEventListener("piui:workspace-files-changed", fileListener)
    window.addEventListener("piui:workspace-git-updated", gitListener)
    ws?.onmessage?.({
      data: JSON.stringify({
        channel: "event",
        event: {
          protocolVersion: 2,
          stream: { kind: "workspace", id: "/workspace" },
          cursor: { epoch: "workspace-epoch", sequence: 1 },
          eventId: "file-1",
          timestamp: "2026-01-01T00:00:00.000Z",
          type: "workspace.files.changed",
          payload: {
            workspacePath: "/workspace",
            revision: 1,
            changes: [{ path: "src/app.ts", kind: "changed", type: "file" }],
            rescan: false,
          },
        },
      }),
    })
    ws?.onmessage?.({
      data: JSON.stringify({
        channel: "event",
        event: {
          protocolVersion: 2,
          stream: { kind: "workspace", id: "/workspace" },
          cursor: { epoch: "workspace-epoch", sequence: 2 },
          eventId: "git-2",
          timestamp: "2026-01-01T00:00:00.000Z",
          type: "workspace.git.updated",
          payload: { workspacePath: "/workspace", revision: 1 },
        },
      }),
    })
    expect(fileListener).toHaveBeenCalledTimes(1)
    expect((fileListener.mock.calls[0]?.[0] as CustomEvent).detail.changes[0].path).toBe("src/app.ts")
    expect(gitListener).toHaveBeenCalledTimes(1)
    window.removeEventListener("piui:workspace-files-changed", fileListener)
    window.removeEventListener("piui:workspace-git-updated", gitListener)
    socket.close()
  })
})
