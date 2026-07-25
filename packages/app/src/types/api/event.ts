import type { Session, SessionStatus } from './session'
import type { Message, Part } from './message'
import type { PermissionRequest, QuestionRequest } from './permission'
import type { Project } from './project'

export interface SessionIdlePayload { sessionID: string }
export interface SessionErrorPayload { sessionID: string; name: string; data: unknown }
export interface SessionStatusPayload { sessionID: string; status: SessionStatus }
export interface SessionDiffPayload { sessionID: string; diff: unknown[] }
export interface PartRemovedPayload { sessionID: string; messageID: string; partID: string }
export interface PartDeltaPayload { sessionID: string; messageID: string; partID: string; field: string; delta: string }
export interface PermissionRepliedPayload { sessionID: string; requestID: string }
export interface QuestionRepliedPayload { sessionID: string; requestID: string; answers?: unknown[] }
export interface QuestionRejectedPayload { sessionID: string; requestID: string }

export interface TodoItem {
  id: string
  content: string
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled'
  priority: 'high' | 'medium' | 'low'
}

export interface TodoUpdatedPayload { sessionID: string; todos: TodoItem[] }
export interface WorktreeReadyPayload { directory: string; branch?: string }
export interface WorktreeFailedPayload { directory?: string; error: string; message?: string }
export interface VcsBranchUpdatedPayload { branch: string }
export interface ServerConnectedPayload { timestamp?: unknown }

export interface GlobalEvent {
  directory?: string
  payload: { type: string; properties: Record<string, unknown> }
}

export const EventTypes = {
  SESSION_CREATED: 'session.created', SESSION_UPDATED: 'session.updated', SESSION_DELETED: 'session.deleted',
  SESSION_IDLE: 'session.idle', SESSION_ERROR: 'session.error', SESSION_STATUS: 'session.status',
  SESSION_DIFF: 'session.diff', SESSION_COMPACTED: 'session.compacted', MESSAGE_UPDATED: 'message.updated',
  MESSAGE_REMOVED: 'message.removed', MESSAGE_PART_UPDATED: 'message.part.updated',
  MESSAGE_PART_DELTA: 'message.part.delta', MESSAGE_PART_REMOVED: 'message.part.removed',
  PERMISSION_ASKED: 'permission.asked', PERMISSION_REPLIED: 'permission.replied', QUESTION_ASKED: 'question.asked',
  QUESTION_REPLIED: 'question.replied', QUESTION_REJECTED: 'question.rejected', TODO_UPDATED: 'todo.updated',
  PROJECT_UPDATED: 'project.updated', SERVER_CONNECTED: 'server.connected', VCS_BRANCH_UPDATED: 'vcs.branch.updated',
} as const

export type EventType = (typeof EventTypes)[keyof typeof EventTypes]

export interface EventCallbacks {
  onMessageUpdated?: (message: Message) => void
  onPartUpdated?: (part: Part) => void
  onPartDelta?: (data: PartDeltaPayload) => void
  onPartRemoved?: (data: PartRemovedPayload) => void
  onServerConnected?: (data: ServerConnectedPayload) => void
  onSessionCreated?: (session: Session) => void
  onSessionUpdated?: (session: Session) => void
  onSessionDeleted?: (sessionId: string) => void
  onSessionIdle?: (data: SessionIdlePayload) => void
  onSessionError?: (data: SessionErrorPayload) => void
  onSessionStatus?: (data: SessionStatusPayload) => void
  onPermissionAsked?: (request: PermissionRequest) => void
  onPermissionReplied?: (data: PermissionRepliedPayload) => void
  onQuestionAsked?: (request: QuestionRequest) => void
  onQuestionReplied?: (data: QuestionRepliedPayload) => void
  onQuestionRejected?: (data: QuestionRejectedPayload) => void
  onTodoUpdated?: (data: TodoUpdatedPayload) => void
  onProjectUpdated?: (project: Project) => void
  onWorktreeReady?: (data: WorktreeReadyPayload) => void
  onWorktreeFailed?: (data: WorktreeFailedPayload) => void
  onVcsBranchUpdated?: (data: VcsBranchUpdatedPayload) => void
  onError?: (error: Error) => void
  onReconnected?: (reason: 'network' | 'server-switch') => void
}
