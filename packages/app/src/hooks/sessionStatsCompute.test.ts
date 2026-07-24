import { describe, expect, it } from 'vitest'
import { computeSessionStats, isSameSessionStats } from './sessionStatsCompute'

describe('computeSessionStats', () => {
  it('switches to estimated context after a compaction turn', () => {
    const stats = computeSessionStats(
      [
        {
          info: {
            id: 'user-1',
            role: 'user',
            time: { created: 1 },
            sessionID: 'session-1',
            agent: 'build',
            model: { providerID: 'p', modelID: 'm' },
          },
          parts: [{ type: 'text', text: 'hello world', id: 'p1', sessionID: 's1', messageID: 'user-1' }],
        },
        {
          info: {
            id: 'assistant-1',
            role: 'assistant',
            sessionID: 'session-1',
            time: { created: 2 },
            parentID: 'user-1',
            modelID: 'model',
            providerID: 'provider',
            mode: 'chat',
            agent: 'default',
            path: { cwd: '/', root: '/' },
            cost: 0,
            tokens: { input: 12000, output: 800, reasoning: 200, cache: { read: 0, write: 0 } },
          },
          parts: [{ type: 'text', text: 'long reply', id: 'p2', sessionID: 's1', messageID: 'assistant-1' }],
        },
        {
          info: {
            id: 'user-2',
            role: 'user',
            time: { created: 3 },
            sessionID: 'session-1',
            agent: 'build',
            model: { providerID: 'p', modelID: 'm' },
          },
          parts: [{ type: 'compaction', id: 'p3', sessionID: 's1', messageID: 'user-2', auto: false }],
        },
        {
          info: {
            id: 'assistant-2',
            role: 'assistant',
            sessionID: 'session-1',
            time: { created: 4 },
            parentID: 'user-2',
            modelID: 'model',
            providerID: 'provider',
            mode: 'compaction',
            agent: 'compaction',
            path: { cwd: '/', root: '/' },
            cost: 0,
            summary: true,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          },
          parts: [{ type: 'text', text: 'short summary', id: 'p4', sessionID: 's1', messageID: 'assistant-2' }],
        },
      ],
      200000,
    )

    expect(stats.contextEstimated).toBe(true)
    expect(stats.contextUsed).toBeLessThan(12000)
    expect(stats.contextUsed).toBeGreaterThan(0)
  })

  it('reuses equality when numeric fields are unchanged', () => {
    const a = computeSessionStats([], 200000)
    const b = computeSessionStats([], 200000)
    expect(isSameSessionStats(a, b)).toBe(true)
    expect(isSameSessionStats(a, { ...b, contextUsed: b.contextUsed + 1 })).toBe(false)
  })
})
