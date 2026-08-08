// API Types - 向后兼容层

export type * from '../types/api'

export type { ModelInfo, FileCapabilities, Attachment, AttachmentType } from '../types/ui'

export type { Model as ApiModel, Provider as ApiProvider, ProvidersResponse } from '../types/api/model'
export type { Project as ApiProject, PathResponse as ApiPath } from '../types/api/project'
export type { Agent as ApiAgent, AgentPermission as ApiAgentPermission } from '../types/api/agent'

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
