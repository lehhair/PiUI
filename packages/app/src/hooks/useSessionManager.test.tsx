import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useSessionManager } from './useSessionManager'

const {
  loadPiSessionMock,
  fetchNativePageMock,
  appendNativePageMock,
  messageStoreMock,
  sessionErrorHandlerMock,
} = vi.hoisted(() => ({
  loadPiSessionMock: vi.fn(),
  fetchNativePageMock: vi.fn(),
  appendNativePageMock: vi.fn(),
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
  fetchPiNativeEntriesPage: (...args: unknown[]) => fetchNativePageMock(...args),
}))

vi.mock('../pi/nativeSessionStore', () => ({
  nativeSessionStore: {
    activate: vi.fn(),
    getSnapshot: vi.fn(() => ({ session: { directory: '/workspace' }, runtime: {} })),
  },
}))

vi.mock('../pi/applySnapshot', () => ({
  loadPiSessionToUi: (...args: unknown[]) => loadPiSessionMock(...args),
  appendPiNativeEntriesPageToUi: (...args: unknown[]) => appendNativePageMock(...args),
}))

vi.mock('../store', () => ({
  messageStore: messageStoreMock,
}))

vi.mock('../utils', () => ({
  sessionErrorHandler: (...args: unknown[]) => sessionErrorHandlerMock(...args),
}))

describe('useSessionManager', () => {
  beforeEach(() => {
    loadPiSessionMock.mockReset()
    fetchNativePageMock.mockReset()
    appendNativePageMock.mockReset()
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
    loadPiSessionMock.mockRejectedValue(notFoundError)

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

  it('loads an older native entries page and rebuilds the local projection', async () => {
    messageStoreMock.getSessionState.mockReturnValue({ loadState: 'loaded', isStale: false, messages: [{}] })
    messageStoreMock.getHistoryCursor.mockReturnValue('cursor-1')
    const page = {
      head: { namespace: 'pi', schemaVersion: 1, sdkVersion: 'test', revision: 1, epoch: 'native', header: null, leafId: 'newer', entryCount: 2 },
      items: [{ type: 'message', id: 'older-user', parentId: null, message: { role: 'user', content: 'older' } }],
      hasMore: false,
    }
    fetchNativePageMock.mockResolvedValue(page)
    const { result } = renderHook(() => useSessionManager({ sessionId: 'session-1', directory: '/workspace' }))

    await result.current.loadMoreHistory()

    expect(fetchNativePageMock).toHaveBeenCalledWith('session-1', 'cursor-1')
    expect(appendNativePageMock).toHaveBeenCalledWith('session-1', page)
  })
})
