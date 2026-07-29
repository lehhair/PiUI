import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSessions } from './useSessions'

function createDeferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(res => {
    resolve = res
  })
  return { promise, resolve }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFn = (...args: any[]) => any
const {
  listPiNativeSessionsMock,
  listPiNativeSessionsForCwdMock,
  openPiNativeSessionMock,
  postPiGlobalCommandMock,
} = vi.hoisted(() => ({
  listPiNativeSessionsMock: vi.fn<AnyFn>(),
  listPiNativeSessionsForCwdMock: vi.fn<AnyFn>(),
  openPiNativeSessionMock: vi.fn<AnyFn>(),
  postPiGlobalCommandMock: vi.fn<AnyFn>(),
}))

vi.mock('../pi/nativeApi', () => ({
  listPiNativeSessions: (...args: unknown[]) => listPiNativeSessionsMock(...args),
  listPiNativeSessionsForCwd: (...args: unknown[]) => listPiNativeSessionsForCwdMock(...args),
  openPiNativeSession: (...args: unknown[]) => openPiNativeSessionMock(...args),
  postPiGlobalCommand: (...args: unknown[]) => postPiGlobalCommandMock(...args),
}))

vi.mock('../pi/piSessionIndex', () => ({
  trackPiSession: vi.fn(),
}))

function makeSession(id: string, directory = '/workspace/demo') {
  return {
    id,
    path: `/sessions/${id}.jsonl`,
    cwd: directory,
    name: `Session ${id}`,
    created: '2026-07-28T10:00:00.000Z',
    modified: '2026-07-29T10:00:00.000Z',
    messageCount: 1,
    firstMessage: `Message ${id}`,
  }
}

