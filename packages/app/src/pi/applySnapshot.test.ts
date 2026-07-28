import type { PiNativeEntriesPageV1, SessionSnapshotV1 } from "@piui/protocol"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { activeSessionStore } from "../store/activeSessionStore"
import { messageStore } from "../store/messageStore"
import { applyPiNativeEventToUi, applySnapshotToUi } from "./applySnapshot"
import { nativeSessionStore } from "./nativeSessionStore"

function snapshot(sequence = 1, revision = 1, leafId = "a1"): SessionSnapshotV1 {
  return {
    protocolVersion: 1,
    epoch: "snapshot-epoch",
    sequence,
    session: {
      id: "s-apply",
      directory: "/workspace",
      driverId: "pi",
      driverSessionId: "s-apply",
      title: "title",
      state: "idle",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    runtime: {
      attached: true,
      model: { provider: "anthropic", id: "claude-test" },
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
      entryCount: 2,
    },
  } as unknown as SessionSnapshotV1
}

function page(head = snapshot().native): PiNativeEntriesPageV1 {
  return {
    head,
    items: [
      { type: "message", id: "u1", parentId: null, timestamp: 1, message: { role: "user", content: "ping" } },
      { type: "message", id: "a1", parentId: "u1", timestamp: 2, message: { role: "assistant", content: "pong" } },
    ],
    hasMore: false,
  }
}

describe("app-local native session messages", () => {
  beforeEach(() => {
    messageStore.clearAll()
    nativeSessionStore.clear()
    activeSessionStore.initialize({})
    vi.restoreAllMocks()
  })

  it("publishes UI messages only from the supplied native entries page", () => {
    applySnapshotToUi(snapshot(), { nativePage: page() })
    expect(nativeSessionStore.getActiveBranch("s-apply").map(entry => entry.id)).toEqual(["u1", "a1"])
    expect(messageStore.getVisibleMessages("s-apply")).toHaveLength(2)
    expect(messageStore.getVisibleMessages("s-apply")[1]?.parts[0]).toMatchObject({ type: "text", text: "pong" })
  })

  it("projects native streaming events without changing persisted entries", () => {
    const initial = snapshot(1, 1, "u1")
    applySnapshotToUi(initial, { nativePage: { ...page(initial.native), items: page().items.slice(0, 1) } })
    applyPiNativeEventToUi("s-apply", {
      type: "message_start",
      message: { role: "assistant", content: [] },
    })
    applyPiNativeEventToUi("s-apply", {
      type: "message_update",
      message: { role: "assistant", provider: "anthropic", model: "claude-test", content: [{ type: "text", text: "partial" }] },
    })
    const assistant = messageStore.getVisibleMessages("s-apply").at(-1)
    expect(assistant?.parts[0]).toMatchObject({ type: "text", text: "partial" })
    expect(assistant?.isStreaming).toBe(true)
    expect(messageStore.getIsStreaming("s-apply")).toBe(true)

    applyPiNativeEventToUi("s-apply", { type: "agent_settled" })
    expect(messageStore.getIsStreaming("s-apply")).toBe(false)
  })

  it("keeps visible history while fetching a missing transient parent", () => {
    applySnapshotToUi(snapshot(), { nativePage: page() })
    applySnapshotToUi(snapshot(2, 2, "missing-leaf"), { refreshNative: false })

    applyPiNativeEventToUi("s-apply", {
      type: "message_start",
      message: { role: "user", content: "new question" },
    })

    const messages = messageStore.getVisibleMessages("s-apply")
    expect(messages.map(message => message.parts[0])).toEqual([
      expect.objectContaining({ type: "text", text: "ping" }),
      expect.objectContaining({ type: "text", text: "pong" }),
    ])
  })
})
