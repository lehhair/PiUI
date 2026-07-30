import { useCallback, useRef, useSyncExternalStore } from 'react'
import type { JsonObject, JsonValue } from '@piui/protocol'
import { paneLayoutStore } from '../store/paneLayoutStore'
import { piSessionStateStore } from '../pi/state/index.js'
import { isSameSessionStats } from './sessionStatsCompute'
import type { SessionStats } from './sessionStatsTypes'

export type { SessionStats } from './sessionStatsTypes'
export { formatTokens, formatCost } from './sessionStatsUtils'

function record(value: JsonValue | undefined): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function num(value: JsonValue | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

const EMPTY_STATS: SessionStats = {
  inputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  totalCost: 0,
  contextUsed: 0,
  contextLimit: 200000,
  contextPercent: 0,
  contextEstimated: true,
}

/**
 * 当前 focused session 的统计，来自原生 state.get 的
 * sessionStats/contextUsage（SDK getSessionStats/getContextUsage）。
 */
export function useSessionStats(contextLimit: number = 200000): SessionStats {
  const cacheRef = useRef<SessionStats | null>(null)

  const getSnapshot = useCallback((): SessionStats => {
    const sessionId = paneLayoutStore.getFocusedSessionId()
    const state = sessionId ? piSessionStateStore.getState(sessionId) : null
    if (!state) return EMPTY_STATS

    const stats = record(state.sessionStats)
    const tokens = record(stats.tokens as JsonValue)
    const usage = record(state.contextUsage)

    const contextUsed = num(usage.tokens) ?? 0
    const resolvedContextLimit = num(usage.contextWindow) ?? contextLimit
    const percent = num(usage.percent)
    const next: SessionStats = {
      inputTokens: num(tokens.input) ?? 0,
      outputTokens: num(tokens.output) ?? 0,
      reasoningTokens: 0,
      cacheRead: num(tokens.cacheRead) ?? 0,
      cacheWrite: num(tokens.cacheWrite) ?? 0,
      totalTokens: num(tokens.total) ?? 0,
      totalCost: num(stats.cost as JsonValue) ?? 0,
      contextUsed,
      contextLimit: resolvedContextLimit,
      contextPercent: percent ?? (resolvedContextLimit > 0 ? (contextUsed / resolvedContextLimit) * 100 : 0),
      contextEstimated: usage.tokens == null,
    }
    const prev = cacheRef.current
    if (prev && isSameSessionStats(prev, next)) return prev
    cacheRef.current = next
    return next
  }, [contextLimit])

  const subscribe = useCallback((onStoreChange: () => void) => {
    const unsubState = piSessionStateStore.subscribe(onStoreChange)
    const unsubPane = paneLayoutStore.subscribe(onStoreChange)
    return () => {
      unsubState()
      unsubPane()
    }
  }, [])

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
