import { describe, expect, it, beforeEach } from "vitest"
import type { SessionSnapshotV1 } from "@piui/protocol"
import { applySnapshotToUi } from "./applySnapshot"
import { messageStore } from "../store/messageStore"
import { sessionProjectionStore } from "./sessionProjectionStore"

const snap: SessionSnapshotV1 = {
  protocolVersion: 1,
  epoch: "e",
  sequence: 1,
  session: {
    id: "s-apply",
    workspaceId: "w",
    driverId: "pi",
    driverSessionId: "d",
    title: "t",
    state: "idle",
    createdAt: "a",
    updatedAt: "b",
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
  timeline: [
    { type: "user", id: "u", timestamp: 1, text: "ping" },
    {
      type: "assistant",
      id: "a",
      timestamp: 2,
      status: "completed",
      provider: "mock",
      model: "mock",
      content: [{ type: "text", text: "pong" }],
    },
  ],
  native: { namespace: "pi", schemaVersion: 1, leafId: "a", entries: [], tree: [] },
}

describe("applySnapshotToUi", () => {
  beforeEach(() => {
    messageStore.clearAll()
    sessionProjectionStore.clear()
  })

  it("fills both stores", () => {
    const id = applySnapshotToUi(snap)
    expect(id).toBe("s-apply")
    expect(sessionProjectionStore.getTimeline()).toHaveLength(2)
    expect(messageStore.getVisibleMessages("s-apply")[1]?.parts[0]).toMatchObject({
      type: "text",
      text: "pong",
    })
  })

  it("updates a background session without changing the active session", () => {
    applySnapshotToUi(snap)
    const background = {
      ...snap,
      session: { ...snap.session, id: "s-background", driverSessionId: "s-background" },
    }
    applySnapshotToUi(background, { activate: false })
    expect(sessionProjectionStore.getActiveSessionId()).toBe("s-apply")
    expect(sessionProjectionStore.getSnapshot("s-background")?.session.id).toBe("s-background")
  })
})
