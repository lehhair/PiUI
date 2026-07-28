import { useState, useCallback, useEffect, useRef, useMemo, type ReactNode } from 'react'
import type { SessionListParams, UiSession } from '../types/session'
import {
  createPiSession,
  deletePiSession,
  isPiServerUp,
  listPiSessions,
  resolveWorkspacePath,
} from '../pi/sessionApi'
import { toUiSession, snapshotToUiSession } from '../pi/sessionModel'
import { applySnapshotToUi } from '../pi/applySnapshot'
import { isTrackedPiSession } from '../pi/piSessionIndex'
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
  const [isLoadingMore, setIsLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(true)
  const [search, setSearch] = useState('')

  const requestIdRef = useRef(0)
  const searchTimerRef = useRef<number | null>(null)
  const isLoadingMoreRef = useRef(false) // 防止并发 loadMore
  const retryTimerRef = useRef<number | null>(null)
  const fetchSessionsRef = useRef<
    (params?: SessionListParams & { append?: boolean; retryAttempt?: number }) => Promise<void>
  >(() => Promise.resolve())
  const currentLimitRef = useRef(30) // 当前 limit，loadMore 时递增

  // PiUI session list always comes from the PiUI server.
  const fetchSessions = useCallback(
    async (params: SessionListParams & { append?: boolean; retryAttempt?: number } = {}) => {
      const { append = false, retryAttempt = 0, ...queryParams } = params
      const requestId = ++requestIdRef.current
      if (append) {
        setIsLoadingMore(true)
      } else {
        setIsLoading(true)
      }

      try {
        // PiUI never falls back to the legacy SDK when its server is unavailable.
        if (await isPiServerUp()) {
          const directory = currentDirectory?.trim()
          const workspacePath = directory ? await resolveWorkspacePath(directory) : null
          let list = await listPiSessions(workspacePath ?? undefined)
          if (search) {
            const q = search.toLowerCase()
            list = list.filter(s => (s.title || '').toLowerCase().includes(q))
          }
          const data = list.map(s => toUiSession(s, directory || undefined))
          if (requestId !== requestIdRef.current) return
          activeSessionStore.syncPiSummaries(
            data.map((session, index) => ({
              id: session.id,
              title: session.title,
              directory: session.directory,
              state: list[index]?.state,
            })),
          )
          if (append) {
            setSessions(prev => {
              const existingIds = new Set(prev.map(s => s.id))
              return [...prev, ...data.filter(s => !existingIds.has(s.id))]
            })
          } else {
            setSessions(data)
          }
          setHasMore(false)
          return
        }

        throw new Error('PiUI server unavailable')
      } catch (e) {
        if (requestId === requestIdRef.current && !append) {
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
        sessionErrorHandler('fetch sessions', e)
      } finally {
        if (requestId === requestIdRef.current) {
          setIsLoading(false)
          setIsLoadingMore(false)
        }
      }
    },
    [currentDirectory, search],
  )

  // Kept in a ref for Pi session-change notifications and delayed retries.
  useEffect(() => {
    fetchSessionsRef.current = fetchSessions
  }, [fetchSessions])

  // 监听 directory 和 search 变化
  useEffect(() => {
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current)

    // 切换目录或搜索时重置 limit
    currentLimitRef.current = 30

    searchTimerRef.current = window.setTimeout(
      () => {
        fetchSessions()
      },
      search ? 300 : 0,
    )

    return () => {
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current)
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current)
    }
  }, [fetchSessions, search, currentDirectory])

  // Pi bootstrap/create/delete and Pi WS session updates notify this provider.
  useEffect(() => {
    const onPi = () => {
      void fetchSessionsRef.current()
    }
    window.addEventListener("piui:sessions-changed", onPi)
    return () => window.removeEventListener("piui:sessions-changed", onPi)
  }, [])

  // Actions
  const refresh = useCallback(() => fetchSessions(), [fetchSessions])

  const loadMore = useCallback(async () => {
    // 使用 ref 检查，防止并发请求
    if (isLoadingMoreRef.current || !hasMore || sessions.length === 0) return
    isLoadingMoreRef.current = true

    try {
      // 跟官方 webui 一样，递增 limit 重新请求整个列表
      currentLimitRef.current += 15
      setIsLoadingMore(true)
      await fetchSessions()
    } finally {
      isLoadingMoreRef.current = false
      setIsLoadingMore(false)
    }
  }, [hasMore, sessions, fetchSessions])

  const createSession = useCallback(
    async (title?: string) => {
      if (await isPiServerUp()) {
        let workspacePath: string | undefined
        const dir = currentDirectory?.trim()
        if (dir && (/^[a-zA-Z]:[\\/]/.test(dir) || dir.startsWith('/'))) {
          workspacePath = await resolveWorkspacePath(dir) ?? undefined
        }
        const { summary, snapshot } = await createPiSession({
          title,
          seedMock: false,
          workspacePath,
        })
        applySnapshotToUi(snapshot)
        const session = snapshotToUiSession(snapshot, snapshot.session.directory)
        setSessions(prev => [session, ...prev.filter(s => s.id !== summary.id)])
        window.dispatchEvent(new CustomEvent('piui:sessions-changed'))
        return session
      }

      throw new Error('PiUI server unavailable')
    },
    [currentDirectory],
  )

  const deleteSession = useCallback(
    async (id: string) => {
      if (isTrackedPiSession(id) || (await isPiServerUp())) {
        try {
          await deletePiSession(id)
        } catch (error) {
          if ((error as { status?: number }).status !== 404) throw error
        }
        pinnedSessionsStore.unpin(id)
        clearSessionRuntimeState(id)
        paneLayoutStore.clearSession(id)
        setSessions(prev => prev.filter(s => s.id !== id))
        return
      }
      throw new Error('PiUI server unavailable')
    },
    [],
  )

  // 稳定化 Provider value，避免每次渲染创建新对象导致子组件不必要重渲染
  const value = useMemo<SessionContextValue>(
    () => ({
      sessions,
      isLoading,
      isLoadingMore,
      hasMore,
      search,
      setSearch,
      refresh,
      loadMore,
      createSession,
      deleteSession,
    }),
    [sessions, isLoading, isLoadingMore, hasMore, search, refresh, loadMore, createSession, deleteSession],
  )

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
}
