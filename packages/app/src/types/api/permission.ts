export interface PermissionToolInfo { callID?: string; messageID?: string }

export interface PermissionRequest {
  id: string
  sessionID: string
  permission: string
  patterns?: string[]
  always?: string[]
  metadata?: Record<string, unknown>
  tool?: PermissionToolInfo
}

export type PermissionReply = 'once' | 'always' | 'reject'

export interface QuestionOption { label: string; description?: string }
export interface QuestionInfo {
  header?: string
  question: string
  options: QuestionOption[]
  multiple?: boolean
  custom?: boolean
}
export interface QuestionRequest { id: string; sessionID: string; questions: QuestionInfo[]; tool?: PermissionToolInfo }
export type QuestionAnswer = string[]
