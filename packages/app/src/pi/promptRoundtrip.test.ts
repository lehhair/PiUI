import { beforeEach, describe, expect, it, vi } from "vitest"
import type { SessionSnapshotV1 } from "@piui/protocol"
import { applySnapshotToUi } from "./applySnapshot"
import { messageStore } from "../store/messageStore"
import { sessionProjectionStore } from "./sessionProjectionStore"
import { isPiSession } from "./isPiSession"

function snap(id: string, n: number): SessionSnapshotV1 {
  const timeline = []
  for (let i = 0; i < n; i++) {
    timeline.push({ type: "user" as const, id: `u${i}`, timestamp: i * 2, text: `q${i}` })
    timeline.push({
      type: "assistant" as const,
      id: `a${i}`,
      timestamp: i * 2 + 1,
      status: "completed" as const,
      provider: "mock",
      model: "mock",
      content: [{ type: "text" as const, text: `r${i}` }],
    })
  }
  return {
    protocolVersion: 1,
    epoch: "e",
    sequence: n,
    session: {
      id,
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
      queue: { steering: [], followUp: [], steeringMode: "one-at-a-time", followUpMode: "one-at-a-time" },
      retry: { phase: "idle", autoEnabled: false },
      compaction: { autoEnabled: false, operation: { type: "none" } },
      tools: [],
      activeTools: [],
    },
    timeline,
    native: { namespace: "pi", schemaVersion: 1, leafId: `a${n - 1}`, entries: [], tree: [] },
  }
}

describe("pi prompt roundtrip (ui apply)", () => {
  beforeEach(() => {
    messageStore.clearAll()
    sessionProjectionStore.clear()
    vi.restoreAllMocks()
  })

  it("isPiSession true after apply", () => {
    applySnapshotToUi(snap("sess-rt", 1))
    expect(isPiSession("sess-rt")).toBe(true)
    expect(isPiSession("other")).toBe(false)
  })

  it("re-apply grows visible messages", () => {
    applySnapshotToUi(snap("sess-rt", 1))
    expect(messageStore.getVisibleMessages("sess-rt")).toHaveLength(2)
    applySnapshotToUi(snap("sess-rt", 2))
    expect(messageStore.getVisibleMessages("sess-rt")).toHaveLength(4)
    const last = messageStore.getVisibleMessages("sess-rt").at(-1)
    expect(last?.info.role).toBe("assistant")
  })
})
