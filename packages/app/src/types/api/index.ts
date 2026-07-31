// ============================================
// API Types - 统一导出
// ============================================
//
// 所有 API 类型都从这里导出
// 使用方式: import type { Message, Part } from '@/types/api'
//

// Common types
export type {
  ErrorInfo,
  ProviderAuthError,
  UnknownError,
  MessageOutputLengthError,
  MessageAbortedError,
  APIError,
} from './common'

// Message types
export type {
  Message,
  UserMessage,
  AssistantMessage,
  MessageSummary,
  Part,
  TextPart,
  ReasoningPart,
  ToolPart,
  FilePart,
  FileSource,
  FileSourceType,
  AgentPart,
  StepStartPart,
  StepFinishPart,
  SnapshotPart,
  PatchPart,
  RetryPart,
  CompactionPart,
  TextPartInput,
  FilePartInput,
  AgentPartInput,
} from './message'

// Model types
export type {
  Model,
  ModelStatus,
  ModelLimit,
  ModelCapabilities,
  ModelIOCapabilities,
  Provider,
  ProvidersResponse,
  ProviderAuthMethod,
  ProviderAuthAuthorization,
} from './model'

// Permission types
export type {
  PermissionToolInfo,
  PermissionRequest,
  PermissionReply,
  QuestionOption,
  QuestionInfo,
  QuestionRequest,
  QuestionAnswer,
} from './permission'

// Project types
export type { Project, ProjectIcon, ProjectCommands, ProjectUpdateParams, PathResponse } from './project'

// Agent types
export type { Agent, AgentMode, AgentPermission } from './agent'

// Event types
export type {
  GlobalEvent,
  EventType,
  EventCallbacks,
  ServerConnectedPayload,
  SessionIdlePayload,
  SessionErrorPayload,
  SessionStatusPayload,
  SessionDiffPayload,
  PartDeltaPayload,
  PartRemovedPayload,
  PermissionRepliedPayload,
  QuestionRepliedPayload,
  QuestionRejectedPayload,
  TodoItem,
  TodoUpdatedPayload,
  WorktreeReadyPayload,
  WorktreeFailedPayload,
  VcsBranchUpdatedPayload,
} from './event'
export { EventTypes } from './event'

// Config types
export type {
  Config,
  LogLevel,
  ServerConfig,
  PermissionConfig,
  PermissionActionConfig,
  PermissionObjectConfig,
  PermissionRuleConfig,
  AgentConfig,
  ProviderConfig,
  McpLocalConfig,
  McpOAuthConfig,
  McpRemoteConfig,
  LayoutConfig,
} from './config'

// MCP types
export type {
  MCPStatus,
  MCPStatusConnected,
  MCPStatusDisabled,
  MCPStatusFailed,
  MCPStatusNeedsAuth,
  MCPStatusNeedsClientRegistration,
  MCPResource,
  MCPStatusResponse,
  McpServerConfig,
} from './mcp'

// Skill types

// PTY types
export type { Pty, PtySize, PtyCreateParams, PtyUpdateParams } from './pty'

// VCS types

// Worktree types
export type { Worktree, WorktreeCreateInput, WorktreeRemoveInput, WorktreeResetInput } from './worktree'

// Tool types
export type { ToolIDs, ToolList, ToolListItem } from './tool'
