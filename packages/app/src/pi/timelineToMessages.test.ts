import { describe, expect, it } from "vitest"
import type { SessionSnapshotV1 } from "@piui/protocol"
import { snapshotToUiMessages, timelineToUiMessages } from "./timelineToMessages"
import { messageStore } from "../store/messageStore"

function sampleSnapshot(): SessionSnapshotV1 {
  return {
    protocolVersion: 1,
    epoch: "e1",
    sequence: 3,
    session: {
      id: "sess-1",
      directory: "/workspace",
      driverId: "pi",
      driverSessionId: "d1",
      title: "mock",
      state: "idle",
      createdAt: "t0",
      updatedAt: "t1",
    },
    runtime: {
      attached: true,
      model: { provider: "provider-1", id: "model-1", displayName: "Model One" },
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
      { type: "user", id: "u1", entryId: "entry-u1", timestamp: 1000, text: "read me" },
      {
        type: "assistant",
        id: "a1",
        entryId: "entry-a1",
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

describe("timelineToUiMessages", () => {
  it("maps user + assistant + tool into UI messages", () => {
    const msgs = snapshotToUiMessages(sampleSnapshot())
    expect(msgs).toHaveLength(2)
    expect(msgs[0]?.info.role).toBe("user")
    expect(msgs[0]?.info.role === "user" ? msgs[0].info.model : null).toEqual({
      providerID: "provider-1",
      modelID: "model-1",
    })
    expect(msgs[1]?.info.role).toBe("assistant")
    expect(msgs[0]?.info.entryId).toBe("entry-u1")
    expect(msgs[1]?.info.entryId).toBe("entry-a1")
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
    const msgs = timelineToUiMessages(snap.timeline, snap.session.id)
    messageStore.setUiMessages(snap.session.id, msgs, { title: snap.session.title })
    const visible = messageStore.getVisibleMessages(snap.session.id)
    expect(visible).toHaveLength(2)
    expect(visible[0]?.info.role).toBe("user")
    expect(visible[1]?.parts.length).toBeGreaterThanOrEqual(2)
    messageStore.clearAll()
  })
})
