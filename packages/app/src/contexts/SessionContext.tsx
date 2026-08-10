import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import i18n from '../i18n'
import type { UiSession } from '../types/session'
import { createPiSession, loadPiSessions, deletePiSession } from '../pi/controllers/index.js'
import { filterPiSessionList, linkPiSessionForks, piSessionInfoToUiSession } from '../pi/nativeSessionListModel'
import { trackPiSession } from '../pi/piSessionIndex'
import { pinnedSessionsStore } from '../store/pinnedSessionsStore'
import { paneLayoutStore } from '../store/paneLayoutStore'
import { activeSessionStore } from '../store/activeSessionStore'
import { useDirectory } from './useDirectory'
import { resolveWorkspacePath } from '../pi/workspaces.js'
import { isSameDirectory } from '../utils/directoryUtils'
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
  // ── 事件刷新合并 ──
  // piui:sessions-changed 在会话生命周期/事件流重连时可能高频触发，每个订阅者
  // 各自全量拉取会形成请求风暴（侧边栏抽搐）。防抖窗口内合并为一次；
  // 请求进行中再来变更则在完成后补刷一次（尾合并，避免丢最后一次变化）。
  const fetchTimerRef = useRef<number | null>(null)
  const fetchInFlightRef = useRef(false)
  const fetchQueuedRef = useRef(false)
  // 本地创建但还没落盘的会话：pi 要等首个条目才写文件，磁盘扫描在这之前
  // 看不到它们。挂起期内刷新列表时保留，落盘或超时后交给磁盘数据。
  const pendingRef = useRef(new Map<string, number>())
  const PENDING_TTL_MS = 60_000

  // ── 数据源策略 ──
  // 始终拉全局 session 列表：activeSessionStore（活跃 tab）需要跨工作区解析
  // 任意活跃 session 的 id/directory；列表显示则在前端按当前工作区过滤
  //（“只看当前项目”）。目录切换仅重过滤，不再重发请求。
  const currentDirectoryRef = useRef(currentDirectory)
  useEffect(() => {
    currentDirectoryRef.current = currentDirectory
  }, [currentDirectory])

  const applyDirectoryFilter = useCallback((list: UiSession[]): UiSession[] => {
    const cwd = currentDirectoryRef.current
    return cwd ? list.filter(session => isSameDirectory(session.directory, cwd)) : list
  }, [])

  const fetchSessions = useCallback(async (retryAttempt = 0) => {
    if (fetchInFlightRef.current) {
      // 上一次还没结束：合并到完成后补刷（尾合并）
      fetchQueuedRef.current = true
      return
    }
    fetchInFlightRef.current = true
    const requestId = ++requestIdRef.current
    setIsLoading(true)
    try {
      const nativeSessions = await loadPiSessions()
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
      setSessions(filterPiSessionList(applyDirectoryFilter(next), searchRef.current))
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
      fetchInFlightRef.current = false
      if (requestId === requestIdRef.current) {
        setIsLoading(false)
        if (fetchQueuedRef.current) {
          fetchQueuedRef.current = false
          void fetchSessionsRef.current()
        }
      }
    }
  }, [applyDirectoryFilter])

  // 事件驱动刷新：防抖合并（300ms 窗口内多事件只拉一次）
  const scheduleFetch = useCallback(() => {
    if (fetchTimerRef.current !== null) return
    fetchTimerRef.current = window.setTimeout(() => {
      fetchTimerRef.current = null
      void fetchSessionsRef.current()
    }, 300)
  }, [])

  useEffect(() => {
    fetchSessionsRef.current = fetchSessions
  }, [fetchSessions])

  // 初始加载会话
  useEffect(() => {
    void fetchSessions()
    return () => {
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current)
    }
  }, [fetchSessions])
  useEffect(() => {
    searchRef.current = search
    setSessions(filterPiSessionList(applyDirectoryFilter(allSessionsRef.current), search))
  }, [search, applyDirectoryFilter])

  // 工作区切换：数据已是全局的，只重新过滤显示，不发请求
  useEffect(() => {
    setSessions(filterPiSessionList(applyDirectoryFilter(allSessionsRef.current), searchRef.current))
  }, [currentDirectory, applyDirectoryFilter])

  useEffect(() => {
    window.addEventListener('piui:sessions-changed', scheduleFetch)
    return () => {
      window.removeEventListener('piui:sessions-changed', scheduleFetch)
      if (fetchTimerRef.current !== null) {
        clearTimeout(fetchTimerRef.current)
        fetchTimerRef.current = null
      }
    }
  }, [scheduleFetch])

  const refresh = useCallback(() => fetchSessions(), [fetchSessions])
  const loadMore = useCallback(async () => {}, [])

  const registerSession = useCallback((session: UiSession) => {
    pendingRef.current.set(session.id, Date.now())
    allSessionsRef.current = [session, ...allSessionsRef.current.filter(item => item.id !== session.id)]
    setSessions(filterPiSessionList(applyDirectoryFilter(allSessionsRef.current), searchRef.current))
    // 落盘广播丢失（消息发送失败、worker 崩了）时，靠延迟对账把幽灵
    // 条目清出列表
    window.setTimeout(() => {
      window.dispatchEvent(new CustomEvent('piui:sessions-changed'))
    }, 15_000)
  }, [applyDirectoryFilter])

  const createSession = useCallback(async (title?: string) => {
    // 全局（未选目录）时落到服务器默认工作区（桌面安装目录）
    const directory = currentDirectory?.trim() || (await resolveWorkspacePath()) || ''
    if (!directory) throw new Error('Choose a project directory before creating a session')
    const created = await createPiSession(directory)
    const now = Date.now()
    const session: UiSession = {
      id: created.sessionId,
      directory,
      title: title?.trim() || i18n.t('chat:sidebar.newChat'),
      createdAt: now,
      updatedAt: now,
    }
    trackPiSession(created.sessionId, directory)
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
