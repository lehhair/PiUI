import type {
  AssistantTimelineItemV1,
  TimelineItemV1,
  ToolPresentationV1,
  UserTimelineItemV1,
} from "@piui/protocol"
import type { PiContentBlock, PiEntry, WorkerEvent } from "./types.js"

export interface ProjectionState {
  timeline: TimelineItemV1[]
  /** entryId -> timeline index for streaming updates */
  byEntryId: Map<string, number>
  toolsByCallId: Map<string, { timelineId: string; toolIndex: number }>
  isStreaming: boolean
}

export function createProjectionState(): ProjectionState {
  return {
    timeline: [],
    byEntryId: new Map(),
    toolsByCallId: new Map(),
    isStreaming: false,
  }
}

function textFromContent(content: PiContentBlock[] | string | undefined): string {
  if (content == null) return ""
  if (typeof content === "string") return content
  return content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map(b => b.text)
    .join("")
}

function assistantContentFromBlocks(blocks: PiContentBlock[] | undefined): AssistantTimelineItemV1["content"] {
  if (!blocks) return []
  const out: AssistantTimelineItemV1["content"] = []
  for (const b of blocks) {
    if (b.type === "text") out.push({ type: "text", text: b.text })
    else if (b.type === "thinking") out.push({ type: "thinking", text: b.thinking })
    else if (b.type === "toolCall") {
      out.push({
        type: "tool",
        callId: b.id,
        name: b.name,
        status: "pending",
        input: b.arguments,
      })
    }
  }
  return out
}

/** Build timeline from persisted Pi-like entries (JSONL projection). */
export function projectEntries(entries: PiEntry[]): ProjectionState {
  const state = createProjectionState()
  for (const e of entries) {
    if (e.type !== "message") continue
    if (e.message.role === "user") {
      const item: UserTimelineItemV1 = {
        type: "user",
        id: e.id,
        entryId: e.id,
        parentEntryId: e.parentId,
        timestamp: e.timestamp,
        text: textFromContent(e.message.content),
      }
      state.timeline.push(item)
      state.byEntryId.set(e.id, state.timeline.length - 1)
    } else if (e.message.role === "assistant") {
      const content = assistantContentFromBlocks(
        typeof e.message.content === "string"
          ? [{ type: "text", text: e.message.content }]
          : e.message.content,
      )
      const item: AssistantTimelineItemV1 = {
        type: "assistant",
        id: e.id,
        entryId: e.id,
        parentEntryId: e.parentId,
        timestamp: e.timestamp,
        status: e.message.stopReason === "error"
          ? "error"
          : e.message.stopReason === "aborted"
            ? "aborted"
            : "completed",
        provider: e.message.provider ?? "mock",
        model: e.message.model ?? "mock",
        stopReason: e.message.stopReason,
        content,
      }
      state.timeline.push(item)
      const idx = state.timeline.length - 1
      state.byEntryId.set(e.id, idx)
      content.forEach((c, i) => {
        if (c.type === "tool") {
          state.toolsByCallId.set(c.callId, { timelineId: e.id, toolIndex: i })
        }
      })
    } else if (e.message.role === "toolResult" && e.message.toolCallId) {
      applyToolResult(state, e.message.toolCallId, {
        role: "toolResult",
        toolCallId: e.message.toolCallId,
        toolName: e.message.toolName,
        isError: e.message.isError,
        result: e.message.result,
        content: e.message.content,
      })
    }
  }
  return state
}

function applyToolResult(
  state: ProjectionState,
  toolCallId: string,
  message: PiEntry["message"] & { role: "toolResult" },
) {
  const ref = state.toolsByCallId.get(toolCallId)
  if (!ref) return
  const item = state.timeline[state.byEntryId.get(ref.timelineId)!]
  if (!item || item.type !== "assistant") return
  const tool = item.content[ref.toolIndex]
  if (!tool || tool.type !== "tool") return
  const t = tool as ToolPresentationV1
  t.status = message.isError ? "error" : "completed"
  t.isError = message.isError
  t.endedAt = Date.now()
  let text = ""
  if (typeof message.result === "string") text = message.result
  else if (Array.isArray(message.result)) {
    text = message.result.map(r => r.text).join("")
  } else if (message.content) {
    text = textFromContent(message.content)
  }
  t.output = text ? [{ type: "text", text }] : undefined
}

