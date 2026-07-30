/**
 * Pi domain types - Direct re-export from official SDK.
 *
 * These types are the single source of truth for Pi data structures.
 * They automatically stay in sync when the SDK is upgraded.
 * Never manually duplicate or transform these types.
 */

// Session entries and metadata
export type {
  SessionEntry,
  SessionEntryBase,
  SessionMessageEntry,
  ThinkingLevelChangeEntry,
  ModelChangeEntry,
  CompactionEntry,
  BranchSummaryEntry,
  CustomEntry,
  CustomMessageEntry,
  SessionInfoEntry,
  SessionInfo,
  SessionHeader,
  SessionTreeNode,
  SessionContext,
} from '@earendil-works/pi-coding-agent'

// Agent messages and content blocks
export type {
  AgentMessage,
  AgentEvent,
  ThinkingLevel,
} from '@earendil-works/pi-agent-core'
export type {
  UserMessage,
  AssistantMessage,
  ToolResultMessage,
  TextContent,
  ThinkingContent,
  ImageContent,
  ToolCall,
  Usage,
  StopReason,
  Model,
} from '@earendil-works/pi-ai'

// Agent session runtime
export type {
  AgentSessionEvent,
  AgentSessionConfig,
  SessionStats,
  PromptOptions,
  ModelCycleResult,
} from '@earendil-works/pi-coding-agent'

// Custom messages (bashExecution, custom, branchSummary, compactionSummary)
// The coding agent merges these into AgentMessage via declaration merging
// (see SDK core/messages.d.ts). Extract them from the union — zero hand-written
// structure, SDK upgrades propagate automatically.
export type BashExecutionMessage = Extract<AgentMessage, { role: 'bashExecution' }>
export type CustomMessage = Extract<AgentMessage, { role: 'custom' }>
export type BranchSummaryMessage = Extract<AgentMessage, { role: 'branchSummary' }>
export type CompactionSummaryMessage = Extract<AgentMessage, { role: 'compactionSummary' }>

// Registry
export type {
  ToolDescriptor,
  CommandDescriptor,
  ExtensionDescriptor,
  PiCapability,
  PiRegistrySnapshot,
  HostCapability,
  HostRegistrySnapshot,
} from '@piui/protocol'

// Protocol primitives
export type {
  JsonValue,
  JsonObject,
  CommandEnvelope,
  CommandRecord,
  CommandStatus,
  EventEnvelope,
  EventCursor,
  EventChannel,
  EventStreamRef,
  Problem,
  ErrorCode,
} from '@piui/protocol'

// ============================================================
// PiUI-specific derived view models (not domain types)
// ============================================================

import type { SessionEntry } from '@earendil-works/pi-coding-agent'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type {
  UserMessage,
  AssistantMessage,
  ToolResultMessage,
  TextContent,
  ThinkingContent,
  ImageContent,
  ToolCall,
} from '@earendil-works/pi-ai'
import type { JsonObject, EntriesPage, BranchCheckpoint, LiveMessage } from '@piui/protocol'

/**
 * Pi Session row for sidebar display.
 * Derived from SessionInfo for UI consumption.
 */
export type PiSessionRow = {
  id: string
  sessionFile: string
  cwd: string
  title: string
  preview?: string
  createdAt: number
  modifiedAt: number
  messageCount: number
  parentSessionPath?: string
  forkParent?: {
    id: string
    title: string
  }
}

/**
 * Pi timeline item for chat rendering.
 * Each item preserves its raw entry and provides type-safe rendering data.
 * Tool results are paired back into their owning assistant item so the
 * message keeps its embedded tool calls (matching chat UI structure).
 */
export type PiTimelineItem =
  | PiUserMessageItem
  | PiAssistantMessageItem
  | PiBashExecutionItem
  | PiCompactionItem
  | PiBranchSummaryItem
  | PiCustomMessageItem
  | PiUnknownItem

export type PiUserMessageItem = {
  kind: 'user_message'
  entryId: string
  timestamp: number
  rawEntry: SessionEntry
  message: UserMessage
  blocks: (TextContent | ImageContent)[]
}

export type PiAssistantMessageItem = {
  kind: 'assistant_message'
  entryId: string
  timestamp: number
  rawEntry: SessionEntry
  message: AssistantMessage
  blocks: (TextContent | ThinkingContent | ToolCall)[]
  /** Tool results paired by toolCallId; empty while a call has no result yet */
  toolResults: Record<string, ToolResultMessage>
  /** True for the live streaming message (not yet persisted as an entry) */
  isStreaming?: boolean
}

export type PiBashExecutionItem = {
  kind: 'bash_execution'
  entryId: string
  timestamp: number
  rawEntry: SessionEntry
  message: BashExecutionMessage
}

