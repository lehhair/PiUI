/**
 * Deterministic mock Pi runtime for tests — never calls a real model.
 */
import type { WorkerEvent } from "./types.js"

export interface MockTurn {
  userText: string
  assistantText: string
  thinking?: string
  tool?: { name: string; args: unknown; result: string; isError?: boolean }
}

let mockSeq = 0

export function nextMockIds() {
  mockSeq += 1
  const n = mockSeq
  return { user: `u${n}`, asst: `a${n}`, tool: `t${n}` }
}

export function* mockTurnEvents(
  turn: MockTurn,
  ids = nextMockIds(),
): Generator<WorkerEvent> {
  const now = Date.now() + mockSeq
  yield { type: "message_start", entryId: ids.user, role: "user", timestamp: now }
  yield {
    type: "message_end",
    entryId: ids.user,
    role: "user",
    parentId: null,
    timestamp: now,
    message: { role: "user", content: turn.userText },
  }

  yield { type: "message_start", entryId: ids.asst, role: "assistant", timestamp: now + 1 }

  const blocks: import("./types.js").PiContentBlock[] = []
  if (turn.thinking) blocks.push({ type: "thinking", thinking: turn.thinking })
  if (turn.assistantText) blocks.push({ type: "text", text: turn.assistantText.slice(0, Math.ceil(turn.assistantText.length / 2)) })
  yield { type: "message_update", entryId: ids.asst, content: [...blocks] }

  if (turn.assistantText) {
    blocks[blocks.length - 1] = { type: "text", text: turn.assistantText }
  }
  if (turn.tool) {
    blocks.push({
      type: "toolCall",
      id: ids.tool,
      name: turn.tool.name,
      arguments: turn.tool.args,
    })
  }
  yield { type: "message_update", entryId: ids.asst, content: [...blocks] }

  if (turn.tool) {
    yield {
      type: "tool_execution_start",
      toolCallId: ids.tool,
      toolName: turn.tool.name,
      args: turn.tool.args,
    }
    yield {
      type: "tool_execution_end",
      toolCallId: ids.tool,
      isError: turn.tool.isError,
      result: [{ type: "text", text: turn.tool.result }],
    }
  }

  yield {
    type: "message_end",
    entryId: ids.asst,
    role: "assistant",
    parentId: ids.user,
    timestamp: now + 2,
    message: { role: "assistant", content: blocks },
  }
  yield { type: "agent_end" }
}

export function runMockTurn(turn: MockTurn) {
  return [...mockTurnEvents(turn)]
}