/** Apply streaming worker events onto projection (pure reducer). */
export function applyWorkerEvent(state: ProjectionState, event: WorkerEvent): ProjectionState {
  const next: ProjectionState = {
    timeline: state.timeline.slice(),
    byEntryId: new Map(state.byEntryId),
    toolsByCallId: new Map(state.toolsByCallId),
    isStreaming: state.isStreaming,
  }

  switch (event.type) {
    case "message_start": {
      next.isStreaming = event.role === "assistant"
      if (event.role === "user") {
        const item: UserTimelineItemV1 = {
          type: "user",
          id: event.entryId,
          entryId: event.entryId,
          timestamp: event.timestamp,
          text: "",
        }
        next.timeline.push(item)
        next.byEntryId.set(event.entryId, next.timeline.length - 1)
      } else {
        const item: AssistantTimelineItemV1 = {
          type: "assistant",
          id: event.entryId,
          entryId: event.entryId,
          timestamp: event.timestamp,
          status: "streaming",
          provider: "mock",
          model: "mock",
          content: [],
        }
        next.timeline.push(item)
        next.byEntryId.set(event.entryId, next.timeline.length - 1)
      }
      break
    }
    case "message_update": {
      const idx = next.byEntryId.get(event.entryId)
      if (idx == null) break
      const item = next.timeline[idx]
      if (!item || item.type !== "assistant") break
      const content = assistantContentFromBlocks(event.content)
      const updated: AssistantTimelineItemV1 = {
        ...item,
        content,
        status: "streaming",
      }
      next.timeline[idx] = updated
      next.toolsByCallId = new Map(
        [...next.toolsByCallId].filter(([, v]) => v.timelineId !== event.entryId),
      )
      content.forEach((c, i) => {
        if (c.type === "tool") {
          next.toolsByCallId.set(c.callId, { timelineId: event.entryId, toolIndex: i })
        }
      })
      break
    }
    case "message_end": {
      if (event.role === "toolResult" && event.message.toolCallId) {
        applyToolResult(next, event.message.toolCallId, {
          ...event.message,
          role: "toolResult",
        })
        break
      }
      const idx = next.byEntryId.get(event.entryId)
      if (idx == null) {
        // late create
        if (event.role === "user") {
          next.timeline.push({
            type: "user",
            id: event.entryId,
            entryId: event.entryId,
            parentEntryId: event.parentId,
            timestamp: event.timestamp,
            text: textFromContent(event.message.content),
          })
          next.byEntryId.set(event.entryId, next.timeline.length - 1)
        }
        break
      }
      const item = next.timeline[idx]
      if (item?.type === "assistant") {
        const prevTools = new Map(
          item.content
            .filter((c): c is ToolPresentationV1 => c.type === "tool")
            .map(c => [c.callId, c]),
        )
        const content = assistantContentFromBlocks(
          typeof event.message.content === "string"
            ? [{ type: "text", text: event.message.content }]
            : event.message.content,
        ).map(c => {
          if (c.type !== "tool") return c
          const prev = prevTools.get(c.callId)
          return prev ? { ...c, ...prev, input: c.input, name: c.name, callId: c.callId } : c
        })
        next.timeline[idx] = {
          ...item,
          status: "completed",
          content,
          parentEntryId: event.parentId,
        }
        content.forEach((c, i) => {
          if (c.type === "tool") {
            next.toolsByCallId.set(c.callId, { timelineId: event.entryId, toolIndex: i })
          }
        })
      } else if (item?.type === "user") {
        next.timeline[idx] = {
          ...item,
          text: textFromContent(event.message.content),
          parentEntryId: event.parentId,
        }
      }
      break
    }
    case "tool_execution_start": {
      const ref = next.toolsByCallId.get(event.toolCallId)
      if (!ref) break
      const item = next.timeline[next.byEntryId.get(ref.timelineId)!]
      if (item?.type !== "assistant") break
      const tool = item.content[ref.toolIndex]
      if (tool?.type !== "tool") break
      const content = item.content.slice()
      content[ref.toolIndex] = {
        ...tool,
        status: "running",
        name: event.toolName || tool.name,
        input: event.args ?? tool.input,
        startedAt: Date.now(),
      }
      next.timeline[next.byEntryId.get(ref.timelineId)!] = { ...item, content }
      break
    }
    case "tool_execution_end": {
      applyToolResult(next, event.toolCallId, {
        role: "toolResult",
        toolCallId: event.toolCallId,
        isError: event.isError,
        result: event.result,
      })
      break
    }
    case "agent_end": {
      next.isStreaming = false
      for (let i = 0; i < next.timeline.length; i++) {
        const it = next.timeline[i]
        if (it?.type === "assistant" && it.status === "streaming") {
          next.timeline[i] = { ...it, status: "completed" }
        }
      }
      break
    }
  }

  return next
}
