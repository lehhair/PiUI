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
      directory: `/workspace/${id}`,
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
      queue: { steering: [], followUp: [], steeringMode: "one-at-a-time", followUpMode: "one-at-a-time" },
      retry: { phase: "idle", autoEnabled: false },
      compaction: { autoEnabled: false, operation: { type: "none" } },
      tools: [],
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

  it("merges bounded timeline deltas without replacing unrelated history", () => {
    sessionProjectionStore.clear()
    sessionProjectionStore.replace(sample("s1", 2, "original"))
    const next = sessionProjectionStore.buildTimelineDelta("s1", "e1", 3, [
      {
        type: "assistant",
        id: "a1",
        timestamp: 2,
        status: "streaming",
        provider: "mock",
        model: "mock",
        content: [{ type: "text", text: "partial" }],
      },
    ], undefined, true)

    expect(next?.timeline).toHaveLength(2)
    expect(next?.timeline[0]).toMatchObject({ type: "user", text: "original" })
    expect(next?.timeline[1]).toMatchObject({ type: "assistant", status: "streaming" })
    expect(next?.runtime.isStreaming).toBe(true)
    expect(next?.session.state).toBe("running")
    expect(sessionProjectionStore.buildTimelineDelta("s1", "other-epoch", 4, [], undefined, false)).toBeNull()
  })

  it("reconciles synthetic timeline ids with persisted native ids", () => {
    sessionProjectionStore.clear()
    const base = sample("s1", 2, "original")
    base.timeline.push({
      type: "assistant",
      id: "synthetic-assistant",
      timestamp: 2,
      status: "streaming",
      provider: "mock",
      model: "mock",
      content: [{ type: "text", text: "partial" }],
    })
    sessionProjectionStore.replace(base)
    const next = sessionProjectionStore.buildTimelineDelta("s1", "e1", 3, [{
      type: "assistant",
      id: "native-assistant",
      entryId: "native-assistant",
      timestamp: 2,
      status: "completed",
      provider: "mock",
      model: "mock",
      content: [{ type: "text", text: "complete" }],
    }], ["synthetic-assistant"], false)

    expect(next?.timeline.map(item => item.id)).toEqual(["u-s1", "a1", "native-assistant"])
  })
})
