import type { SessionSnapshotV1 } from '@piui/protocol'

export interface UiSession {
  id: string
  workspaceId: string
  directory: string
  title: string
  createdAt: number
  updatedAt: number
}

export interface PiSessionSummary {
  id: string
  workspaceId: string
  directory?: string
  state?: SessionSnapshotV1['session']['state']
  title: string
  createdAt: string
  updatedAt: string
}

export type SessionStatus =
  | { type: 'idle' }
  | { type: 'busy' }
  | { type: 'retry'; attempt: number; message: string; next: number }

export type SessionStatusMap = Record<string, SessionStatus>

export interface SessionListParams {
  directory?: string
  limit?: number
  start?: number
  search?: string
}
