import { useCallback, useEffect, useRef } from 'react'
import { registerSessionConsumer } from './useGlobalEvents'

/**
 * 自动刷新 hook：在合理的时机触发面板数据刷新。
 *
 * 触发时机：
 * 1. Session idle — AI 完成一轮对话后刷新，用户最想看改了什么。
 * 2. 窗口重新聚焦 — 用户可能在外部编辑器改了文件，切回时刷新。
 * 3. SSE 重连 — 断线重连后数据可能过期。
 *
 * 防抖：多次触发在 500ms 内只执行一次，避免请求风暴。
 */
export function useAutoRefresh(
  consumerId: string,
  sessionId: string | null,
  refresh: () => void | Promise<void>,
  enabled: boolean = true,
): void {
  const refreshRef = useRef(refresh)
  refreshRef.current = refresh

  const pendingRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const scheduleRefresh = useCallback(() => {
    if (pendingRef.current !== null) return
    pendingRef.current = setTimeout(() => {
      pendingRef.current = null
      void refreshRef.current()
    }, 500)
  }, [])

  // Session idle + SSE reconnected
  useEffect(() => {
    if (!enabled) return
    return registerSessionConsumer(consumerId, sessionId, {
      onSessionIdle: () => scheduleRefresh(),
      onReconnected: () => scheduleRefresh(),
    })
  }, [consumerId, sessionId, enabled, scheduleRefresh])

  // Window focus / visibility change
  useEffect(() => {
    if (!enabled) return

    const onFocus = () => scheduleRefresh()
    const onVisibility = () => {
      if (document.visibilityState === 'visible') scheduleRefresh()
    }

    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisibility)
      if (pendingRef.current !== null) {
        clearTimeout(pendingRef.current)
        pendingRef.current = null
      }
    }
  }, [enabled, scheduleRefresh])
}
