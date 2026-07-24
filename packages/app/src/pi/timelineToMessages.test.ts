import { describe, expect, it } from "vitest"
import type { SessionSnapshotV1 } from "@piui/protocol"
import { snapshotToApiMessages, timelineToApiMessages } from "./timelineToMessages"
import { messageStore } from "../store/messageStore"

function sampleSnapshot(): SessionSnapshotV1 {
  return {
    protocolVersion: 1,
    epoch: "e1",
    sequence: 3,
    session: {
      id: "sess-1",
      workspaceId: "w1",
      driverId: "pi",
      driverSessionId: "d1",
      title: "mock",
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
      { type: "user", id: "u1", timestamp: 1000, text: "read me" },
      {
        type: "assistant",
        id: "a1",
        parentEntryId: "u1",
        timestamp: 1001,
        status: "completed",
        provider: "mock",
        model: "mock",
        content: [
          { type: "thinking", text: "plan" },
          { type: "text", text: "done" },
          {
            type: "tool",
            callId: "tc1",
            name: "read",
            status: "completed",
            input: { path: "a.ts" },
            output: [{ type: "text", text: "export {}" }],
          },
        ],
      },
    ],
    native: { namespace: "pi", schemaVersion: 1, leafId: "a1", entries: [], tree: [] },
  }
}

describe("timelineToApiMessages", () => {
  it("maps user + assistant + tool into ApiMessageWithParts", () => {
    const msgs = snapshotToApiMessages(sampleSnapshot())
    expect(msgs).toHaveLength(2)
    expect(msgs[0]?.info.role).toBe("user")
    expect(msgs[1]?.info.role).toBe("assistant")
    const parts = msgs[1]!.parts
    expect(parts.some(p => p.type === "reasoning")).toBe(true)
    expect(parts.some(p => p.type === "text")).toBe(true)
    const tool = parts.find(p => p.type === "tool") as { tool: string; state: { status: string; output?: string } }
    expect(tool?.tool).toBe("read")
    expect(tool?.state.status).toBe("completed")
    expect(tool?.state.output).toMatch(/export/)
  })

  it("loads into messageStore for ChatArea pipeline", () => {
    messageStore.clearAll()
    const snap = sampleSnapshot()
    const msgs = timelineToApiMessages(snap.timeline, snap.session.id)
    messageStore.setMessages(snap.session.id, msgs, { title: snap.session.title })
    const visible = messageStore.getVisibleMessages(snap.session.id)
    expect(visible).toHaveLength(2)
    expect(visible[0]?.info.role).toBe("user")
    expect(visible[1]?.parts.length).toBeGreaterThanOrEqual(2)
    messageStore.clearAll()
  })
})
