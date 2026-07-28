import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { applyWorkerEvent, createProjectionState, projectEntries } from "./projection.js"
import { runMockTurn } from "./mock-runtime.js"
import type { PiEntry } from "./types.js"

describe("projectEntries", () => {
  it("preserves user image blocks in the presentation timeline", () => {
    const state = projectEntries([{
      type: "message",
      id: "user-image",
      parentId: null,
      timestamp: 1,
      message: {
        role: "user",
        content: [
          { type: "text", text: "describe this" },
          { type: "image", mimeType: "image/png", data: "aW1hZ2U=" },
        ],
      },
    }])
    const user = state.timeline[0]
    assert.ok(user?.type === "user")
    assert.equal(user.text, "describe this")
    assert.deepEqual(user.attachments, [{ type: "image", mimeType: "image/png", blockIndex: 1, byteLength: 5 }])
  })

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
          result: [
            { type: "text", text: "export const x = 1" },
            { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
          ],
          details: { patch: "@@ -1 +1 @@", cwd: "/workspace", exitCode: 0 },
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
    assert.equal(tool.output?.[1]?.type, "image")
    assert.deepEqual(tool.output?.[1], {
      type: "image",
      entryId: "tr1",
      blockIndex: 1,
      mimeType: "image/png",
      byteLength: 8,
    })
    assert.equal(JSON.stringify(state.timeline).includes("iVBORw0KGgo="), false)
    assert.equal(tool.normalized?.patch, "@@ -1 +1 @@")
    assert.equal(tool.normalized?.cwd, "/workspace")
    assert.equal(tool.normalized?.exitCode, 0)
    assert.deepEqual(tool.nativeDetails, { patch: "@@ -1 +1 @@", cwd: "/workspace", exitCode: 0 })
  })

  it("preserves native Pi assistant identity and completion state", () => {
    const state = projectEntries([
      {
        type: "message",
        id: "pi-assistant-entry",
        parentId: null,
        timestamp: 123,
        message: {
          role: "assistant",
          provider: "anthropic",
          model: "claude-test",
          stopReason: "aborted",
          content: [{ type: "text", text: "partial" }],
        },
      },
    ])

    const assistant = state.timeline[0]
    assert.equal(assistant?.type, "assistant")
    if (assistant?.type !== "assistant") return
    assert.equal(assistant.entryId, "pi-assistant-entry")
    assert.equal(assistant.provider, "anthropic")
    assert.equal(assistant.model, "claude-test")
    assert.equal(assistant.status, "aborted")
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

  it("mock surface does not load real session module eagerly", async () => {
    const pkg = await import("./index.js")
    assert.ok(pkg.runMockTurn)
    assert.ok(pkg.projectEntries)
    assert.equal(pkg.getDriverMode({}), "mock")
  })
})
