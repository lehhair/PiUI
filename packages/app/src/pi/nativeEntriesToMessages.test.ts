import { describe, expect, it } from "vitest"
import { nativeEntriesToUiMessages } from "./nativeEntriesToMessages"

describe("nativeEntriesToUiMessages", () => {
  it("projects Pi messages, tool results, normalized details and authenticated images", () => {
    const messages = nativeEntriesToUiMessages([
      {
        type: "message",
        id: "u1",
        parentId: null,
        timestamp: "2026-01-01T00:00:00.000Z",
        message: {
          role: "user",
          content: [
            { type: "text", text: "read it" },
            { type: "image", mimeType: "image/png", data: "aW1hZ2U=" },
          ],
        },
      },
      {
        type: "message",
        id: "a1",
        parentId: "u1",
        timestamp: "2026-01-01T00:00:01.000Z",
        message: {
          role: "assistant",
          provider: "anthropic",
          model: "claude-test",
          content: [
            { type: "thinking", thinking: "plan" },
            { type: "text", text: "done" },
            { type: "toolCall", id: "tc1", name: "read", arguments: { path: "a.ts" } },
          ],
        },
      },
      {
        type: "message",
        id: "tr1",
        parentId: "a1",
        timestamp: "2026-01-01T00:00:02.000Z",
        message: {
          role: "toolResult",
          toolCallId: "tc1",
          content: [
            { type: "text", text: "export {}" },
            { type: "image", mimeType: "image/png", data: "aW1hZ2U=" },
          ],
          details: { patch: "@@ patch", cwd: "/workspace", exitCode: 0 },
        },
      },
    ], { sessionId: "s1", directory: "/workspace" })

    expect(messages).toHaveLength(2)
    expect(messages[0]?.parts).toContainEqual(expect.objectContaining({
      type: "file",
      url: "/api/v1/sessions/s1/native/entries/u1/attachments/1",
      requiresAuth: true,
    }))
    expect(messages[1]?.info).toMatchObject({ role: "assistant", providerID: "anthropic", modelID: "claude-test" })
    const tool = messages[1]?.parts.find(part => part.type === "tool")
    expect(tool?.type === "tool" ? tool.state : null).toMatchObject({
      status: "completed",
      output: "export {}",
      metadata: {
        normalized: { patch: "@@ patch", cwd: "/workspace", exitCode: 0 },
        images: [{
          mimeType: "image/png",
          url: "/api/v1/sessions/s1/native/entries/tr1/attachments/1",
          requiresAuth: true,
        }],
      },
    })
  })
})
