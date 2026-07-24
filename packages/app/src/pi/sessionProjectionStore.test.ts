import { describe, expect, it } from "vitest"
import { sessionProjectionStore } from "./sessionProjectionStore"
import type { SessionSnapshotV1 } from "@piui/protocol"

function sample(): SessionSnapshotV1 {
  return {
    protocolVersion: 1,
    epoch: "e1",
    sequence: 2,
    session: {
      id: "s1",
      workspaceId: "w1",
      driverId: "pi",
      driverSessionId: "d1",
      state: "idle",
      createdAt: "t0",
      updatedAt: "t1",
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
      { type: "user", id: "u1", timestamp: 1, text: "hi" },
      {
        type: "assistant",
        id: "a1",
        timestamp: 2,
        status: "completed",
        provider: "mock",
        model: "mock",
        content: [{ type: "text", text: "yo" }],
      },
    ],
    native: { namespace: "pi", schemaVersion: 1, leafId: "a1", entries: [], tree: [] },
  }
}

describe("sessionProjectionStore", () => {
  it("holds timeline from snapshot", () => {
    sessionProjectionStore.clear()
    sessionProjectionStore.replace(sample())
    expect(sessionProjectionStore.getTimeline()).toHaveLength(2)
    expect(sessionProjectionStore.getTimeline()[0]?.type).toBe("user")
    sessionProjectionStore.clear()
    expect(sessionProjectionStore.getTimeline()).toHaveLength(0)
  })
})
