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

// Skill types

// VCS types

// Tool types
export type { ToolIDs, ToolList, ToolListItem } from './tool'
