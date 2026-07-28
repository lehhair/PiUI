import type { SessionSnapshotV1 } from "@piui/protocol"
import { beforeEach, describe, expect, it } from "vitest"
import { messageStore } from "../store/messageStore"
import { applySnapshotToUi } from "./applySnapshot"
import { isPiSession } from "./isPiSession"
import { nativeSessionStore } from "./nativeSessionStore"

function snapshot(): SessionSnapshotV1 {
  return {
    protocolVersion: 1,
    epoch: "e",
    sequence: 1,
    session: { id: "sess-rt", directory: "/workspace", driverId: "pi", driverSessionId: "d", state: "idle", createdAt: "a", updatedAt: "b" },
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
    native: { namespace: "pi", schemaVersion: 1, sdkVersion: "0.81.1", revision: 1, epoch: "native", header: null, leafId: "a1", entryCount: 2 },
  } as unknown as SessionSnapshotV1
}

describe("Pi prompt UI roundtrip", () => {
  beforeEach(() => {
    messageStore.clearAll()
    nativeSessionStore.clear()
  })

  it("tracks the session and renders persisted native messages", () => {
    const snap = snapshot()
    applySnapshotToUi(snap, { nativePage: {
      head: snap.native,
      items: [
        { type: "message", id: "u1", parentId: null, message: { role: "user", content: "q" } },
        { type: "message", id: "a1", parentId: "u1", message: { role: "assistant", content: "r" } },
      ],
      hasMore: false,
    } })
    expect(isPiSession("sess-rt")).toBe(true)
    expect(messageStore.getVisibleMessages("sess-rt").map(message => message.info.role)).toEqual(["user", "assistant"])
  })
})
