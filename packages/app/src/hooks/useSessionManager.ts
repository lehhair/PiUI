// ============================================
// useSessionManager - Session 加载和状态管理
// ============================================
//
// 职责：
// 1. 加载 session 消息（初始加载 + 懒加载历史）
// 2. 处理 undo/redo（调用 API + 更新 store）
// 3. 只管理单个 session 的加载状态，不再承担全局当前 session 同步

import { useCallback, useEffect, useRef } from 'react'
import { logger } from '../utils/logger'
import { messageStore } from '../store'
import { sessionErrorHandler } from '../utils'
import { isSessionNotFoundError } from '../utils/sessionErrors'
import type { MessageError } from '../types/message'
import { sessionProjectionStore } from '../pi/sessionProjectionStore'
import { fetchSnapshot } from '../pi/sessionApi'
import { applySnapshotToUi } from '../pi/applySnapshot'

function toLoadMessageError(error: unknown): MessageError {
  const message = error instanceof Error ? error.message : String(error || 'Failed to load session')
  return {
    name: 'APIError',
    data: {
      message,
      isRetryable: true,
      responseBody: error instanceof Error ? error.stack : undefined,
    },
  }
}

interface UseSessionManagerOptions {
  sessionId: string | null
  directory?: string // 当前项目目录
  onLoadComplete?: () => void
  onError?: (error: Error) => void
  onSessionMissing?: (sessionId: string) => void
}

export function useSessionManager({ sessionId, directory, onLoadComplete, onError, onSessionMissing }: UseSessionManagerOptions) {
  const loadSequenceRef = useRef<Map<string, number>>(new Map())
  const loadSessionRef = useRef<(sid: string, options?: { force?: boolean }) => Promise<void>>(async () => {})

  // 使用 ref 保存 directory，避免依赖变化
  const directoryRef = useRef(directory)

  useEffect(() => {
    directoryRef.current = directory
  }, [directory])

  // ============================================
  // Load Session
  // ============================================

  const loadSession = useCallback(
    async (sid: string, options?: { force?: boolean }) => {
      const force = options?.force ?? false

      const seq = (loadSequenceRef.current.get(sid) ?? 0) + 1
      loadSequenceRef.current.set(sid, seq)
      const isStale = () => loadSequenceRef.current.get(sid) !== seq

      const existingState = messageStore.getSessionState(sid)
      const hasExistingMessages = existingState && existingState.messages.length > 0
      sessionProjectionStore.activate(sid)
      const cached = sessionProjectionStore.getSnapshot(sid)
      if (cached && hasExistingMessages && !force) {
        messageStore.updateSessionMetadata(sid, { loadState: 'loaded', title: cached.session.title })
        if (!isStale()) onLoadComplete?.()
        return
      }
      messageStore.setLoadState(sid, 'loading')
      try {
        const snapshot = await fetchSnapshot(sid)
        if (isStale()) return
        applySnapshotToUi(snapshot)
        if (!force) onLoadComplete?.()
      } catch (error) {
        if (isStale()) return
        sessionErrorHandler('load session', error)
        messageStore.setLoadError(sid, toLoadMessageError(error))
        if (isSessionNotFoundError(error)) {
          onSessionMissing?.(sid)
        }
        onError?.(error instanceof Error ? error : new Error(String(error)))
      }
    },
    [onLoadComplete, onError, onSessionMissing],
  )

  // 保持 ref 同步，避免 effect 依赖 loadSession 导致重复触发
  useEffect(() => {
    loadSessionRef.current = loadSession
  }, [loadSession])

  // ============================================
  // Load More History
  // ============================================

  const loadMoreHistory = useCallback(async () => {
    if (!sessionId) return
    try {
      applySnapshotToUi(await fetchSnapshot(sessionId))
    } catch (error) {
      sessionErrorHandler('load more history', error)
    }
  }, [sessionId])

  // ============================================
  // Undo
  // ============================================

  const handleUndo = useCallback(
    async (userMessageId: string) => {
      if (!sessionId) return
      void userMessageId
      sessionErrorHandler('undo', new Error('PiUI does not support undo yet'))
    },
    [sessionId],
  )

  // ============================================
  // Redo
  // ============================================

  const handleRedo = useCallback(async () => {
    if (!sessionId) return
    sessionErrorHandler('redo', new Error('PiUI does not support redo yet'))
  }, [sessionId])

  // ============================================
  // Redo All
  // ============================================

  const handleRedoAll = useCallback(async () => {
    if (!sessionId) return
    sessionErrorHandler('redo all', new Error('PiUI does not support redo yet'))
  }, [sessionId])

  // ============================================
  // Clear Revert
  // ============================================

  const clearRevert = useCallback(() => {
    if (!sessionId) return
    messageStore.setRevertState(sessionId, null)
  }, [sessionId])

  // ============================================
  // Effects
  // ============================================

  // 根据 sessionId 切换缓存视图。
  // focused pane / URL 的同步由 App 顶层统一负责，
  // 这里不再写任何“全局当前 session”状态。
  useEffect(() => {
    if (sessionId) {
      const cached = messageStore.getSessionState(sessionId)
      const canUseCached = !!cached && cached.loadState === 'loaded' && !cached.isStale && cached.messages.length > 0

      if (canUseCached) {
        logger.log('[SessionManager] switch:use-cached', {
          sessionId,
          cachedCount: cached.messages.length,
        })
        return
      }

      logger.log('[SessionManager] switch:fetch-session', { sessionId })
      void loadSessionRef.current(sessionId)
    }
  }, [sessionId])

  return {
    loadSession,
    loadMoreHistory,
    handleUndo,
    handleRedo,
    handleRedoAll,
    clearRevert,
  }
}
