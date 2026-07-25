import { describe, expect, it } from "vitest"
import { sessionProjectionStore } from "./sessionProjectionStore"
import type { SessionSnapshotV1 } from "@piui/protocol"

function sample(id = "s1", sequence = 2, text = "hi"): SessionSnapshotV1 {
  return {
    protocolVersion: 1,
    epoch: "e1",
    sequence,
    session: {
      id,
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
      { type: "user", id: `u-${id}`, timestamp: 1, text },
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

  it("keeps snapshots isolated and does not activate background updates", () => {
    sessionProjectionStore.clear()
    sessionProjectionStore.replace(sample("active", 1, "active"))
    sessionProjectionStore.replace(sample("background", 1, "background"), { activate: false })

    expect(sessionProjectionStore.getActiveSessionId()).toBe("active")
    expect(sessionProjectionStore.getTimeline("active")[0]).toMatchObject({ text: "active" })
    expect(sessionProjectionStore.getTimeline("background")[0]).toMatchObject({ text: "background" })
  })

  it("rejects stale snapshots within one epoch", () => {
    sessionProjectionStore.clear()
    expect(sessionProjectionStore.replace(sample("s1", 3, "new"))).toBe(true)
    expect(sessionProjectionStore.replace(sample("s1", 2, "old"))).toBe(false)
    expect(sessionProjectionStore.getTimeline("s1")[0]).toMatchObject({ text: "new" })
  })
})