/**
 * One tool execution: the call plus its result (absent while pending).
 * The neutral contract for the tool rendering chain.
 */
export type PiToolExecution = {
  call: ToolCall
  result?: ToolResultMessage
}

export type PiCompactionItem = {
  kind: 'compaction'
  entryId: string
  timestamp: number
  rawEntry: SessionEntry
  summary: string
  tokensBefore: number
  firstKeptEntryId: string
  details?: unknown
}

export type PiBranchSummaryItem = {
  kind: 'branch_summary'
  entryId: string
  timestamp: number
  rawEntry: SessionEntry
  summary: string
  fromId: string
  details?: unknown
}

export type PiCustomMessageItem = {
  kind: 'custom_message'
  entryId: string
  timestamp: number
  rawEntry: SessionEntry
  customType: string
  content: string | (TextContent | ImageContent)[]
  display: boolean
  details?: unknown
}

export type PiUnknownItem = {
  kind: 'unknown'
  entryId: string
  timestamp: number
  rawEntry: SessionEntry
  entryType: string
}

/**
 * Pi session runtime state (from state.get command).
 * Raw state from backend, kept as JsonObject for forward compatibility.
 */
export type PiSessionRuntimeState = JsonObject

/**
 * Native settings snapshot (worker settings.get). Shape is defined by the
 * worker's catalog: raw scopes plus the resolved effective values.
 */
export type PiSettingsSnapshot = {
  workspacePath: string
  projectTrusted: boolean
  global: JsonObject
  project: JsonObject
  effective: {
    defaultProvider?: string
    defaultModel?: string
    defaultThinkingLevel?: ThinkingLevel
    transport?: 'auto' | 'sse' | 'websocket' | 'websocket-cached'
    steeringMode?: 'all' | 'one-at-a-time'
    followUpMode?: 'all' | 'one-at-a-time'
    theme?: string
    compaction?: { enabled?: boolean; reserveTokens?: number; keepRecentTokens?: number }
    retry?: { enabled?: boolean; maxRetries?: number; baseDelayMs?: number }
    shellPath?: string
    httpProxy?: string
    enableSkillCommands?: boolean
    showImages?: boolean
    defaultProjectTrust?: 'ask' | 'always' | 'never'
    [key: string]: JsonValue | undefined
  }
  errors: Array<{ scope: string; message: string }>
}

/** Native project trust state (worker trust.get / trust.set). */
export type PiProjectTrust = {
  workspacePath: string
  required: boolean
  decision: boolean | null
  inheritedFrom?: string
  defaultDecision: 'ask' | 'always' | 'never'
  trusted: boolean
}

/**
 * Pi branch page (from branch.get command).
 * Structure comes from protocol EntriesPage; items and liveMessage are
 * narrowed to SDK types since the backend guarantees their shapes.
 */
export type PiLiveMessage = Omit<LiveMessage, 'message'> & { message: AgentMessage }
export type PiBranchCheckpoint = Omit<BranchCheckpoint, 'liveMessage'> & { liveMessage?: PiLiveMessage }
export type PiBranchPage = Omit<EntriesPage, 'items' | 'checkpoint'> & {
  items: SessionEntry[]
  checkpoint?: PiBranchCheckpoint
}

/**
 * Pi session data store shape.
 * Contains all raw data for one active session.
 */
export type PiActiveSessionData = {
  sessionId: string
  state: PiSessionRuntimeState
  branch: PiBranchPage
  entries: SessionEntry[]
  status: 'loading' | 'loaded' | 'error'
  error?: Error
}

/**
 * Pi composer mode derived from session state.
 */
export type PiComposerMode =
  | { type: 'idle' }
  | { type: 'streaming'; steeringMode: 'all' | 'one-at-a-time' }
  | { type: 'streaming'; followUpMode: 'all' | 'one-at-a-time' }

/**
 * Pi command lifecycle for UI tracking.
 */
export type PiCommandLifecycle = {
  id: string
  name: string
  status: 'accepted' | 'running' | 'completed' | 'failed' | 'cancelled'
  submittedAt: string
  completedAt?: string
  result?: unknown
  error?: unknown
}

/**
 * Pi event cursor for WS subscription.
 */
export type PiEventCursor = {
  epoch: string
  sequence: number
}

/**
 * Pi registry state for capability tracking.
 */
export type PiRegistryState = {
  revision: number
  sdkVersion: string
  driver: 'mock' | 'pi'
  globalCommands: string[]
  sessionCommands: string[]
  loadState: 'idle' | 'loading' | 'loaded' | 'error'
  error?: Error
}
