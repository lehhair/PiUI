import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { UiSession } from '../types/session'
import { loadPiSessions, openPiSession, deletePiSession } from '../pi/controllers/index.js'
import { filterPiSessionList, linkPiSessionForks, piSessionInfoToUiSession } from '../pi/nativeSessionListModel'
import { trackPiSession } from '../pi/piSessionIndex'
import { pinnedSessionsStore } from '../store/pinnedSessionsStore'
import { paneLayoutStore } from '../store/paneLayoutStore'
import { activeSessionStore } from '../store/activeSessionStore'
import { useDirectory } from './useDirectory'
import { sessionErrorHandler } from '../utils'
import { clearSessionRuntimeState } from '../utils/sessionLifecycle'
import { SessionContext, type SessionContextValue } from './SessionContext.shared'

export function SessionProvider({ children }: { children: ReactNode }) {
  const { currentDirectory } = useDirectory()
  const [sessions, setSessions] = useState<UiSession[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [search, setSearch] = useState('')
  const requestIdRef = useRef(0)
  const allSessionsRef = useRef<UiSession[]>([])
  const searchRef = useRef('')
  const retryTimerRef = useRef<number | null>(null)
  const fetchSessionsRef = useRef<(retryAttempt?: number) => Promise<void>>(() => Promise.resolve())

  const fetchSessions = useCallback(async (retryAttempt = 0) => {
    const requestId = ++requestIdRef.current
    setIsLoading(true)
    try {
      const nativeSessions = await loadPiSessions()
      const mapped = nativeSessions.map(piSessionInfoToUiSession).filter((session): session is UiSession => session !== null)
      const next = linkPiSessionForks(mapped)
      if (requestId !== requestIdRef.current) return
      allSessionsRef.current = next
      activeSessionStore.syncPiSummaries(next.map(session => ({
        id: session.id,
        title: session.title,
        directory: session.directory,
      })))
      setSessions(filterPiSessionList(next, searchRef.current))
    } catch (error) {
      if (requestId !== requestIdRef.current) return
      if (retryAttempt < 3) {
        if (retryTimerRef.current) clearTimeout(retryTimerRef.current)
        retryTimerRef.current = window.setTimeout(() => {
          if (requestId !== requestIdRef.current) return
          void fetchSessionsRef.current(retryAttempt + 1)
        }, [500, 1500, 3000][retryAttempt])
      } else {
        allSessionsRef.current = []
        setSessions([])
      }
      sessionErrorHandler('fetch sessions', error)
    } finally {
      if (requestId === requestIdRef.current) setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchSessionsRef.current = fetchSessions
  }, [fetchSessions])

  useEffect(() => {
    void fetchSessions()
    return () => {
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current)
    }
  }, [fetchSessions])

  useEffect(() => {
    searchRef.current = search
    setSessions(filterPiSessionList(allSessionsRef.current, search))
  }, [search])

  useEffect(() => {
    const refresh = () => void fetchSessionsRef.current()
    window.addEventListener('piui:sessions-changed', refresh)
    return () => window.removeEventListener('piui:sessions-changed', refresh)
  }, [])

  const refresh = useCallback(() => fetchSessions(), [fetchSessions])
  const loadMore = useCallback(async () => {}, [])

  const createSession = useCallback(async (title?: string) => {
    const directory = currentDirectory?.trim()
    if (!directory) throw new Error('Choose a project directory before creating a session')
    const opened = await openPiSession(directory)
    const now = Date.now()
    const session: UiSession = {
      id: opened.sessionId,
      directory,
      title: title?.trim() || 'New chat',
      createdAt: now,
      updatedAt: now,
    }
    trackPiSession(opened.sessionId, directory)
    allSessionsRef.current = [session, ...allSessionsRef.current.filter(item => item.id !== session.id)]
    setSessions(filterPiSessionList(allSessionsRef.current, search))
    return session
  }, [currentDirectory, search])

  const deleteSession = useCallback(async (id: string) => {
    const session = allSessionsRef.current.find(item => item.id === id)
    if (!session?.path || !session.directory) throw new Error('Pi session file is unavailable')
    await deletePiSession(session.directory, session.path)
    pinnedSessionsStore.unpin(id)
    clearSessionRuntimeState(id)
    paneLayoutStore.clearSession(id)
    allSessionsRef.current = allSessionsRef.current.filter(item => item.id !== id)
    setSessions(filterPiSessionList(allSessionsRef.current, search))
  }, [search])

  const value = useMemo<SessionContextValue>(() => ({
    sessions,
    isLoading,
    isLoadingMore: false,
    hasMore: false,
    search,
    setSearch,
    refresh,
    loadMore,
    createSession,
    deleteSession,
  }), [sessions, isLoading, search, refresh, loadMore, createSession, deleteSession])

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
}
