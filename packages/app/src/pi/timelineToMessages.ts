/**
 * TimelineItemV1 → ApiMessageWithParts
 * 过渡层：让现有 MessageRenderer / messageStore 能渲染 Pi timeline。
 * Phase 后续应让 ChatArea 直接吃 TimelineItem，本文件可删。
 */
import type {
  AssistantTimelineItemV1,
  SessionSnapshotV1,
  TimelineItemV1,
  ToolPresentationV1,
  UserTimelineItemV1,
} from "@piui/protocol"
import type { ApiMessageWithParts, ApiPart } from "../api/types"

function toolState(tool: ToolPresentationV1) {
  const input =
    tool.input && typeof tool.input === "object" && !Array.isArray(tool.input)
      ? (tool.input as Record<string, unknown>)
      : { value: tool.input }

  const outputText =
    tool.output
      ?.filter((o): o is { type: "text"; text: string } => o.type === "text")
      .map(o => o.text)
      .join("") ?? ""

  if (tool.status === "pending") {
    return { status: "pending" as const, input }
  }
  if (tool.status === "running") {
    return {
      status: "running" as const,
      input,
      title: tool.name,
      time: { start: tool.startedAt ?? Date.now() },
    }
  }
  if (tool.status === "error") {
    return {
      status: "error" as const,
      input,
      error: outputText || "tool error",
      time: {
        start: tool.startedAt ?? Date.now(),
        end: tool.endedAt ?? Date.now(),
      },
    }
  }
  return {
    status: "completed" as const,
    input,
    output: outputText,
    title: tool.normalized?.title ?? tool.name,
    metadata: {},
    time: {
      start: tool.startedAt ?? Date.now(),
      end: tool.endedAt ?? Date.now(),
    },
  }
}

function userToApi(item: UserTimelineItemV1, sessionID: string): ApiMessageWithParts {
  const partId = `${item.id}-text`
  return {
    info: {
      id: item.id,
      sessionID,
      role: "user",
      time: { created: item.timestamp },
      agent: "build",
      model: { providerID: "mock", modelID: "mock" },
    },
    parts: [
      {
        id: partId,
        sessionID,
        messageID: item.id,
        type: "text",
        text: item.text,
      } as ApiPart,
    ],
  }
}

function assistantToApi(item: AssistantTimelineItemV1, sessionID: string, parentID: string): ApiMessageWithParts {
  const parts: ApiPart[] = []
  let i = 0
  for (const block of item.content) {
    i++
    const partId = `${item.id}-p${i}`
    if (block.type === "text") {
      parts.push({
        id: partId,
        sessionID,
        messageID: item.id,
        type: "text",
        text: block.text,
      } as ApiPart)
    } else if (block.type === "thinking") {
      parts.push({
        id: partId,
        sessionID,
        messageID: item.id,
        type: "reasoning",
        text: block.text,
        time: { start: item.timestamp, end: item.timestamp },
      } as ApiPart)
    } else if (block.type === "tool") {
      parts.push({
        id: partId,
        sessionID,
        messageID: item.id,
        type: "tool",
        callID: block.callId,
        tool: block.name,
        state: toolState(block),
      } as ApiPart)
    }
  }

  const completed = item.status === "completed" || item.status === "error" || item.status === "aborted"
  return {
    info: {
      id: item.id,
      sessionID,
      role: "assistant",
      parentID,
      modelID: item.model || "mock",
      providerID: item.provider || "mock",
      mode: "chat",
      agent: "build",
      path: { cwd: "", root: "" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: {
        created: item.timestamp,
        completed: completed ? item.timestamp + 1 : undefined,
      },
      finish: item.status === "aborted" ? "aborted" : item.status === "error" ? "error" : "stop",
    },
    parts,
  }
}

export function timelineToApiMessages(
  timeline: TimelineItemV1[],
  sessionID: string,
): ApiMessageWithParts[] {
  const out: ApiMessageWithParts[] = []
  let lastUserId = "root"
  for (const item of timeline) {
    if (item.type === "user") {
      out.push(userToApi(item, sessionID))
      lastUserId = item.id
    } else if (item.type === "assistant") {
      out.push(assistantToApi(item, sessionID, item.parentEntryId ?? lastUserId))
    }
  }
  return out
}

export function snapshotToApiMessages(snapshot: SessionSnapshotV1): ApiMessageWithParts[] {
  return timelineToApiMessages(snapshot.timeline, snapshot.session.id)
}
