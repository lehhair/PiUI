import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiMessage, ApiMessageWithParts, ApiPart } from '../api/types'
import { messageStore } from '../store/messageStore'
import { useSessionStats } from './useSessionStats'

vi.mock('../store/paneLayoutStore', () => ({
  paneLayoutStore: {
    getFocusedSessionId: vi.fn(() => 'session-1'),
    subscribe: vi.fn(() => vi.fn()),
  },
}))

function createUserMessage(id: string, created: number): ApiMessage {
  return {
    id,
    sessionID: 'session-1',
    role: 'user',
    time: { created },
    agent: 'build',
    model: { providerID: 'provider-1', modelID: 'model-1' },
  }
}

function createTextPart(
  id: string,
  messageID: string,
  text: string,
): ApiPart & { sessionID: string; messageID: string } {
  return {
    id,
    sessionID: 'session-1',
    messageID,
    type: 'text',
    text,
  }
}

function createMessageWithParts(id: string, text: string, created: number): ApiMessageWithParts {
  return {
    info: createUserMessage(id, created),
    parts: [createTextPart(`part-${id}`, id, text)],
  }
}

describe('useSessionStats', () => {
  beforeEach(() => {
    messageStore.clearAll()
  })

  it('returns estimated context after a compaction turn', async () => {
    messageStore.setMessages('session-1', [
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
    ])

    await act(async () => {
      await new Promise(resolve => requestAnimationFrame(resolve))
    })

    const { result } = renderHook(() => useSessionStats(200000))

    expect(result.current.contextEstimated).toBe(true)
    expect(result.current.contextUsed).toBeLessThan(12000)
    expect(result.current.contextUsed).toBeGreaterThan(0)
  })

  it('reuses the same stats object when numeric fields do not change', async () => {
    messageStore.setMessages('session-1', [createMessageWithParts('message-1', 'one', 1)])
    await act(async () => {
      await new Promise(resolve => requestAnimationFrame(resolve))
    })

    const { result, rerender } = renderHook(() => useSessionStats(200000))
    const first = result.current
    rerender()
    expect(result.current).toBe(first)
  })
})
