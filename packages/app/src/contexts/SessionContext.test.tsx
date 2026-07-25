import { useContext } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { SessionProvider } from './SessionContext'
import { SessionContext } from './SessionContext.shared'

const mocks = vi.hoisted(() => ({
  isPiServerUp: vi.fn(),
  listPiSessions: vi.fn(),
  deletePiSession: vi.fn(),
}))

vi.mock('../pi/sessionApi', () => ({
  isPiServerUp: mocks.isPiServerUp,
  listPiSessions: mocks.listPiSessions,
  createPiSession: vi.fn(),
  deletePiSession: mocks.deletePiSession,
}))

vi.mock('./useDirectory', () => ({
  useDirectory: () => ({ currentDirectory: null }),
}))

describe('SessionProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.isPiServerUp.mockResolvedValue(false)
    mocks.listPiSessions.mockResolvedValue([])
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
        workspaceId: 'workspace-1',
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
})
