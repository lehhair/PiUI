import { useContext } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { SessionProvider } from './SessionContext'
import { SessionContext } from './SessionContext.shared'
import { activeSessionStore } from '../store/activeSessionStore'

const mocks = vi.hoisted(() => ({
  isPiServerUp: vi.fn(),
  listPiSessions: vi.fn(),
  resolveWorkspacePath: vi.fn(),
  deletePiSession: vi.fn(),
  currentDirectory: null as string | null,
}))

vi.mock('../pi/sessionApi', () => ({
  isPiServerUp: mocks.isPiServerUp,
  listPiSessions: mocks.listPiSessions,
  resolveWorkspacePath: mocks.resolveWorkspacePath,
  createPiSession: vi.fn(),
  deletePiSession: mocks.deletePiSession,
}))

vi.mock('./useDirectory', () => ({
  useDirectory: () => ({ currentDirectory: mocks.currentDirectory }),
}))

describe('SessionProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.isPiServerUp.mockResolvedValue(false)
    mocks.listPiSessions.mockResolvedValue([])
    mocks.resolveWorkspacePath.mockResolvedValue(null)
    mocks.currentDirectory = null
    activeSessionStore.initialize({})
  })

  it('does not fall back to the legacy SDK when PiUI server is unavailable', async () => {
    const { result } = renderHook(() => useContext(SessionContext), { wrapper: SessionProvider })

    await waitFor(() => expect(result.current?.isLoading).toBe(false))
    expect(result.current?.sessions).toEqual([])
  })

  it('keeps a session visible when durable deletion fails', async () => {
    mocks.isPiServerUp.mockResolvedValue(true)
    mocks.listPiSessions.mockResolvedValue([
      {
        id: 'session-1',
        directory: '/workspace',
        title: 'Keep me',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z',
      },
    ])
    mocks.deletePiSession.mockRejectedValue(Object.assign(new Error('delete failed'), { status: 500 }))
    const { result } = renderHook(() => useContext(SessionContext), { wrapper: SessionProvider })
    await waitFor(() => expect(result.current?.sessions).toHaveLength(1))

    await expect(
      act(async () => {
        await result.current?.deleteSession('session-1')
      }),
    ).rejects.toThrow('delete failed')
    expect(result.current?.sessions).toHaveLength(1)
  })

  it('requests only sessions from the current directory workspace', async () => {
    mocks.currentDirectory = 'E:/work/project-a'
    mocks.isPiServerUp.mockResolvedValue(true)
    mocks.resolveWorkspacePath.mockResolvedValue('E:/work/project-a')
    mocks.listPiSessions.mockResolvedValue([
      {
        id: 'session-a',
        directory: 'E:/work/project-a',
        state: 'running',
        title: 'Project A',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z',
      },
    ])

    const { result } = renderHook(() => useContext(SessionContext), { wrapper: SessionProvider })
    await waitFor(() => expect(result.current?.sessions).toHaveLength(1))

    expect(mocks.resolveWorkspacePath).toHaveBeenCalledWith('E:/work/project-a')
    expect(mocks.listPiSessions).toHaveBeenCalledWith('E:/work/project-a')
    expect(activeSessionStore.getBusySessions()).toEqual([
      expect.objectContaining({
        sessionId: 'session-a',
        title: 'Project A',
        directory: 'E:/work/project-a',
        status: { type: 'busy' },
      }),
    ])
  })
})
