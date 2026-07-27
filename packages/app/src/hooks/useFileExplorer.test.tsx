import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useFileExplorer } from './useFileExplorer'
import { changeScopeStore } from '../store/changeScopeStore'

const { listDirectory, getFileContent, getFileStatus, getVcsDiff, invalidateWorkspaceFileCaches, saveFile, resolveWorkspacePath } = vi.hoisted(() => ({
  listDirectory: vi.fn(),
  getFileContent: vi.fn(),
  getFileStatus: vi.fn(),
  getVcsDiff: vi.fn(),
  invalidateWorkspaceFileCaches: vi.fn(),
  saveFile: vi.fn(),
  resolveWorkspacePath: vi.fn(async (directory?: string) => directory ?? null),
}))

vi.mock('../pi/sessionApi', () => ({ resolveWorkspacePath }))

vi.mock('../api', () => ({
  listDirectory,
  getFileContent,
  getFileStatus,
  getVcsDiff,
  invalidateWorkspaceFileCaches,
  saveFile,
}))

describe('useFileExplorer change scope', () => {
  beforeEach(() => {
    changeScopeStore.clearAll()
    vi.clearAllMocks()

    listDirectory.mockResolvedValue([
      { name: 'src', path: 'src', absolute: '/repo/src', type: 'directory', ignored: false },
      { name: 'session.ts', path: 'src/session.ts', absolute: '/repo/src/session.ts', type: 'file', ignored: false },
      { name: 'turn.ts', path: 'src/turn.ts', absolute: '/repo/src/turn.ts', type: 'file', ignored: false },
    ])
    getFileContent.mockResolvedValue({ type: 'text', content: 'test' })
    getFileStatus.mockResolvedValue([])
    getVcsDiff.mockImplementation(async mode => [
      {
        file: mode === 'branch' ? 'src/branch.ts' : 'src/git.ts',
        before: '',
        after: 'const changed = 1',
        additions: 1,
        deletions: 0,
      },
    ])
  })

  it('updates file statuses when the shared change mode changes', async () => {
    const { result } = renderHook(() => useFileExplorer({ directory: '/repo', autoLoad: true, sessionId: 'session-1' }))

    await waitFor(() => {
      expect(result.current.fileStatus.get('src/git.ts')?.status).toBe('added')
    })

    expect(getVcsDiff).toHaveBeenCalledWith('git', '/repo')

    act(() => {
      changeScopeStore.setMode('session-1', 'branch')
    })

    await waitFor(() => {
      expect(result.current.fileStatus.get('src/branch.ts')?.status).toBe('added')
    })

    expect(result.current.fileStatus.get('src/git.ts')).toBeUndefined()
    expect(getVcsDiff).toHaveBeenCalledWith('branch', '/repo')
  })

  it('restores expanded folders per directory when switching projects', async () => {
    listDirectory.mockImplementation(async (parentPath: string, directory: string) => {
      if (parentPath === '') {
        return [{ name: 'src', path: 'src', absolute: `${directory}/src`, type: 'directory', ignored: false }]
      }

      if (parentPath === 'src') {
        return [
          {
            name: directory === '/repo-a' ? 'a.ts' : 'b.ts',
            path: `src/${directory === '/repo-a' ? 'a.ts' : 'b.ts'}`,
            absolute: `${directory}/src/${directory === '/repo-a' ? 'a.ts' : 'b.ts'}`,
            type: 'file',
            ignored: false,
          },
        ]
      }

      return []
    })

    const { result, rerender } = renderHook(
      ({ directory }) => useFileExplorer({ directory, autoLoad: true }),
      { initialProps: { directory: '/repo-a' } },
    )

    await waitFor(() => {
      expect(result.current.tree).toHaveLength(1)
    })

    act(() => {
      result.current.toggleExpand('src')
    })

    await waitFor(() => {
      expect(result.current.expandedPaths.has('src')).toBe(true)
      expect(result.current.tree[0]?.children?.[0]?.path).toBe('src/a.ts')
    })

    rerender({ directory: '/repo-b' })

    await waitFor(() => {
      expect(result.current.tree[0]?.absolute).toBe('/repo-b/src')
      expect(result.current.tree[0]?.children?.[0]?.path).toBeUndefined()
      expect(result.current.expandedPaths.has('src')).toBe(false)
    })

    rerender({ directory: '/repo-a' })

    await waitFor(() => {
      expect(result.current.tree[0]?.absolute).toBe('/repo-a/src')
      expect(result.current.expandedPaths.has('src')).toBe(true)
      expect(result.current.tree[0]?.children?.[0]?.path).toBe('src/a.ts')
    })
  })

  it('ignores stale child loads after switching directories', async () => {
    let resolveRepoAChildren: (nodes: Array<{ name: string; path: string; absolute: string; type: 'file'; ignored: boolean }>) => void

    listDirectory.mockImplementation((parentPath: string, directory: string) => {
      if (parentPath === '') {
        return Promise.resolve([{ name: 'src', path: 'src', absolute: `${directory}/src`, type: 'directory', ignored: false }])
      }

      if (parentPath === 'src' && directory === '/repo-a') {
        return new Promise(resolve => {
          resolveRepoAChildren = resolve
        })
      }

      if (parentPath === 'src' && directory === '/repo-b') {
        return Promise.resolve([
          { name: 'b.ts', path: 'src/b.ts', absolute: '/repo-b/src/b.ts', type: 'file', ignored: false },
        ])
      }

      return Promise.resolve([])
    })

    const { result, rerender } = renderHook(
      ({ directory }) => useFileExplorer({ directory, autoLoad: true }),
      { initialProps: { directory: '/repo-a' } },
    )

    await waitFor(() => {
      expect(result.current.tree[0]?.absolute).toBe('/repo-a/src')
    })

    act(() => {
      result.current.toggleExpand('src')
    })

    rerender({ directory: '/repo-b' })

    await waitFor(() => {
      expect(result.current.tree[0]?.absolute).toBe('/repo-b/src')
    })

    act(() => {
      result.current.toggleExpand('src')
    })

    await waitFor(() => {
      expect(result.current.tree[0]?.children?.[0]?.path).toBe('src/b.ts')
    })

    await act(async () => {
      resolveRepoAChildren!([
        { name: 'a.ts', path: 'src/a.ts', absolute: '/repo-a/src/a.ts', type: 'file', ignored: false },
      ])
    })

    expect(result.current.tree[0]?.absolute).toBe('/repo-b/src')
    expect(result.current.tree[0]?.children?.map(child => child.path)).toEqual(['src/b.ts'])
  })

  it('refreshes an expanded parent and open preview after a workspace event', async () => {
    listDirectory.mockImplementation(async (parentPath: string) => parentPath === ''
      ? [{ name: 'src', path: 'src', absolute: '/repo/src', type: 'directory', ignored: false }]
      : [{ name: 'a.ts', path: 'src/a.ts', absolute: '/repo/src/a.ts', type: 'file', ignored: false }])
    getFileContent.mockResolvedValueOnce({ type: 'text', content: 'before' })
      .mockResolvedValueOnce({ type: 'text', content: 'after' })
    const { result } = renderHook(() => useFileExplorer({ directory: '/repo', autoLoad: true }))
    await waitFor(() => expect(result.current.tree[0]?.path).toBe('src'))
    act(() => result.current.toggleExpand('src'))
    await waitFor(() => expect(result.current.tree[0]?.children?.[0]?.path).toBe('src/a.ts'))
    await act(() => result.current.loadPreview('src/a.ts'))
    expect(result.current.previewContent?.content).toBe('before')

    act(() => window.dispatchEvent(new CustomEvent('piui:workspace-files-changed', {
      detail: {
        workspacePath: '/repo', revision: 1,
        changes: [{ path: 'src/a.ts', kind: 'changed', type: 'file' }], rescan: false,
      },
    })))
    await waitFor(() => expect(result.current.previewContent?.content).toBe('after'))
    expect(invalidateWorkspaceFileCaches).toHaveBeenCalledWith('/repo')
    expect(listDirectory.mock.calls.filter(call => call[0] === 'src').length).toBeGreaterThanOrEqual(2)
  })
})
