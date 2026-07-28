import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useSessionManager } from './useSessionManager'

const {
  fetchSnapshotMock,
  fetchTimelinePageMock,
  messageStoreMock,
  sessionErrorHandlerMock,
} = vi.hoisted(() => ({
  fetchSnapshotMock: vi.fn(),
  fetchTimelinePageMock: vi.fn(),
  messageStoreMock: {
    getSessionState: vi.fn(),
    setLoadState: vi.fn(),
    setLoadError: vi.fn(),
    setMessages: vi.fn(),
    updateSessionMetadata: vi.fn(),
    prependMessages: vi.fn(),
    prependUiMessages: vi.fn(),
    getHistoryCursor: vi.fn(),
    setRevertState: vi.fn(),
  },
  sessionErrorHandlerMock: vi.fn(),
}))

vi.mock('../pi/sessionApi', () => ({
  fetchSnapshot: (...args: unknown[]) => fetchSnapshotMock(...args),
  fetchPiTimelinePage: (...args: unknown[]) => fetchTimelinePageMock(...args),
}))

vi.mock('../pi/sessionProjectionStore', () => ({
  sessionProjectionStore: {
    activate: vi.fn(),
    getSnapshot: vi.fn(() => ({ session: { directory: '/workspace' }, runtime: {} })),
  },
}))

vi.mock('../pi/applySnapshot', () => ({
  applySnapshotToUi: vi.fn(),
}))

vi.mock('../store', () => ({
  messageStore: messageStoreMock,
}))

vi.mock('../utils', () => ({
  sessionErrorHandler: (...args: unknown[]) => sessionErrorHandlerMock(...args),
}))

describe('useSessionManager', () => {
  beforeEach(() => {
    fetchSnapshotMock.mockReset()
    fetchTimelinePageMock.mockReset()
    messageStoreMock.getSessionState.mockReset()
    messageStoreMock.setLoadState.mockReset()
    messageStoreMock.setLoadError.mockReset()
    messageStoreMock.setMessages.mockReset()
    messageStoreMock.updateSessionMetadata.mockReset()
    messageStoreMock.prependMessages.mockReset()
    messageStoreMock.prependUiMessages.mockReset()
    messageStoreMock.getHistoryCursor.mockReset()
    messageStoreMock.setRevertState.mockReset()
    sessionErrorHandlerMock.mockReset()

    messageStoreMock.getSessionState.mockReturnValue(null)
  })

  it('reports missing route sessions when loading returns not found', async () => {
    const onSessionMissing = vi.fn()
    const notFoundError = Object.assign(new Error('session not found'), { status: 404 })
    fetchSnapshotMock.mockRejectedValue(notFoundError)

    renderHook(() =>
      useSessionManager({
        sessionId: 'missing-session',
        directory: '/workspace/demo',
        onSessionMissing,
      }),
    )

    await waitFor(() => {
      expect(onSessionMissing).toHaveBeenCalledWith('missing-session')
    })

    expect(messageStoreMock.setLoadState).toHaveBeenCalledWith('missing-session', 'loading')
    expect(messageStoreMock.setLoadError).toHaveBeenCalledWith(
      'missing-session',
      expect.objectContaining({ name: 'APIError' }),
    )
  })

  it('loads an older timeline page and prepends it in chronological order', async () => {
    messageStoreMock.getSessionState.mockReturnValue({ loadState: 'loaded', isStale: false, messages: [{}] })
    messageStoreMock.getHistoryCursor.mockReturnValue('cursor-1')
    fetchTimelinePageMock.mockResolvedValue({
      items: [{ type: 'user', id: 'older-user', entryId: 'older-entry', timestamp: 1, text: 'older' }],
      hasMore: false,
    })
    const { result } = renderHook(() => useSessionManager({ sessionId: 'session-1', directory: '/workspace' }))

    await result.current.loadMoreHistory()

    expect(fetchTimelinePageMock).toHaveBeenCalledWith('session-1', 'cursor-1')
    expect(messageStoreMock.prependUiMessages).toHaveBeenCalledWith(
      'session-1',
      [expect.objectContaining({ info: expect.objectContaining({ id: 'older-user' }) })],
      { hasMoreHistory: false, historyCursor: undefined },
    )
  })
})
