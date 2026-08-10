import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useContext } from 'react'
import { SessionProvider } from './SessionContext'
import { SessionContext } from './SessionContext.shared'
import { activeSessionStore } from '../store/activeSessionStore'
import type { SessionInfo } from '@earendil-works/pi-coding-agent'

const mocks = vi.hoisted(() => ({
  loadPiSessions: vi.fn<(signal?: AbortSignal) => Promise<SessionInfo[]>>(),
  loadPiSessionsForCwd: vi.fn<(cwd: string, signal?: AbortSignal) => Promise<SessionInfo[]>>(),
  openPiSession: vi.fn(),
  deletePiSession: vi.fn<(cwd: string, sessionFile: string) => Promise<void>>(),
  currentDirectory: null as string | null,
}))

vi.mock('../pi/controllers/index.js', () => ({
  loadPiSessions: mocks.loadPiSessions,
  loadPiSessionsForCwd: mocks.loadPiSessionsForCwd,
  openPiSession: mocks.openPiSession,
  deletePiSession: mocks.deletePiSession,
}))

vi.mock('./useDirectory', () => ({
  useDirectory: () => ({ currentDirectory: mocks.currentDirectory }),
}))

function sessionInfo(id: string, cwd: string, name?: string): SessionInfo {
  return {
    id,
    path: `/sessions/${id}.jsonl`,
    cwd,
    name,
    created: new Date('2026-01-01T00:00:00.000Z'),
    modified: new Date('2026-01-02T00:00:00.000Z'),
    firstMessage: name ?? id,
    allMessagesText: name ?? id,
    messageCount: 1,
  }
}

describe('SessionProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.loadPiSessions.mockResolvedValue([])
    mocks.loadPiSessionsForCwd.mockResolvedValue([])
    mocks.currentDirectory = null
    activeSessionStore.initialize({})
  })

  it('loads the global session list on mount', async () => {
    mocks.loadPiSessions.mockResolvedValue([sessionInfo('session-1', '/workspace', 'Keep me')])
    const { result } = renderHook(() => useContext(SessionContext), { wrapper: SessionProvider })

    await waitFor(() => expect(result.current?.isLoading).toBe(false))
    expect(mocks.loadPiSessions).toHaveBeenCalled()
    expect(result.current?.sessions).toHaveLength(1)
    expect(result.current?.sessions[0]).toMatchObject({ id: 'session-1', title: 'Keep me' })
  })

  it('always returns the global list even when a directory is selected (display filtering lives in SidePanel)', async () => {
    mocks.currentDirectory = '/workspace/demo'
    mocks.loadPiSessions.mockResolvedValue([
      sessionInfo('session-1', '/workspace/demo', 'In workspace'),
      sessionInfo('session-2', '/other/project', 'Elsewhere'),
    ])
    const { result } = renderHook(() => useContext(SessionContext), { wrapper: SessionProvider })

    await waitFor(() => expect(result.current?.isLoading).toBe(false))
    // 数据源始终是全局列表，不做目录过滤（活跃 tab / 标题解析都依赖全局）
    expect(mocks.loadPiSessions).toHaveBeenCalled()
    expect(mocks.loadPiSessionsForCwd).not.toHaveBeenCalled()
    expect(result.current?.sessions).toHaveLength(2)
    expect(result.current?.sessions[0]).toMatchObject({ id: 'session-1', title: 'In workspace' })
  })

  it('keeps a session visible when durable deletion fails', async () => {
    mocks.loadPiSessions.mockResolvedValue([sessionInfo('session-1', '/workspace', 'Keep me')])
    mocks.deletePiSession.mockRejectedValue(new Error('delete failed'))
    const { result } = renderHook(() => useContext(SessionContext), { wrapper: SessionProvider })
    await waitFor(() => expect(result.current?.sessions).toHaveLength(1))

    await expect(
      act(async () => {
        await result.current?.deleteSession('session-1')
      }),
    ).rejects.toThrow('delete failed')
    expect(result.current?.sessions).toHaveLength(1)
  })

  it('deletes through the native session file path', async () => {
    mocks.loadPiSessions.mockResolvedValue([sessionInfo('session-1', '/workspace', 'Bye')])
    mocks.deletePiSession.mockResolvedValue(undefined)
    const { result } = renderHook(() => useContext(SessionContext), { wrapper: SessionProvider })
    await waitFor(() => expect(result.current?.sessions).toHaveLength(1))

    await act(async () => {
      await result.current?.deleteSession('session-1')
    })

    expect(mocks.deletePiSession).toHaveBeenCalledWith('/workspace', '/sessions/session-1.jsonl')
    expect(result.current?.sessions).toHaveLength(0)
  })
})
