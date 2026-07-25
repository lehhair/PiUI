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
  listPiSessionsMock,
  createPiSessionMock,
  deletePiSessionMock,
  resolveWorkspaceIdMock,
} = vi.hoisted(() => ({
  listPiSessionsMock: vi.fn<AnyFn>(),
  createPiSessionMock: vi.fn<AnyFn>(),
  deletePiSessionMock: vi.fn<AnyFn>(),
  resolveWorkspaceIdMock: vi.fn<AnyFn>(),
}))

vi.mock('../pi/sessionApi', () => ({
  listPiSessions: (...args: unknown[]) => listPiSessionsMock(...args),
  createPiSession: (...args: unknown[]) => createPiSessionMock(...args),
  deletePiSession: (...args: unknown[]) => deletePiSessionMock(...args),
  resolveWorkspaceId: (...args: unknown[]) => resolveWorkspaceIdMock(...args),
}))

vi.mock('../pi/toApiSession', () => ({
  toApiSession: (session: unknown) => session,
}))

function makeSession(id: string, directory = '/workspace/demo') {
  return {
    id,
    slug: id,
    workspaceId: 'project-1',
    projectID: 'project-1',
    directory,
    title: `Session ${id}`,
    version: '1',
    time: {
      created: 1,
      updated: 2,
    },
  }
}

describe('useSessions', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    listPiSessionsMock.mockReset()
    createPiSessionMock.mockReset()
    deletePiSessionMock.mockReset()
    resolveWorkspaceIdMock.mockReset()
    listPiSessionsMock.mockResolvedValue([])
    createPiSessionMock.mockResolvedValue({ summary: makeSession('new') })
    deletePiSessionMock.mockResolvedValue(undefined)
    resolveWorkspaceIdMock.mockResolvedValue('project-1')
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('waits for enabled before fetching', async () => {
    const { rerender } = renderHook(({ enabled }) => useSessions({ directory: '/workspace/demo', enabled }), {
      initialProps: { enabled: false },
    })

    expect(listPiSessionsMock).not.toHaveBeenCalled()

    rerender({ enabled: true })

    await act(async () => {
      vi.runAllTimers()
      await Promise.resolve()
    })

    expect(listPiSessionsMock).toHaveBeenCalledWith()
  })

  it('passes the scoped directory when removing a session', async () => {
    listPiSessionsMock.mockResolvedValue([makeSession('session-1')])

    const { result } = renderHook(() => useSessions({ directory: '/workspace/demo' }))

    await act(async () => {
      vi.runAllTimers()
      await Promise.resolve()
    })

    expect(result.current.sessions).toHaveLength(1)

    await act(async () => {
      await result.current.remove('session-1')
    })

    expect(deletePiSessionMock).toHaveBeenCalledWith('session-1')
  })

  it('filters sessions by the resolved Pi workspace', async () => {
    listPiSessionsMock.mockResolvedValue([
      makeSession('session-1'),
      { ...makeSession('session-2'), workspaceId: 'project-2', projectID: 'project-2' },
    ])

    const { result } = renderHook(() => useSessions({ directory: '/workspace/demo' }))

    await act(async () => {
      vi.runAllTimers()
      await Promise.resolve()
    })

    expect(resolveWorkspaceIdMock).toHaveBeenCalledWith('/workspace/demo')
    expect(result.current.sessions.map(session => session.id)).toEqual(['session-1'])
  })

  it('refreshes sessions from Pi events', async () => {
    const { result } = renderHook(() => useSessions({ directory: '/workspace/demo' }))

    await act(async () => {
      vi.runAllTimers()
      await Promise.resolve()
    })

    listPiSessionsMock.mockResolvedValue([makeSession('session-1')])
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

    listPiSessionsMock
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

    expect(listPiSessionsMock).toHaveBeenCalledTimes(2)

    await act(async () => {
      secondRequest.resolve([makeSession('session-2')])
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(listPiSessionsMock).toHaveBeenCalledTimes(3)

    await act(async () => {
      thirdRequest.resolve([{ ...makeSession('session-3'), title: 'Branch session' }])
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(result.current.sessions.map(session => session.id)).toEqual(['session-3'])
  })

  it('retries the initial fetch after a startup failure', async () => {
    listPiSessionsMock
      .mockRejectedValueOnce(new Error('service not ready'))
      .mockResolvedValueOnce([makeSession('session-1')])

    const { result } = renderHook(() => useSessions({ directory: '/workspace/demo' }))

    await act(async () => {
      vi.runOnlyPendingTimers()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(listPiSessionsMock).toHaveBeenCalledTimes(1)

    await act(async () => {
      vi.advanceTimersByTime(500)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(listPiSessionsMock).toHaveBeenCalledTimes(2)
    expect(result.current.sessions.map(session => session.id)).toEqual(['session-1'])
  })

  it('refetches on Pi session changes even while the old request is in flight', async () => {
    const staleRequest = createDeferred<ReturnType<typeof makeSession>[]>()
    const freshRequest = createDeferred<ReturnType<typeof makeSession>[]>()

    listPiSessionsMock
      .mockImplementationOnce(() => staleRequest.promise)
      .mockImplementationOnce(() => freshRequest.promise)

    const { result } = renderHook(() => useSessions({ directory: '/workspace/demo' }))

    await act(async () => {
      vi.runAllTimers()
      await Promise.resolve()
    })

    expect(listPiSessionsMock).toHaveBeenCalledTimes(1)

    await act(async () => {
      window.dispatchEvent(new CustomEvent('piui:sessions-changed'))
      await Promise.resolve()
    })

    expect(listPiSessionsMock).toHaveBeenCalledTimes(1)

    await act(async () => {
      staleRequest.resolve([makeSession('stale')])
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(listPiSessionsMock).toHaveBeenCalledTimes(2)

    await act(async () => {
      freshRequest.resolve([makeSession('fresh')])
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(result.current.sessions.map(session => session.id)).toEqual(['fresh'])
  })
})
