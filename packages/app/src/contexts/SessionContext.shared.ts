import { createContext } from 'react'
import type { UiSession } from '../types/session'

export interface SessionContextValue {
  sessions: UiSession[]
  isLoading: boolean
  isLoadingMore: boolean
  hasMore: boolean
  search: string
  setSearch: (term: string) => void
  refresh: () => Promise<void>
  loadMore: () => Promise<void>
  createSession: (title?: string) => Promise<UiSession>
  /** 本地已创建的会话直接插入列表，不等磁盘扫描和事件流 */
  registerSession: (session: UiSession) => void
  deleteSession: (id: string) => Promise<void>
}

export const SessionContext = createContext<SessionContextValue | null>(null)
