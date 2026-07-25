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
  deleteSession: (id: string) => Promise<void>
}

export const SessionContext = createContext<SessionContextValue | null>(null)
