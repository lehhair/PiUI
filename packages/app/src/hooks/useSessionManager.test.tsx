import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useSessionManager } from './useSessionManager'

const {
  loadPiSessionMock,
  fetchNativePageMock,
  appendNativePageMock,
  messageStoreMock,
  nativeStoreMock,
  sessionErrorHandlerMock,
} = vi.hoisted(() => ({
  loadPiSessionMock: vi.fn(),
  fetchNativePageMock: vi.fn(),
  appendNativePageMock: vi.fn(),
  messageStoreMock: {
    getSessionState: vi.fn(),
    setLoadState: vi.fn(),
    setLoadError: vi.fn(),
    clearSession: vi.fn(),
    setMessages: vi.fn(),
    updateSessionMetadata: vi.fn(),
    prependMessages: vi.fn(),
    prependUiMessages: vi.fn(),
    getHistoryCursor: vi.fn(),
    setRevertState: vi.fn(),
  },
  nativeStoreMock: {
    activate: vi.fn(),
    clear: vi.fn(),
    getSnapshot: vi.fn(() => ({ session: { directory: '/workspace' }, runtime: {} })),
    hasNativePage: vi.fn(() => true),
  },
  sessionErrorHandlerMock: vi.fn(),
}))

vi.mock('../pi/sessionApi', () => ({
  fetchPiNativeBranchPage: (...args: unknown[]) => fetchNativePageMock(...args),
}))

vi.mock('../pi/nativeSessionStore', () => ({
  nativeSessionStore: nativeStoreMock,
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
    messageStoreMock.clearSession.mockReset()
    messageStoreMock.setMessages.mockReset()
    messageStoreMock.updateSessionMetadata.mockReset()
    messageStoreMock.prependMessages.mockReset()
    messageStoreMock.prependUiMessages.mockReset()
    messageStoreMock.getHistoryCursor.mockReset()
    messageStoreMock.setRevertState.mockReset()
    nativeStoreMock.hasNativePage.mockReset().mockReturnValue(true)
    nativeStoreMock.activate.mockReset()
    nativeStoreMock.clear.mockReset()
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

  it('does not auto-retry a stable cached load error on remount', () => {
    messageStoreMock.getSessionState.mockReturnValue({
      loadState: 'error',
      isStale: false,
      messages: [],
    })

    renderHook(() => useSessionManager({ sessionId: 'broken-session', directory: '/workspace' }))

    expect(loadPiSessionMock).not.toHaveBeenCalled()
    expect(messageStoreMock.setLoadState).not.toHaveBeenCalled()
  })

  it('reloads a cached message view when its native branch page is missing', async () => {
    messageStoreMock.getSessionState.mockReturnValue({
      loadState: 'loaded',
      isStale: false,
      messages: [{}],
    })
    nativeStoreMock.hasNativePage.mockReturnValue(false)
    loadPiSessionMock.mockResolvedValue(undefined)

    renderHook(() => useSessionManager({ sessionId: 'session-without-branch', directory: '/workspace' }))

    await waitFor(() => expect(loadPiSessionMock).toHaveBeenCalledWith('session-without-branch', { activate: false }))
  })

  it('keeps activation in the hook instead of a late session load', async () => {
    loadPiSessionMock.mockResolvedValue(undefined)

    renderHook(() => useSessionManager({ sessionId: 'session-a', directory: '/workspace' }))

    await waitFor(() => expect(loadPiSessionMock).toHaveBeenCalledWith('session-a', { activate: false }))
    expect(nativeStoreMock.activate).toHaveBeenCalledWith('session-a')
  })

  it('does not reactivate an old session after a stale history request', async () => {
    let rejectHistory!: (error: unknown) => void
    fetchNativePageMock.mockReturnValue(new Promise((_, reject) => { rejectHistory = reject }))
    messageStoreMock.getHistoryCursor.mockReturnValue('cursor-a')
    loadPiSessionMock.mockResolvedValue(undefined)
    const { result, rerender } = renderHook(
      ({ sessionId }) => useSessionManager({ sessionId, directory: '/workspace' }),
      { initialProps: { sessionId: 'session-a' } },
    )
    await waitFor(() => expect(nativeStoreMock.activate).toHaveBeenCalledWith('session-a'))
    const loadMoreA = result.current.loadMoreHistory
    const pending = loadMoreA()

    rerender({ sessionId: 'session-b' })
    await waitFor(() => expect(nativeStoreMock.activate).toHaveBeenLastCalledWith('session-b'))
    rejectHistory(Object.assign(new Error('stale cursor'), { code: 'STALE_CURSOR' }))
    await pending

    expect(nativeStoreMock.activate).toHaveBeenLastCalledWith('session-b')
    expect(loadPiSessionMock).toHaveBeenCalledWith('session-a', { activate: false })
  })
})
