import { useState, useEffect, useCallback, useRef } from 'react'
import type { SessionListParams, UiSession } from '../types/session'
import { pinnedSessionsStore } from '../store/pinnedSessionsStore'
import { autoDetectPathStyle, isSameDirectory } from '../utils'
import {
  listPiNativeSessions,
  listPiNativeSessionsForCwd,
  openPiNativeSession,
  postPiGlobalCommand,
} from '../pi/nativeApi'
import { filterPiSessionList, linkPiSessionForks, piSessionInfoToUiSession } from '../pi/nativeSessionListModel'
import { trackPiSession } from '../pi/piSessionIndex'

interface UseSessionsOptions {
  /** 每页数量 */
  pageSize?: number
  /** 初始搜索词 */
  initialSearch?: string
  /** 只加载根会话 */
  rootsOnly?: boolean
  /** 按目录过滤 */
  directory?: string
  /** 延迟启用，用于懒加载 */
  enabled?: boolean
}

interface UseSessionsResult {
  sessions: UiSession[]
  isLoading: boolean
  isLoadingMore: boolean
  error: Error | null
  hasMore: boolean
  /** 搜索词 */
  search: string
  setSearch: (search: string) => void
  /** 加载更多 */
  loadMore: () => Promise<void>
  /** 刷新列表 */
  refresh: () => Promise<void>
  /** 创建新会话 */
  create: (title?: string) => Promise<UiSession>
  /** 删除会话 */
  remove: (sessionId: string) => Promise<void>
  /** 本地更新会话 */
  patchLocalSession: (sessionId: string, patch: Partial<UiSession>) => void
  /** 本地移除会话 */
  removeLocalSession: (sessionId: string) => void
}

