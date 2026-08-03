import { renderHook, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useTerminalSessionRestore } from './useTerminalSessionRestore'
import { layoutStore } from '../store/layoutStore'

const { listHostTerminalsMock, onServerChangeMock, resolveWorkspacePathMock, serverChangeCallback, uiErrorHandlerMock } = vi.hoisted(() => ({
  listHostTerminalsMock: vi.fn(),
  onServerChangeMock: vi.fn<(callback: () => void) => () => void>(() => () => {}),
  resolveWorkspacePathMock: vi.fn(async (directory?: string) => directory ?? null),
  serverChangeCallback: { current: undefined as (() => void) | undefined },
  uiErrorHandlerMock: vi.fn(),
}))

vi.mock('../pi/transport/index.js', () => ({
  listHostTerminals: listHostTerminalsMock,
}))

vi.mock('../store/serverStore', () => ({
  serverStore: { onServerChange: onServerChangeMock },
}))

vi.mock('../pi/workspaces', () => ({
  resolveWorkspacePath: resolveWorkspacePathMock,
}))

vi.mock('../utils', async importOriginal => {
  const actual = await importOriginal<typeof import('../utils')>()
  return { ...actual, uiErrorHandler: uiErrorHandlerMock }
})

describe('useTerminalSessionRestore', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    serverChangeCallback.current = undefined
    onServerChangeMock.mockImplementation((callback: () => void) => {
      serverChangeCallback.current = callback
      return () => {}
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('fetches terminal sessions for the workspace and syncs them into the store', async () => {
    const sessions = [{ id: 't-1', title: 'bash', shell: 'bash', cwd: 'C:/p', status: 'running', cursor: 3 }]
    listHostTerminalsMock.mockResolvedValue({ terminals: sessions })

    const { result } = renderHook(() => useTerminalSessionRestore('C:/p'))

    expect(result.current.isRestoring).toBe(true)
    expect(result.current.normalizedDirectory).toBe('C:/p')

    await waitFor(() => expect(result.current.isRestoring).toBe(false))
    expect(listHostTerminalsMock).toHaveBeenCalledWith('C:/p')
    const tabs = layoutStore.getState().panelTabs.filter(tab => tab.type === 'terminal')
    expect(tabs.map(tab => tab.id)).toEqual(['t-1'])
  })

  it('re-syncs when the workspace changes', async () => {
    listHostTerminalsMock.mockResolvedValue({ terminals: [] })
    const { rerender } = renderHook(({ directory }) => useTerminalSessionRestore(directory), {
      initialProps: { directory: 'C:/one' },
    })

    await waitFor(() => expect(listHostTerminalsMock).toHaveBeenCalledWith('C:/one'))

    listHostTerminalsMock.mockResolvedValue({ terminals: [] })
    rerender({ directory: 'C:/two' })

    await waitFor(() => expect(listHostTerminalsMock).toHaveBeenCalledWith('C:/two'))
    expect(layoutStore.getState().panelTabs.filter(tab => tab.type === 'terminal')).toEqual([])
  })

  it('clears terminal sessions when the workspace is unavailable', async () => {
    const { result } = renderHook(() => useTerminalSessionRestore(undefined))

    await waitFor(() => expect(result.current.isRestoring).toBe(false))
    expect(listHostTerminalsMock).not.toHaveBeenCalled()
    expect(layoutStore.getState().panelTabs.filter(tab => tab.type === 'terminal')).toEqual([])
  })

  it('keeps previous directory synced when fetching fails', async () => {
    listHostTerminalsMock.mockResolvedValue({ terminals: [] })
    const { result } = renderHook(() => useTerminalSessionRestore('C:/p'))

    await waitFor(() => expect(listHostTerminalsMock).toHaveBeenCalledWith('C:/p'))
    expect(layoutStore.getState().panelTabs.filter(tab => tab.type === 'terminal')).toEqual([])

    listHostTerminalsMock.mockRejectedValue(new Error('boom'))
    serverChangeCallback.current?.()

    await waitFor(() => expect(uiErrorHandlerMock).toHaveBeenCalled())
    expect(result.current.isRestoring).toBe(false)
  })

  it('ignores a pending restore after unmount', async () => {
    let resolveRequest: ((value: { terminals: [] }) => void) | undefined
    listHostTerminalsMock.mockReturnValue(
      new Promise(resolve => {
        resolveRequest = resolve
      })
    )
    const syncSpy = vi.spyOn(layoutStore, 'syncTerminalSessions')

    const { unmount } = renderHook(() => useTerminalSessionRestore('C:/p'))
    unmount()
    resolveRequest?.({ terminals: [] })
    await Promise.resolve()

    expect(syncSpy).not.toHaveBeenCalled()
    syncSpy.mockRestore()
  })

  it('finishes restoring when effects are replayed by StrictMode', async () => {
    listHostTerminalsMock.mockResolvedValue({ terminals: [] })
    const { result } = renderHook(() => useTerminalSessionRestore('C:/p'), {
      wrapper: ({ children }) => <StrictMode>{children}</StrictMode>,
    })

    await waitFor(() => expect(result.current.isRestoring).toBe(false))
    expect(listHostTerminalsMock).toHaveBeenCalledWith('C:/p')
  })
})
