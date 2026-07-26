/**
 * TimelineItemV1 -> UI Message
 * Keeps the current renderer shape while avoiding the legacy API envelope.
 */
import type {
  AssistantTimelineItemV1,
  SessionSnapshotV1,
  TimelineItemV1,
  ToolPresentationV1,
  UserTimelineItemV1,
} from "@piui/protocol"
import type { Message, Part } from "../types/message"

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
    metadata: {
      nativeDetails: tool.nativeDetails,
      normalized: tool.normalized,
      images: tool.output?.filter(output => output.type === 'image') ?? [],
    },
    time: {
      start: tool.startedAt ?? Date.now(),
      end: tool.endedAt ?? Date.now(),
    },
  }
}

function userToUi(
  item: UserTimelineItemV1,
  sessionID: string,
  model = { providerID: "pi", modelID: "pi" },
): Message {
  const partId = `${item.id}-text`
  return {
    info: {
      id: item.id,
      entryId: item.entryId,
      sessionID,
      role: "user",
      time: { created: item.timestamp },
      agent: "build",
      model,
    },
    parts: [
      {
        id: partId,
        sessionID,
        messageID: item.id,
        type: "text",
        text: item.text,
      },
    ],
  }
}

function assistantToUi(item: AssistantTimelineItemV1, sessionID: string, parentID: string): Message {
  const parts: Part[] = []
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
      })
    } else if (block.type === "thinking") {
      parts.push({
        id: partId,
        sessionID,
        messageID: item.id,
        type: "reasoning",
        text: block.text,
        time: { start: item.timestamp, end: item.timestamp },
      })
    } else if (block.type === "tool") {
      parts.push({
        id: partId,
        sessionID,
        messageID: item.id,
        type: "tool",
        callID: block.callId,
        tool: block.name,
        state: toolState(block),
      })
    }
  }

  const completed = item.status === "completed" || item.status === "error" || item.status === "aborted"
  return {
    info: {
      id: item.id,
      entryId: item.entryId,
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
    isStreaming: !completed,
  }
}

export function timelineToUiMessages(
  timeline: TimelineItemV1[],
  sessionID: string,
  model?: { providerID: string; modelID: string },
): Message[] {
  const out: Message[] = []
  let lastUserId = "root"
  for (const item of timeline) {
    if (item.type === "user") {
      out.push(userToUi(item, sessionID, model))
      lastUserId = item.id
    } else if (item.type === "assistant") {
      out.push(assistantToUi(item, sessionID, item.parentEntryId ?? lastUserId))
    }
  }
  return out
}

export function snapshotToUiMessages(snapshot: SessionSnapshotV1): Message[] {
  const model = snapshot.runtime.model
    ? { providerID: snapshot.runtime.model.provider, modelID: snapshot.runtime.model.id }
    : undefined
  return timelineToUiMessages(snapshot.timeline, snapshot.session.id, model)
}
