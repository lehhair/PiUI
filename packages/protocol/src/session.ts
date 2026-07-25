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

export type QueueDeliveryModeV1 = "all" | "one-at-a-time"

export interface QueueStateV1 {
  steering: string[]
  followUp: string[]
  steeringMode: QueueDeliveryModeV1
  followUpMode: QueueDeliveryModeV1
}

export type RetryStateV1 =
  | { phase: "idle"; autoEnabled: boolean }
  | {
      phase: "waiting"
      autoEnabled: boolean
      attempt: number
      maxAttempts: number
      delayMs: number
      nextAttemptAt: string
      errorMessage: string
    }
  | { phase: "running"; autoEnabled: boolean; attempt: number; maxAttempts: number }
  | {
      phase: "finished"
      autoEnabled: boolean
      success: boolean
      attempt: number
      finalError?: string
    }

export interface CompactionResultV1 {
  summary: string
  firstKeptEntryId: string
  tokensBefore: number
  estimatedTokensAfter?: number
}

export type SummarizationOperationV1 =
  | { type: "none" }
  | {
      type: "compaction"
      phase: "running" | "retrying"
      reason: "manual" | "threshold" | "overflow"
      attempt?: number
      maxAttempts?: number
      delayMs?: number
      errorMessage?: string
    }
  | {
      type: "branchSummary"
      phase: "running" | "retrying"
      targetEntryId: string
      attempt?: number
      maxAttempts?: number
      delayMs?: number
      errorMessage?: string
    }

export interface CompactionStateV1 {
  autoEnabled: boolean
  operation: SummarizationOperationV1
  lastResult?: CompactionResultV1
  lastAborted?: boolean
  lastError?: string
  lastNotice?: string
}

export interface PiToolInfoV1 {
  name: string
  description?: string
  source?: string
}

export type CompactionCommandResultV1 =
  | { status: "completed"; result: CompactionResultV1 }
  | { status: "skipped"; reason: "session_too_small" | "already_compacted"; message: string }
  | { status: "aborted" }

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

export interface PiNavigationResultV1 {
  editorText?: string
  cancelled: boolean
  aborted?: boolean
  summaryEntry?: PiSessionEntryV1
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
    retry: RetryStateV1
    compaction: CompactionStateV1
    contextUsage?: ContextUsageV1
    tools: PiToolInfoV1[]
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

export function isQueueDeliveryModeV1(value: unknown): value is QueueDeliveryModeV1 {
  return value === "all" || value === "one-at-a-time"
}

export function isQueueStateV1(value: unknown): value is QueueStateV1 {
  if (!isRecord(value)) return false
  return isStringArray(value.steering) &&
    isStringArray(value.followUp) &&
    isQueueDeliveryModeV1(value.steeringMode) &&
    isQueueDeliveryModeV1(value.followUpMode)
}

export function isRetryStateV1(value: unknown): value is RetryStateV1 {
  if (!isRecord(value) || typeof value.autoEnabled !== "boolean") return false
  if (value.phase === "idle") return true
  if (value.phase === "running") {
    return isNonNegativeInteger(value.attempt) && isNonNegativeInteger(value.maxAttempts)
  }
  if (value.phase === "waiting") {
    return isNonNegativeInteger(value.attempt) &&
      isNonNegativeInteger(value.maxAttempts) &&
      isNonNegativeNumber(value.delayMs) &&
      typeof value.nextAttemptAt === "string" &&
      typeof value.errorMessage === "string"
  }
  if (value.phase === "finished") {
    return typeof value.success === "boolean" &&
      isNonNegativeInteger(value.attempt) &&
      (value.finalError === undefined || typeof value.finalError === "string")
  }
  return false
}

export function isCompactionStateV1(value: unknown): value is CompactionStateV1 {
  if (!isRecord(value) || typeof value.autoEnabled !== "boolean" || !isRecord(value.operation)) return false
  const operation = value.operation
  if (operation.type === "none") return true
  if (operation.phase !== "running" && operation.phase !== "retrying") return false
  if (operation.type === "compaction") {
    if (operation.reason !== "manual" && operation.reason !== "threshold" && operation.reason !== "overflow") {
      return false
    }
  } else if (operation.type === "branchSummary") {
    if (typeof operation.targetEntryId !== "string" || !operation.targetEntryId) return false
  } else {
    return false
  }
  return optionalNonNegativeInteger(operation.attempt) &&
    optionalNonNegativeInteger(operation.maxAttempts) &&
    optionalNonNegativeNumber(operation.delayMs) &&
    (operation.errorMessage === undefined || typeof operation.errorMessage === "string")
}

export function isRuntimeControlStateV1(value: unknown): value is Pick<
  SessionSnapshotV1["runtime"],
  "queue" | "retry" | "compaction" | "tools" | "activeTools"
> {
  if (!isRecord(value)) return false
  return isQueueStateV1(value.queue) &&
    isRetryStateV1(value.retry) &&
    isCompactionStateV1(value.compaction) &&
    Array.isArray(value.tools) &&
    value.tools.every(tool => isRecord(tool) &&
      typeof tool.name === "string" &&
      (tool.description === undefined || typeof tool.description === "string") &&
      (tool.source === undefined || typeof tool.source === "string")) &&
    isStringArray(value.activeTools)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === "string")
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
}

function isNonNegativeInteger(value: unknown): value is number {
  return isNonNegativeNumber(value) && Number.isInteger(value)
}

function optionalNonNegativeNumber(value: unknown): boolean {
  return value === undefined || isNonNegativeNumber(value)
}

function optionalNonNegativeInteger(value: unknown): boolean {
  return value === undefined || isNonNegativeInteger(value)
}
