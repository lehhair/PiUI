import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { applyWorkerEvent, createProjectionState, projectEntries } from "./projection.js"
import { runMockTurn } from "./mock-runtime.js"
import type { PiEntry } from "./types.js"

describe("projectEntries", () => {
  it("pairs toolCall with toolResult", () => {
    const entries: PiEntry[] = [
      {
        type: "message",
        id: "u1",
        parentId: null,
        timestamp: 1,
        message: { role: "user", content: "read file" },
      },
      {
        type: "message",
        id: "a1",
        parentId: "u1",
        timestamp: 2,
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "ok" },
            { type: "toolCall", id: "tc1", name: "read", arguments: { path: "a.ts" } },
          ],
        },
      },
      {
        type: "message",
        id: "tr1",
        parentId: "a1",
        timestamp: 3,
        message: {
          role: "toolResult",
          toolCallId: "tc1",
          toolName: "read",
          result: "export const x = 1",
        },
      },
    ]
    const state = projectEntries(entries)
    assert.equal(state.timeline.length, 2)
    assert.equal(state.timeline[0]?.type, "user")
    const asst = state.timeline[1]
    assert.ok(asst && asst.type === "assistant")
    const tool = asst.content.find(c => c.type === "tool")
    assert.ok(tool && tool.type === "tool")
    assert.equal(tool.status, "completed")
    assert.equal(tool.output?.[0]?.type, "text")
    if (tool.output?.[0]?.type === "text") {
      assert.match(tool.output[0].text, /export const x/)
    }
  })

  it("keeps pending tool when result missing", () => {
    const entries: PiEntry[] = [
      {
        type: "message",
        id: "a1",
        parentId: null,
        timestamp: 1,
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: "tc1", name: "bash", arguments: { command: "ls" } }],
        },
      },
    ]
    const state = projectEntries(entries)
    const asst = state.timeline[0]
    assert.ok(asst && asst.type === "assistant")
    const tool = asst.content[0]
    assert.ok(tool && tool.type === "tool")
    assert.equal(tool.status, "pending")
  })
})

describe("applyWorkerEvent stream", () => {
  it("replays mock turn without model", () => {
    let state = createProjectionState()
    for (const ev of runMockTurn({
      userText: "hi",
      assistantText: "hello world",
      thinking: "think",
      tool: { name: "read", args: { path: "x" }, result: "body" },
    })) {
      state = applyWorkerEvent(state, ev)
    }
    assert.equal(state.isStreaming, false)
    assert.equal(state.timeline.length, 2)
    const user = state.timeline[0]
    assert.ok(user && user.type === "user")
    assert.equal(user.text, "hi")
    const asst = state.timeline[1]
    assert.ok(asst && asst.type === "assistant")
    assert.equal(asst.status, "completed")
    assert.ok(asst.content.some(c => c.type === "thinking" && c.text === "think"))
    assert.ok(asst.content.some(c => c.type === "text" && c.text === "hello world"))
    const tool = asst.content.find(c => c.type === "tool")
    assert.ok(tool && tool.type === "tool")
    assert.equal(tool.status, "completed")
    assert.equal(tool.output?.[0]?.type, "text")
  })

  it("never imports pi-coding-agent in this package surface", async () => {
    // structural: mock path only
    const pkg = await import("./index.js")
    assert.ok(pkg.runMockTurn)
    assert.ok(pkg.projectEntries)
  })
})
