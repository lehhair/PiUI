import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import i18n from '../i18n'
import type { UiSession } from '../types/session'
import { loadPiSessions, loadPiSessionsForCwd, openPiSession, deletePiSession } from '../pi/controllers/index.js'
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
  // 本地创建但还没落盘的会话：pi 要等首个条目才写文件，磁盘扫描在这之前
  // 看不到它们。挂起期内刷新列表时保留，落盘或超时后交给磁盘数据。
  const pendingRef = useRef(new Map<string, number>())
  const PENDING_TTL_MS = 60_000

  const fetchSessions = useCallback(async (retryAttempt = 0) => {
    const requestId = ++requestIdRef.current
    setIsLoading(true)
    try {
      // 按当前项目目录过滤数据源（全局模式才拉全量）
      const nativeSessions = currentDirectory
        ? await loadPiSessionsForCwd(currentDirectory)
        : await loadPiSessions()
      const mapped = nativeSessions.map(piSessionInfoToUiSession).filter((session): session is UiSession => session !== null)
      const onDisk = new Set(mapped.map(session => session.id))
      const now = Date.now()
      for (const [id, since] of pendingRef.current) {
        if (onDisk.has(id) || now - since > PENDING_TTL_MS) pendingRef.current.delete(id)
      }
      const pending = allSessionsRef.current.filter(session => pendingRef.current.has(session.id))
      const next = linkPiSessionForks([...pending, ...mapped])
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
  }, [currentDirectory])

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

  const registerSession = useCallback((session: UiSession) => {
    pendingRef.current.set(session.id, Date.now())
    allSessionsRef.current = [session, ...allSessionsRef.current.filter(item => item.id !== session.id)]
    setSessions(filterPiSessionList(allSessionsRef.current, searchRef.current))
    // 落盘广播丢失（消息发送失败、worker 崩了）时，靠延迟对账把幽灵
    // 条目清出列表
    window.setTimeout(() => {
      window.dispatchEvent(new CustomEvent('piui:sessions-changed'))
    }, 15_000)
  }, [])

  const createSession = useCallback(async (title?: string) => {
    const directory = currentDirectory?.trim()
    if (!directory) throw new Error('Choose a project directory before creating a session')
    const opened = await openPiSession(directory)
    const now = Date.now()
    const session: UiSession = {
      id: opened.sessionId,
      directory,
      title: title?.trim() || i18n.t('chat:sidebar.newChat'),
      createdAt: now,
      updatedAt: now,
    }
    trackPiSession(opened.sessionId, directory)
    registerSession(session)
    return session
  }, [currentDirectory, registerSession])

  const deleteSession = useCallback(async (id: string) => {
    const session = allSessionsRef.current.find(item => item.id === id)
    if (!session?.path || !session.directory) throw new Error('Pi session file is unavailable')
    await deletePiSession(session.directory, session.path)
    pinnedSessionsStore.unpin(id)
    clearSessionRuntimeState(id)
    paneLayoutStore.clearSession(id)
    pendingRef.current.delete(id)
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
    registerSession,
    deleteSession,
  }), [sessions, isLoading, search, refresh, loadMore, createSession, registerSession, deleteSession])

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
}