describe('useSessions', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    listPiNativeSessionsMock.mockReset()
    listPiNativeSessionsForCwdMock.mockReset()
    openPiNativeSessionMock.mockReset()
    postPiGlobalCommandMock.mockReset()
    listPiNativeSessionsMock.mockResolvedValue([])
    listPiNativeSessionsForCwdMock.mockResolvedValue([])
    openPiNativeSessionMock.mockResolvedValue({ sessionId: 'new', sessionFile: '/sessions/new.jsonl', cwd: '/workspace/demo' })
    postPiGlobalCommandMock.mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('waits for enabled before fetching', async () => {
    const { rerender } = renderHook(({ enabled }) => useSessions({ directory: '/workspace/demo', enabled }), {
      initialProps: { enabled: false },
    })

    expect(listPiNativeSessionsForCwdMock).not.toHaveBeenCalled()

    rerender({ enabled: true })

    await act(async () => {
      vi.runAllTimers()
      await Promise.resolve()
    })

    expect(listPiNativeSessionsForCwdMock).toHaveBeenCalledWith('/workspace/demo')
  })

  it('passes the scoped directory when removing a session', async () => {
    listPiNativeSessionsForCwdMock.mockResolvedValue([makeSession('session-1')])

    const { result } = renderHook(() => useSessions({ directory: '/workspace/demo' }))

    await act(async () => {
      vi.runAllTimers()
      await Promise.resolve()
    })

    expect(result.current.sessions).toHaveLength(1)

    await act(async () => {
      await result.current.remove('session-1')
    })

    expect(postPiGlobalCommandMock).toHaveBeenCalledWith('session.delete', {
      cwd: '/workspace/demo',
      sessionFile: '/sessions/session-1.jsonl',
    })
  })

  it('requests sessions with the scoped cwd', async () => {
    listPiNativeSessionsForCwdMock.mockResolvedValue([makeSession('session-1')])

    const { result } = renderHook(() => useSessions({ directory: '/workspace/demo' }))

    await act(async () => {
      vi.runAllTimers()
      await Promise.resolve()
    })

    expect(listPiNativeSessionsForCwdMock).toHaveBeenCalledWith('/workspace/demo')
    expect(result.current.sessions.map(session => session.id)).toEqual(['session-1'])
  })

  it('refreshes sessions from Pi events', async () => {
    const { result } = renderHook(() => useSessions({ directory: '/workspace/demo' }))

    await act(async () => {
      vi.runAllTimers()
      await Promise.resolve()
    })

    listPiNativeSessionsForCwdMock.mockResolvedValue([makeSession('session-1')])
    await act(async () => {
      window.dispatchEvent(new CustomEvent('piui:sessions-changed'))
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(result.current.sessions.map(session => session.id)).toEqual(['session-1'])
  })

  it('queues a reconnect refresh while a newer request is still in flight', async () => {
    const firstRequest = createDeferred<ReturnType<typeof makeSession>[]>()
    const secondRequest = createDeferred<ReturnType<typeof makeSession>[]>()
    const thirdRequest = createDeferred<ReturnType<typeof makeSession>[]>()

    listPiNativeSessionsForCwdMock
      .mockImplementationOnce(() => firstRequest.promise)
      .mockImplementationOnce(() => secondRequest.promise)
      .mockImplementationOnce(() => thirdRequest.promise)

    const { result } = renderHook(() => useSessions({ directory: '/workspace/demo' }))

    await act(async () => {
      vi.runAllTimers()
      await Promise.resolve()
    })

    act(() => {
      result.current.setSearch('branch')
    })

    await act(async () => {
      vi.advanceTimersByTime(300)
      await Promise.resolve()
    })

    await act(async () => {
      firstRequest.resolve([makeSession('session-1')])
      await Promise.resolve()
      await Promise.resolve()
    })

    await act(async () => {
      window.dispatchEvent(new CustomEvent('piui:sessions-changed'))
      await Promise.resolve()
    })

    expect(listPiNativeSessionsForCwdMock).toHaveBeenCalledTimes(2)

    await act(async () => {
      secondRequest.resolve([makeSession('session-2')])
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(listPiNativeSessionsForCwdMock).toHaveBeenCalledTimes(3)

    await act(async () => {
      thirdRequest.resolve([{ ...makeSession('session-3'), name: 'Branch session' }])
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(result.current.sessions.map(session => session.id)).toEqual(['session-3'])
  })

  it('retries the initial fetch after a startup failure', async () => {
    listPiNativeSessionsForCwdMock
      .mockRejectedValueOnce(new Error('service not ready'))
      .mockResolvedValueOnce([makeSession('session-1')])

    const { result } = renderHook(() => useSessions({ directory: '/workspace/demo' }))

    await act(async () => {
      vi.runOnlyPendingTimers()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(listPiNativeSessionsForCwdMock).toHaveBeenCalledTimes(1)

    await act(async () => {
      vi.advanceTimersByTime(500)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(listPiNativeSessionsForCwdMock).toHaveBeenCalledTimes(2)
    expect(result.current.sessions.map(session => session.id)).toEqual(['session-1'])
  })

  it('refetches on Pi session changes even while the old request is in flight', async () => {
    const staleRequest = createDeferred<ReturnType<typeof makeSession>[]>()
    const freshRequest = createDeferred<ReturnType<typeof makeSession>[]>()

    listPiNativeSessionsForCwdMock
      .mockImplementationOnce(() => staleRequest.promise)
      .mockImplementationOnce(() => freshRequest.promise)

    const { result } = renderHook(() => useSessions({ directory: '/workspace/demo' }))

    await act(async () => {
      vi.runAllTimers()
      await Promise.resolve()
    })

    expect(listPiNativeSessionsForCwdMock).toHaveBeenCalledTimes(1)

    await act(async () => {
      window.dispatchEvent(new CustomEvent('piui:sessions-changed'))
      await Promise.resolve()
    })

    expect(listPiNativeSessionsForCwdMock).toHaveBeenCalledTimes(1)

    await act(async () => {
      staleRequest.resolve([makeSession('stale')])
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(listPiNativeSessionsForCwdMock).toHaveBeenCalledTimes(2)

    await act(async () => {
      freshRequest.resolve([makeSession('fresh')])
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(result.current.sessions.map(session => session.id)).toEqual(['fresh'])
  })
})
