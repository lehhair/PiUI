/** Presentation + snapshot types (protocol v1). Native Pi details stay under native namespace. */

export type SessionStateV1 =
  | "idle"
  | "running"
  | "retrying"
  | "compacting"
  | "crashed"
  | "conflict"
  | "detached"

export interface ModelRefV1 {
  provider: string
  id: string
  displayName?: string
}

export interface QueueStateV1 {
  steering: unknown[]
  followUp: unknown[]
}

export interface ContextUsageV1 {
  inputTokens?: number
  outputTokens?: number
  contextTokens?: number
  contextWindow?: number
}

export interface TextContentV1 {
  type: "text"
  text: string
}

export interface ThinkingContentV1 {
  type: "thinking"
  text: string
}

export interface ToolPresentationV1 {
  type: "tool"
  callId: string
  name: string
  status: "pending" | "running" | "completed" | "error"
  input: unknown
  output?: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>
  isError?: boolean
  startedAt?: number
  endedAt?: number
  normalized?: {
    title?: string
    cwd?: string
    exitCode?: number
    patch?: string
  }
  nativeDetails?: unknown
}

export type AssistantContentV1 = TextContentV1 | ThinkingContentV1 | ToolPresentationV1

export interface UserTimelineItemV1 {
  type: "user"
  id: string
  entryId?: string
  parentEntryId?: string | null
  timestamp: number
  text: string
}

export interface AssistantTimelineItemV1 {
  type: "assistant"
  id: string
  entryId?: string
  parentEntryId?: string | null
  timestamp: number
  status: "streaming" | "completed" | "error" | "aborted"
  provider: string
  model: string
  stopReason?: string
  content: AssistantContentV1[]
}

export type TimelineItemV1 = UserTimelineItemV1 | AssistantTimelineItemV1

export interface PiSessionEntryBaseV1 {
  id: string
  parentId: string | null
  timestamp: string
}

export type PiSessionEntryV1 =
  | (PiSessionEntryBaseV1 & {
      type: "message"
      role: "user" | "assistant" | "toolResult" | "bashExecution" | "branchSummary" | "compactionSummary" | "custom"
      preview: string
    })
  | (PiSessionEntryBaseV1 & { type: "thinking_level_change"; thinkingLevel: string })
  | (PiSessionEntryBaseV1 & { type: "model_change"; provider: string; modelId: string })
  | (PiSessionEntryBaseV1 & {
      type: "compaction"
      summary: string
      firstKeptEntryId: string
      tokensBefore: number
    })
  | (PiSessionEntryBaseV1 & { type: "branch_summary"; fromId: string; summary: string })
  | (PiSessionEntryBaseV1 & { type: "custom"; customType: string })
  | (PiSessionEntryBaseV1 & { type: "custom_message"; customType: string; preview: string; display: boolean })
  | (PiSessionEntryBaseV1 & { type: "label"; targetId: string; label?: string })
  | (PiSessionEntryBaseV1 & { type: "session_info"; name?: string })

export interface PiSessionTreeNodeV1 {
  entry: PiSessionEntryV1
  children: PiSessionTreeNodeV1[]
  label?: string
  labelTimestamp?: string
}

export interface SessionReplacementResultV1 {
  sourceSessionId: string
  targetSessionId: string
  targetSessionFile?: string
  targetCwd?: string
  selectedText?: string
  cancelled: boolean
}

export interface SessionSnapshotV1 {
  protocolVersion: 1
  epoch: string
  sequence: number
  session: {
    id: string
    workspaceId: string
    driverId: "pi"
    driverSessionId: string
    title?: string
    state: SessionStateV1
    createdAt: string
    updatedAt: string
  }
  runtime: {
    attached: boolean
    model?: ModelRefV1
    thinkingLevel: string
    availableThinkingLevels: string[]
    isStreaming: boolean
    isCompacting: boolean
    queue: QueueStateV1
    contextUsage?: ContextUsageV1
    activeTools: string[]
    workerGeneration?: string
    runtimeError?: string
  }
  timeline: TimelineItemV1[]
  native: {
    namespace: "pi"
    schemaVersion: 1
    leafId: string | null
    entries: PiSessionEntryV1[]
    tree: PiSessionTreeNodeV1[]
  }
}
