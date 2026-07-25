export type SessionStatus =
  | { type: 'idle' }
  | { type: 'busy' }
  | { type: 'retry'; attempt: number; message: string; next: number }

export type SessionStatusMap = Record<string, SessionStatus>

export interface SessionSummary { additions: number; deletions: number; files: number }
export interface SessionShare { url: string }
export interface SessionRevert { messageID: string; partID?: string; snapshot?: string; diff?: string }

export interface Session {
  id: string
  projectID?: string
  directory: string
  parentID?: string
  title: string
  version?: string
  time: { created: number; updated?: number; compacting?: number; archived?: number }
  summary?: SessionSummary
  share?: SessionShare
  revert?: SessionRevert
}

export interface SessionListParams {
  directory?: string
  roots?: boolean
  limit?: number
  start?: number
  search?: string
}

export interface SessionCreateParams { directory?: string; title?: string; parentID?: string }
export interface SessionUpdateParams { title?: string; archived?: number | null }
export interface SessionForkParams { directory?: string; messageID?: string }
