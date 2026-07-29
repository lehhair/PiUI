import type { SessionSnapshotV1 } from '@piui/protocol'

export interface UiSession {
  id: string
  directory: string
  title: string
  firstMessage?: string
  messageCount?: number
  searchText?: string
  isNamed?: boolean
  createdAt: number
  updatedAt: number
  path?: string
  parentSessionPath?: string
  forkParentId?: string
  forkParentTitle?: string
}

export interface PiSessionSummary {
  id: string
  directory: string
  state?: SessionSnapshotV1['session']['state']
  title: string
  createdAt: string
  updatedAt: string
  path?: string
  parentSessionPath?: string
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
