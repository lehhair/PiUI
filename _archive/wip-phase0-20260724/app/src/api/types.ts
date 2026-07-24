// API Types - 向后兼容层

export type * from '../types/api'

export type { ModelInfo, FileCapabilities, Attachment, AttachmentType } from '../types/ui'

export type { Model as ApiModel, Provider as ApiProvider, ProvidersResponse } from '../types/api/model'
export type { Project as ApiProject, PathResponse as ApiPath } from '../types/api/project'
export type {
  Session as ApiSession,
  SessionListParams,
  SessionRevert as SessionRevertState,
} from '../types/api/session'
export type {
  Message as ApiMessage,
  UserMessage as ApiUserMessage,
  AssistantMessage as ApiAssistantMessage,
  MessageWithParts as ApiMessageWithParts,
  Part as ApiPart,
  TextPart as ApiTextPart,
  ReasoningPart as ApiReasoningPart,
  ToolPart as ApiToolPart,
  FilePart as ApiFilePart,
  AgentPart as ApiAgentPart,
  StepStartPart as ApiStepStartPart,
  StepFinishPart as ApiStepFinishPart,
  SnapshotPart as ApiSnapshotPart,
  PatchPart as ApiPatchPart,
  RetryPart as ApiRetryPart,
  CompactionPart as ApiCompactionPart,
  SubtaskPart as ApiSubtaskPart,
} from '../types/api/message'
export type {
  PermissionRequest as ApiPermissionRequest,
  PermissionReply,
  QuestionOption as ApiQuestionOption,
  QuestionInfo as ApiQuestionInfo,
  QuestionRequest as ApiQuestionRequest,
  QuestionAnswer,
} from '../types/api/permission'
export type { Agent as ApiAgent, AgentPermission as ApiAgentPermission } from '../types/api/agent'
export type { Symbol as SymbolInfo } from '../types/api/file'

import type { Attachment } from '../types/ui'

export interface RevertedMessage {
  text: string
  attachments: Attachment[]
}

export interface SendMessageParams {
  sessionId: string
  text: string
  attachments: Attachment[]
  model: {
    providerID: string
    modelID: string
  }
  agent?: string
  variant?: string
  directory?: string
}

export interface SendMessageResponse {
  info: import('../types/api/message').AssistantMessage
  parts: import('../types/api/message').Part[]
}
