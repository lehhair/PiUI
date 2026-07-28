import type { Message, Part, ToolPart, ToolState } from "../types/message"
import { piNativeAttachmentUrl } from "./sessionApi"

export type PiNativeEntry = Record<string, unknown>

export interface NativeToolExecution {
  status: "running" | "completed" | "error"
  args?: unknown
  result?: unknown
  details?: unknown
  startedAt?: number
  endedAt?: number
}

interface NativeMessageOptions {
  sessionId: string
  directory: string
  model?: { providerID: string; modelID: string }
  streamingEntryIds?: ReadonlySet<string>
  liveTools?: ReadonlyMap<string, NativeToolExecution>
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function asBlocks(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(asRecord).filter(block => Object.keys(block).length > 0) : []
}

function entryTimestamp(entry: PiNativeEntry, message: Record<string, unknown>): number {
  if (typeof message.timestamp === "number") return message.timestamp
  if (typeof entry.timestamp === "number") return entry.timestamp
  if (typeof entry.timestamp === "string") {
    const parsed = Date.parse(entry.timestamp)
    if (Number.isFinite(parsed)) return parsed
  }
  return 0
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content
  return asBlocks(content)
    .filter(block => block.type === "text" && typeof block.text === "string")
    .map(block => String(block.text))
    .join("")
}

function imageFilename(mimeType: string, index: number): string {
  const subtype = mimeType.split("/", 2)[1]?.split("+", 1)[0]?.replace(/[^a-z0-9]/gi, "") || "image"
  return `image-${index + 1}.${subtype === "jpeg" ? "jpg" : subtype}`
}

function normalizedDetails(details: unknown): Record<string, unknown> {
  const native = asRecord(details)
  return {
    patch: typeof native.patch === "string" ? native.patch : typeof native.diff === "string" ? native.diff : undefined,
    cwd: typeof native.cwd === "string" ? native.cwd : undefined,
    exitCode: typeof native.exitCode === "number" ? native.exitCode : undefined,
  }
}

function resultBlocks(value: unknown): Record<string, unknown>[] {
  if (typeof value === "string") return [{ type: "text", text: value }]
  const record = asRecord(value)
  if (Array.isArray(record.content)) return asBlocks(record.content)
  return asBlocks(value)
}

function applyToolResult(
  tool: ToolPart,
  result: unknown,
  details: unknown,
  isError: boolean,
  sessionId: string,
  entryId: string | undefined,
  endedAt: number,
): void {
  const blocks = resultBlocks(result)
  const output = blocks
    .filter(block => block.type === "text" && typeof block.text === "string")
    .map(block => String(block.text))
    .join("")
  const images = entryId
    ? blocks.flatMap((block, blockIndex) => block.type === "image" && typeof block.mimeType === "string"
      ? [{ mimeType: block.mimeType, url: piNativeAttachmentUrl(sessionId, entryId, blockIndex), requiresAuth: true }]
      : [])
    : []
  const native = asRecord(details)
  const normalized = normalizedDetails(details)
  const metadata = {
    ...native,
    nativeDetails: details,
    normalized,
    images,
    diff: normalized.patch ?? native.patch ?? native.diff,
    cwd: normalized.cwd ?? native.cwd,
    exit: normalized.exitCode ?? native.exitCode,
  }
  const input = tool.state.input ?? {}
  const start = tool.state.time?.start ?? endedAt
  tool.state = isError
    ? { status: "error", input, error: output || "tool error", metadata, time: { start, end: endedAt } }
    : { status: "completed", input, output, title: tool.tool, metadata, time: { start, end: endedAt } }
}

function userMessage(entry: PiNativeEntry, message: Record<string, unknown>, options: NativeMessageOptions): Message {
  const id = String(entry.id)
  const timestamp = entryTimestamp(entry, message)
  const content = message.content
  const parts: Part[] = [{ id: `${id}-text`, sessionID: options.sessionId, messageID: id, type: "text", text: textFromContent(content) }]
  if (Array.isArray(content)) {
    let imageIndex = 0
    asBlocks(content).forEach((block, blockIndex) => {
      if (block.type !== "image" || typeof block.mimeType !== "string") return
      parts.push({
        id: `${id}-attachment-${blockIndex}`,
        sessionID: options.sessionId,
        messageID: id,
        type: "file",
        mime: block.mimeType,
        filename: imageFilename(block.mimeType, imageIndex++),
        url: piNativeAttachmentUrl(options.sessionId, id, blockIndex),
        requiresAuth: true,
      })
    })
  }
  return {
    info: {
      id,
      entryId: id,
      sessionID: options.sessionId,
      role: "user",
      time: { created: timestamp },
      agent: "build",
      model: options.model ?? { providerID: "pi", modelID: "pi" },
    },
    parts,
  }
}

function assistantMessage(
  entry: PiNativeEntry,
  message: Record<string, unknown>,
  parentId: string,
  options: NativeMessageOptions,
): Message {
  const id = String(entry.id)
  const timestamp = entryTimestamp(entry, message)
  const streaming = options.streamingEntryIds?.has(id) ?? false
  const parts: Part[] = []
  asBlocks(typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content).forEach((block, index) => {
    const partId = `${id}-p${index + 1}`
    if (block.type === "text" && typeof block.text === "string") {
      parts.push({ id: partId, sessionID: options.sessionId, messageID: id, type: "text", text: block.text })
    } else if (block.type === "thinking" && typeof block.thinking === "string") {
      parts.push({
        id: partId,
        sessionID: options.sessionId,
        messageID: id,
        type: "reasoning",
        text: block.thinking,
        time: { start: timestamp, end: streaming ? undefined : timestamp },
      })
    } else if (block.type === "toolCall" && typeof block.id === "string") {
      const input = asRecord(block.arguments)
      const live = options.liveTools?.get(block.id)
      let state: ToolState = { status: "pending", input }
      if (live) {
        const liveInput = Object.keys(asRecord(live.args)).length ? asRecord(live.args) : input
        if (live.status === "running") {
          state = {
            status: "running",
            input: liveInput,
            output: resultBlocks(live.result).filter(item => item.type === "text").map(item => String(item.text ?? "")).join(""),
            metadata: { ...asRecord(live.details), nativeDetails: live.details, normalized: normalizedDetails(live.details) },
            time: { start: live.startedAt ?? timestamp },
          }
        } else {
          state = { status: "pending", input: liveInput, time: { start: live.startedAt ?? timestamp } }
        }
      }
      const tool: ToolPart = {
        id: partId,
        sessionID: options.sessionId,
        messageID: id,
        type: "tool",
        callID: block.id,
        tool: typeof block.name === "string" ? block.name : "tool",
        state,
      }
      if (live && live.status !== "running") {
        applyToolResult(tool, live.result, live.details, live.status === "error", options.sessionId, undefined, live.endedAt ?? timestamp)
      }
      parts.push(tool)
    }
  })
  const stopReason = typeof message.stopReason === "string" ? message.stopReason : undefined
  return {
    info: {
      id,
      entryId: id,
      sessionID: options.sessionId,
      role: "assistant",
      parentID: parentId,
      modelID: typeof message.model === "string" ? message.model : options.model?.modelID ?? "pi",
      providerID: typeof message.provider === "string" ? message.provider : options.model?.providerID ?? "pi",
      mode: "chat",
      agent: "build",
      path: { cwd: options.directory, root: options.directory },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: timestamp, completed: streaming ? undefined : timestamp + 1 },
      finish: stopReason === "aborted" ? "aborted" : stopReason === "error" ? "error" : stopReason ?? "stop",
    },
    parts,
    isStreaming: streaming,
  }
}

export function nativeEntriesToUiMessages(entries: PiNativeEntry[], options: NativeMessageOptions): Message[] {
  const messages: Message[] = []
  const tools = new Map<string, ToolPart>()
  let lastUserId = "root"
  for (const entry of entries) {
    if (entry.type !== "message" || typeof entry.id !== "string") continue
    const message = asRecord(entry.message)
    if (message.role === "user") {
      const projected = userMessage(entry, message, options)
      messages.push(projected)
      lastUserId = projected.info.id
    } else if (message.role === "assistant") {
      const projected = assistantMessage(entry, message, lastUserId, options)
      messages.push(projected)
      for (const part of projected.parts) if (part.type === "tool") tools.set(part.callID, part)
    } else if (message.role === "toolResult" && typeof message.toolCallId === "string") {
      const tool = tools.get(message.toolCallId)
      if (!tool) continue
      applyToolResult(
        tool,
        message.content ?? message.result,
        message.details,
        message.isError === true,
        options.sessionId,
        entry.id,
        entryTimestamp(entry, message),
      )
    }
  }
  return messages
}
