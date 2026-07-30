import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { piSessionStateStore } from '../pi/state/index.js'
import { useSessionStats } from './useSessionStats'

vi.mock('../store/paneLayoutStore', () => ({
  paneLayoutStore: {
    getFocusedSessionId: vi.fn(() => 'session-1'),
    subscribe: vi.fn(() => vi.fn()),
  },
}))

describe('useSessionStats', () => {
  beforeEach(() => {
    piSessionStateStore.clearAll()
  })

  it('reads authoritative stats and context usage from the native state', () => {
    piSessionStateStore.setState('session-1', {
      sessionStats: {
        tokens: { input: 12000, output: 800, cacheRead: 100, cacheWrite: 50, total: 12950 },
        cost: 0.42,
      },
      contextUsage: { tokens: 64000, contextWindow: 200000, percent: 32 },
    })

    const { result } = renderHook(() => useSessionStats(200000))

    expect(result.current).toMatchObject({
      inputTokens: 12000,
      outputTokens: 800,
      cacheRead: 100,
      cacheWrite: 50,
      totalTokens: 12950,
      totalCost: 0.42,
      contextUsed: 64000,
      contextLimit: 200000,
      contextPercent: 32,
      contextEstimated: false,
    })
  })

  it('marks context as estimated when the native tokens are unknown', () => {
    piSessionStateStore.setState('session-1', {
      sessionStats: { tokens: { input: 10, output: 5, total: 15 }, cost: 0 },
      contextUsage: { tokens: null, contextWindow: 128000, percent: null },
    })

    const { result } = renderHook(() => useSessionStats(200000))

    expect(result.current.contextEstimated).toBe(true)
    expect(result.current.contextLimit).toBe(128000)
    expect(result.current.contextPercent).toBe(0)
  })

  it('returns empty stats without a loaded session state', () => {
    const { result } = renderHook(() => useSessionStats(200000))

    expect(result.current.totalTokens).toBe(0)
    expect(result.current.contextEstimated).toBe(true)
  })

  it('reuses the same stats object when numeric fields do not change', async () => {
    piSessionStateStore.setState('session-1', {
      sessionStats: { tokens: { input: 1, output: 2, total: 3 }, cost: 0 },
      contextUsage: { tokens: 10, contextWindow: 100, percent: 10 },
    })

    const { result, rerender } = renderHook(() => useSessionStats(200000))
    const first = result.current
    await act(async () => {
      piSessionStateStore.setState('session-1', {
        sessionStats: { tokens: { input: 1, output: 2, total: 3 }, cost: 0 },
        contextUsage: { tokens: 10, contextWindow: 100, percent: 10 },
      })
    })
    rerender()
    expect(result.current).toBe(first)
  })
})
