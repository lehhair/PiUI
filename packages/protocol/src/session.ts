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
  }
  timeline: TimelineItemV1[]
  native: {
    namespace: "pi"
    schemaVersion: 1
    leafId: string | null
    entries: unknown[]
    tree: unknown[]
  }
}
