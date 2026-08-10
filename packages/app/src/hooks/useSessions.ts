import { useState, useEffect, useCallback, useRef } from 'react'
import type { SessionListParams, UiSession } from '../types/session'
import { pinnedSessionsStore } from '../store/pinnedSessionsStore'
import { autoDetectPathStyle, isSameDirectory } from '../utils'
import { createPiSession, loadPiSessions, loadPiSessionsForCwd, deletePiSession } from '../pi/controllers/index.js'
import { filterPiSessionList, linkPiSessionForks, piSessionInfoToUiSession } from '../pi/nativeSessionListModel'
import { trackPiSession } from '../pi/piSessionIndex'
import { resolveWorkspacePath } from '../pi/workspaces.js'

/**
 * piui:sessions-changed 事件的结构化 detail：带具体会话信息的事件由列表
 * 本地增量合并（不重拉）；只有无 detail 的纯刷新信号才回退全量重拉。
 */
type SessionsChangedDetail = {
  created?: UiSession
  sessionId?: string
  cwd?: string
  attached?: boolean
  updated?: boolean
  materialized?: boolean
  deleted?: boolean
  /** head 推进带的会话摘要（/name 设置的标题） */
  name?: string
  /** 条目数（近似消息数） */
  messageCount?: number
}

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
    (params?: SessionListParams & { append?: boolean; retryAttempt?: number; silent?: boolean }) => Promise<void>
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
    async (params: SessionListParams & { append?: boolean; retryAttempt?: number; silent?: boolean } = {}) => {
      if (!enabled) return

      const { append = false, retryAttempt = 0, silent = false, ...queryParams } = params
      const requestId = ++requestIdRef.current
      isFetchingRef.current = true

      if (append) {
        setIsLoadingMore(true)
      } else if (!silent) {
        // 只有首次加载/显式刷新才切 loading；事件驱动的后台刷新静默替换，
        // 否则列表会被 spinner 行替换、高度塌缩，整个侧边栏抖动。
        setIsLoading(true)
        setError(null)
      }

      try {
        const nativeSessions = normalizedDirectory
          ? await loadPiSessionsForCwd(normalizedDirectory)
          : await loadPiSessions()
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
              void fetchSessionsRef.current({ ...queryParams, retryAttempt: retryAttempt + 1 })
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
            // 静默补拉：不清空现有列表（清空会闪白/塌缩），旧数据保持到新数据到达
            void fetchSessionsRef.current({ search: searchRef.current || undefined, silent: true })
          }
        }
      }
    },
    [matchesDirectory, enabled, normalizedDirectory],
  )

  useEffect(() => {
    fetchSessionsRef.current = fetchSessions
  }, [fetchSessions])

  // enabled 关闭时停止加载（渲染期间调整 state，避免 effect 级联渲染）
  if (!enabled && (isLoading || isLoadingMore)) {
    setIsLoading(false)
    setIsLoadingMore(false)
  }

  // 初始加载和搜索变化时重新加载
  useEffect(() => {
    if (!enabled) return

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

    /**
     * 结构化增量合并（对齐 opencode 上游的 session.created/updated/deleted
     * 语义）：带具体会话信息的事件直接本地改列表——新建立即可见（不依赖
     * 磁盘落盘）、消息推进只移动条目（无 loading 闪烁、无全量扫描）。
     * 只有无结构信息的纯刷新信号才回退静默全量重拉。
     */
    const refreshFromEvent = (event: Event) => {
      const detail = (event as CustomEvent<SessionsChangedDetail | undefined>).detail
      const now = Date.now()
      if (detail?.created && matchesDirectory(detail.created)) {
        // 本地新建（尚未落盘，磁盘扫描不可见）：直接插入，排最前
        setSessions(prev => {
          if (prev.some(session => session.id === detail.created!.id)) return prev
          return [detail.created!, ...prev].sort((a, b) => b.updatedAt - a.updatedAt)
        })
        return
      }
      if (detail?.attached && detail.sessionId && typeof detail.cwd === 'string') {
        // attach：插入占位（新会话文件可能还没落盘）；title/messageCount
        // 等真实数据由后续全量重拉补齐
        const placeholder: UiSession = {
          id: detail.sessionId,
          directory: detail.cwd,
          title: '',
          createdAt: now,
          updatedAt: now,
          messageCount: 0,
          isNamed: false,
        }
        setSessions(prev => {
          if (prev.some(session => session.id === detail.sessionId)) return prev
          return [placeholder, ...prev]
        })
        return
      }
      if (detail?.deleted && detail.sessionId) {
        setSessions(prev => prev.filter(session => session.id !== detail.sessionId))
        return
      }
      if ((detail?.updated || detail?.materialized) && detail.sessionId) {
        // head 推进：本地有条目则移到最前、刷新 updatedAt，并用事件带的
        // 摘要补全标题/消息数；没有条目说明磁盘已可见（materialized 即
        // 落盘），静默重拉补齐。
        setSessions(prev => {
          const index = prev.findIndex(session => session.id === detail.sessionId)
          if (index === -1) return prev
          const current = prev[index]
          const session: UiSession = {
            ...current,
            updatedAt: now,
            ...(typeof detail.messageCount === 'number' && detail.messageCount > 0
              ? { messageCount: detail.messageCount }
              : {}),
            ...(typeof detail.name === 'string' && detail.name ? { title: detail.name, isNamed: true } : {}),
          }
          return [session, ...prev.filter(item => item.id !== detail.sessionId)]
        })
        return
      }
      // 纯刷新信号（无结构信息）：静默重拉，不清空不闪烁
      if (isFetchingRef.current) {
        queuedReconnectRefreshRef.current = true
        return
      }
      void fetchSessionsRef.current({ search: searchRef.current || undefined, silent: true })
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
      // 全局（未选目录）时落到服务器默认工作区（桌面安装目录）
      const directory = normalizedDirectory || (await resolveWorkspacePath())
      if (!directory) throw new Error('A project directory is required')
      const created = await createPiSession(directory)
      if (!created.sessionFile) throw new Error('Pi did not return a session file')
      const now = Date.now()
      const newSession: UiSession = {
        id: created.sessionId,
        path: created.sessionFile,
        directory: created.cwd ?? directory,
        title: title?.trim() || 'New chat',
        createdAt: now,
        updatedAt: now,
        messageCount: 0,
        isNamed: Boolean(title?.trim()),
      }
      trackPiSession(created.sessionId, newSession.directory)

      if (searchRef.current) {
        void fetchSessionsRef.current({ search: searchRef.current || undefined })
      } else {
        setSessions(prev => {
          if (prev.some(session => session.id === newSession.id)) return prev
          return [newSession, ...prev]
        })
      }

      window.dispatchEvent(new CustomEvent('piui:sessions-changed', {
        detail: { created: newSession },
      }))

      return newSession
    },
    [normalizedDirectory],
  )

  // 删除会话
  const remove = useCallback(
    async (sessionId: string) => {
      const session = sessions.find(item => item.id === sessionId)
      if (!session?.path || !session.directory) throw new Error('Pi session file is unavailable')
      await deletePiSession(session.directory, session.path)
      pinnedSessionsStore.unpin(sessionId)
      setSessions(prev => prev.filter(s => s.id !== sessionId))
      window.dispatchEvent(new CustomEvent('piui:sessions-changed', {
        detail: { sessionId, deleted: true },
      }))
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
