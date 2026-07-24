import { useCallback, useRef, useSyncExternalStore } from 'react'
import { messageStore } from '../store/messageStore'
import { paneLayoutStore } from '../store/paneLayoutStore'
import { computeSessionStats, isSameSessionStats } from './sessionStatsCompute'
import type { SessionStats } from './sessionStatsTypes'

export type { SessionStats } from './sessionStatsTypes'
export { formatTokens, formatCost } from './sessionStatsUtils'

/** 流式时 footer 统计最多每 200ms 推一次；结束/非流式立即更新 */
const STREAMING_STATS_INTERVAL_MS = 200

/**
 * 当前 focused session 的统计。
 * 直接订 messageStore，流式期间节流通知，避免 footer 每 token 重渲。
 */
export function useSessionStats(contextLimit: number = 200000): SessionStats {
  const cacheRef = useRef<SessionStats | null>(null)

  const getSnapshot = useCallback((): SessionStats => {
    const sessionId = paneLayoutStore.getFocusedSessionId()
    const messages = messageStore.getVisibleMessages(sessionId)
    const next = computeSessionStats(messages, contextLimit)
    const prev = cacheRef.current
    if (prev && isSameSessionStats(prev, next)) return prev
    cacheRef.current = next
    return next
  }, [contextLimit])

  const subscribe = useCallback((onStoreChange: () => void) => {
    let timer: ReturnType<typeof setTimeout> | null = null

    const notifyNow = () => {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      onStoreChange()
    }

    const schedule = () => {
      const sessionId = paneLayoutStore.getFocusedSessionId()
      if (!messageStore.getIsStreaming(sessionId)) {
        notifyNow()
        return
      }
      if (timer) return
      timer = setTimeout(() => {
        timer = null
        onStoreChange()
      }, STREAMING_STATS_INTERVAL_MS)
    }

    const unsubMessage = messageStore.subscribe(schedule)
    const unsubPane = paneLayoutStore.subscribe(schedule)
    return () => {
      unsubMessage()
      unsubPane()
      if (timer) clearTimeout(timer)
    }
  }, [])

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