export function useSessions(options: UseSessionsOptions = {}): UseSessionsResult {
  const { pageSize = 20, initialSearch = '', directory, enabled = true } = options

  // 标准化 directory 路径 (移除末尾斜杠，统一正斜杠)
  const normalizedDirectory = directory ? directory.replace(/\\/g, '/').replace(/\/$/, '') : undefined

  const [sessions, setSessions] = useState<UiSession[]>([])
  const [isLoading, setIsLoading] = useState(enabled)
  const [isLoadingMore, setIsLoadingMore] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  const [hasMore, setHasMore] = useState(true)
  const [search, setSearch] = useState(initialSearch)

  // 用于跟踪最后一次请求，避免竞态条件
  const requestIdRef = useRef(0)
  // 防抖 timer
  const searchTimerRef = useRef<number | null>(null)
  // 当前 limit，loadMore 时递增（与 SessionContext 保持一致）
  const currentLimitRef = useRef(pageSize)
  const searchRef = useRef(search)
  // 防止 onReconnected 密集触发时重复请求
  const isFetchingRef = useRef(false)
  const queuedReconnectRefreshRef = useRef(false)
  const retryTimerRef = useRef<number | null>(null)
  const fetchSessionsRef = useRef<
    (params?: SessionListParams & { append?: boolean; retryAttempt?: number }) => Promise<void>
  >(() => Promise.resolve())

  useEffect(() => {
    searchRef.current = search
  }, [search])

  const matchesDirectory = useCallback(
    (session: UiSession) => !normalizedDirectory || isSameDirectory(normalizedDirectory, session.directory),
    [normalizedDirectory],
  )

  // 获取会话列表
  // append 仅用于控制 loading 状态：true 时用 isLoadingMore，false 时用 isLoading
  // 数据始终全量替换（递增 limit 策略）
  const fetchSessions = useCallback(
    async (params: SessionListParams & { append?: boolean; retryAttempt?: number } = {}) => {
      if (!enabled) return

      const { append = false, retryAttempt = 0, ...queryParams } = params
      const requestId = ++requestIdRef.current
      isFetchingRef.current = true

      if (append) {
        setIsLoadingMore(true)
      } else {
        setIsLoading(true)
        setError(null)
      }

      try {
        const nativeSessions = normalizedDirectory
          ? await listPiNativeSessionsForCwd(normalizedDirectory)
          : await listPiNativeSessions()
        const mapped = nativeSessions
          .map(piSessionInfoToUiSession)
          .filter((session): session is UiSession => session !== null)
        const all = linkPiSessionForks(mapped)
        const searchTerm = queryParams.search?.trim().toLowerCase()
        const matching = filterPiSessionList(all.filter(session => matchesDirectory(session)), searchTerm ?? '')
        const data = matching.slice(0, currentLimitRef.current)

        // 检查是否是最新的请求
        if (requestId !== requestIdRef.current) return

        if (data.length > 0 && data[0].directory) {
          autoDetectPathStyle(data[0].directory)
        }

        setSessions(data)
        setHasMore(matching.length > data.length)
      } catch (e) {
        if (requestId !== requestIdRef.current) return
        setError(e instanceof Error ? e : new Error('Failed to fetch sessions'))
        if (!append) {
          if (retryAttempt < 3) {
            if (retryTimerRef.current) clearTimeout(retryTimerRef.current)
            retryTimerRef.current = window.setTimeout(() => {
              if (requestId !== requestIdRef.current) return
              void fetchSessions({ ...queryParams, retryAttempt: retryAttempt + 1 })
            }, [500, 1500, 3000][retryAttempt])
          } else {
            setSessions([])
            setHasMore(false)
          }
        }
      } finally {
        if (requestId === requestIdRef.current) {
          isFetchingRef.current = false
          setIsLoading(false)
          setIsLoadingMore(false)
          if (queuedReconnectRefreshRef.current) {
            queuedReconnectRefreshRef.current = false
            setSessions([])
            void fetchSessionsRef.current({ search: searchRef.current || undefined })
          }
        }
      }
    },
    [matchesDirectory, enabled],
  )

  fetchSessionsRef.current = fetchSessions

  // 初始加载和搜索变化时重新加载
  useEffect(() => {
    if (!enabled) {
      setIsLoading(false)
      setIsLoadingMore(false)
      return
    }

    // 搜索或 enabled 变化时重置 limit
    currentLimitRef.current = pageSize

    // 防抖处理搜索
    if (searchTimerRef.current) {
      clearTimeout(searchTimerRef.current)
    }

    searchTimerRef.current = window.setTimeout(
      () => {
        fetchSessions({ search: search || undefined })
      },
      search ? 300 : 0,
    ) // 有搜索词时延迟 300ms，无搜索词时立即执行

    return () => {
      if (searchTimerRef.current) {
        clearTimeout(searchTimerRef.current)
      }
      if (retryTimerRef.current) {
        clearTimeout(retryTimerRef.current)
      }
    }
  }, [search, fetchSessions, enabled, pageSize])

  useEffect(() => {
    if (!enabled) return

    const refreshFromEvent = () => {
      if (isFetchingRef.current) {
        queuedReconnectRefreshRef.current = true
        return
      }
      void fetchSessionsRef.current({ search: searchRef.current || undefined })
    }
    window.addEventListener('piui:sessions-changed', refreshFromEvent)
    return () => window.removeEventListener('piui:sessions-changed', refreshFromEvent)
  }, [enabled, matchesDirectory, pageSize])

  // 加载更多：递增 limit 重新拉取完整列表（与 SessionContext 一致）
  const loadMore = useCallback(async () => {
    if (!enabled || isLoadingMore || !hasMore || sessions.length === 0) return

    currentLimitRef.current += pageSize
    await fetchSessions({
      search: search || undefined,
      append: true,
    })
  }, [sessions, search, hasMore, isLoadingMore, fetchSessions, enabled, pageSize])

  // 刷新
  const refresh = useCallback(async () => {
    if (!enabled) return
    await fetchSessions({ search: search || undefined })
  }, [search, fetchSessions, enabled])

  // 创建新会话
  const create = useCallback(
    async (title?: string) => {
      if (!normalizedDirectory) throw new Error('A project directory is required')
      const opened = await openPiNativeSession(normalizedDirectory)
      const now = new Date().toISOString()
      const newSession = piSessionInfoToUiSession({
        id: opened.sessionId,
        path: opened.sessionFile ?? undefined,
        cwd: opened.cwd ?? normalizedDirectory,
        name: title,
        created: now,
        modified: now,
        messageCount: 0,
        firstMessage: '',
      })!
      trackPiSession(opened.sessionId, newSession.directory)

      if (searchRef.current) {
        void fetchSessionsRef.current({ search: searchRef.current || undefined })
      } else {
        setSessions(prev => {
          if (prev.some(session => session.id === newSession.id)) return prev
          return [newSession, ...prev]
        })
      }

      window.dispatchEvent(new CustomEvent('piui:sessions-changed'))

      return newSession
    },
    [normalizedDirectory],
  )

  // 删除会话
  const remove = useCallback(
    async (sessionId: string) => {
      const session = sessions.find(item => item.id === sessionId)
      if (!session?.path || !session.directory) throw new Error('Pi session file is unavailable')
      await postPiGlobalCommand('session.delete', { cwd: session.directory, sessionFile: session.path })
      pinnedSessionsStore.unpin(sessionId)
      setSessions(prev => prev.filter(s => s.id !== sessionId))
      window.dispatchEvent(new CustomEvent('piui:sessions-changed'))
    },
    [sessions],
  )

  const patchLocalSession = useCallback((sessionId: string, patch: Partial<UiSession>) => {
    setSessions(prev => prev.map(session => (session.id === sessionId ? { ...session, ...patch } : session)))
  }, [])

  const removeLocalSession = useCallback((sessionId: string) => {
    setSessions(prev => prev.filter(session => session.id !== sessionId))
  }, [])

  return {
    sessions,
    isLoading,
    isLoadingMore,
    error,
    hasMore,
    search,
    setSearch,
    loadMore,
    refresh,
    create,
    remove,
    patchLocalSession,
    removeLocalSession,
  }
}
