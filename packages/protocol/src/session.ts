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
  description: string
  parameters: unknown
  promptGuidelines?: string[]
  sourceInfo: unknown
}

export type CompactionCommandResultV1 =
  | { status: "completed"; result: CompactionResultV1 }
  | { status: "skipped"; reason: "session_too_small" | "already_compacted"; message: string }
  | { status: "aborted" }

export interface ContextUsageV1 {
  inputTokens?: number
  outputTokens?: number
  contextTokens: number | null
  contextWindow?: number
  percent?: number | null
}

export interface SessionStatsV1 {
  userMessages: number
  assistantMessages: number
  toolCalls: number
  toolResults: number
  totalMessages: number
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number }
  cost: number
}

export interface ScopedModelV1 {
  provider: string
  id: string
  displayName?: string
  thinkingLevel?: string
}

export type CustomMessageContentV1 =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }

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
  output?: Array<{ type: "text"; text: string } | {
    type: "image"
    entryId: string
    blockIndex: number
    mimeType: string
    byteLength: number
  }>
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

export interface UserTimelineAttachmentV1 {
  type: "image"
  mimeType: string
  blockIndex: number
  byteLength: number
}

export interface UserTimelineItemV1 {
  type: "user"
  id: string
  entryId?: string
  parentEntryId?: string | null
  timestamp: number
  text: string
  attachments?: UserTimelineAttachmentV1[]
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

export type PiNativeJsonValueV1 = null | boolean | number | string | PiNativeJsonValueV1[] | {
  [key: string]: PiNativeJsonValueV1
}

export interface PiNativeTreeRefV1 {
  entryId: string
  children: PiNativeTreeRefV1[]
  label?: string
  labelTimestamp?: string
}

/** JSON-structural copy of Pi's native session data. Presentation projections
 * must never be used to reconstruct this envelope. */
export interface PiNativeSessionEnvelopeV1 {
  namespace: "pi"
  schemaVersion: 1
  sdkVersion: string
  revision: number
  sessionFormatVersion?: number
  header: PiNativeJsonValueV1 | null
  leafId: string | null
  entries: Array<{ [key: string]: PiNativeJsonValueV1 }>
  tree: Array<{ [key: string]: PiNativeJsonValueV1 }>
}

export interface PiNativeSessionHeadV1 {
  namespace: "pi"
  schemaVersion: 1
  sdkVersion: string
  revision: number
  sessionFormatVersion?: number
  epoch: string
  header: PiNativeJsonValueV1 | null
  leafId: string | null
  entryCount: number
}

export interface PiNativeEntriesPageV1 {
  head: PiNativeSessionHeadV1
  items: Array<{ [key: string]: PiNativeJsonValueV1 }>
  beforeCursor?: string
  hasMore: boolean
}

export interface PiTimelinePageV1 {
  items: TimelineItemV1[]
  beforeCursor?: string
  hasMore: boolean
}

export interface SessionReplacementResultV1 {
  operation?: "new" | "fork" | "clone" | "switch" | "import"
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
  summaryEntry?: { [key: string]: PiNativeJsonValueV1 }
}

export interface SessionSnapshotV1 {
  protocolVersion: 1
  epoch: string
  sequence: number
  session: {
    id: string
    /** Canonical workspace root; also how a workspace is addressed. */
    directory: string
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
    isBashRunning?: boolean
    hasPendingBashMessages?: boolean
    isRetrying?: boolean
    retryAttempt?: number
    pendingMessageCount?: number
    queue: QueueStateV1
    retry: RetryStateV1
    compaction: CompactionStateV1
    contextUsage?: ContextUsageV1
    sessionStats?: SessionStatsV1
    scopedModels?: ScopedModelV1[]
    tools: PiToolInfoV1[]
    activeTools: string[]
    workerGeneration?: string
    runtimeError?: string
  }
  /** Most recent presentation page only. Older pages are loaded explicitly. */
  timeline: TimelineItemV1[]
  timelinePage: Omit<PiTimelinePageV1, "items">
  native: PiNativeSessionHeadV1
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
  if (!optionalBoolean(value.isBashRunning) ||
    !optionalBoolean(value.hasPendingBashMessages) ||
    !optionalBoolean(value.isRetrying) ||
    !optionalNonNegativeInteger(value.retryAttempt) ||
    !optionalNonNegativeInteger(value.pendingMessageCount)) {
    return false
  }
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

function optionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === "boolean"
}
