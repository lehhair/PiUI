import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionChangesPanel } from './SessionChangesPanel'
import { changeScopeStore } from '../store/changeScopeStore'
import { layoutStore } from '../store/layoutStore'
import { FullscreenProvider } from '../contexts'

const { getCurrentProject, getVcsInfo, getVcsDiff, getVcsFileDiff } = vi.hoisted(() => ({
  getCurrentProject: vi.fn(),
  getVcsInfo: vi.fn(),
  getVcsDiff: vi.fn(),
  getVcsFileDiff: vi.fn(),
}))

vi.mock('../api/client', () => ({
  getCurrentProject,
}))

vi.mock('../api/vcs', () => ({
  getVcsInfo,
  getVcsDiff,
  getVcsFileDiff,
}))

vi.mock('../pi/sessionApi', () => ({ resolveWorkspacePath: async (directory?: string) => directory ?? null }))

vi.mock('./DiffViewer', () => ({
  DiffViewer: () => <div data-testid="diff-viewer">diff viewer</div>,
  useDiffViewerData: () => ({
    beforeTokens: null,
    afterTokens: null,
    pairedLines: [],
    unifiedLines: [],
    lineNumberWidth: 1,
  }),
}))

function renderSessionChangesPanel() {
  return render(
    <FullscreenProvider>
      <SessionChangesPanel sessionId="session-1" directory="/repo" />
    </FullscreenProvider>,
  )
}

describe('SessionChangesPanel', () => {
  beforeEach(() => {
    changeScopeStore.clearAll()
    vi.useFakeTimers()
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(cb =>
      window.setTimeout(() => cb(performance.now()), 16),
    )
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(id => {
      clearTimeout(id)
    })
    getCurrentProject.mockResolvedValue({
      id: 'project-1',
      worktree: '/repo',
      vcs: 'git',
      time: { created: 0, updated: 0 },
      sandboxes: [],
    })
    getVcsInfo.mockResolvedValue({
      branch: 'feature/test',
      default_branch: 'main',
    })
    getVcsFileDiff.mockImplementation(async (_mode, file) => ({
      file,
      additions: 1,
      deletions: 1,
      patch: `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-old\n+new\n`,
    }))
    getVcsDiff.mockImplementation(async mode => {
      if (mode === 'branch') {
        return [
          {
            file: 'src/branch.ts',
            before: 'const branch = 1',
            after: 'const branch = 2',
            additions: 1,
            deletions: 1,
          },
        ]
      }

      return [
        {
          file: 'src/git.ts',
          before: 'const git = 1',
          after: 'const git = 2',
          additions: 1,
          deletions: 1,
        },
      ]
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('loads Git diffs and shows the first file preview by default', async () => {
    renderSessionChangesPanel()

    await act(async () => {
      vi.runAllTimers()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(getVcsDiff).toHaveBeenCalledWith('git', '/repo', expect.any(AbortSignal))
    expect(screen.getByText('1f')).toBeInTheDocument()
    expect(screen.getAllByText('+1').length).toBeGreaterThan(0)
    expect(screen.getAllByText('-1').length).toBeGreaterThan(0)
    expect(screen.getByTestId('diff-viewer')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Change mode: Git changes/ })).toBeInTheDocument()
    expect(screen.getAllByText('git.ts').length).toBeGreaterThan(0)
  })

  it('does not offer unsupported session or turn scopes', async () => {
    renderSessionChangesPanel()

    await act(async () => {
      vi.runAllTimers()
      await Promise.resolve()
      await Promise.resolve()
    })

    fireEvent.click(screen.getByRole('button', { name: /Change mode:/ }))

    await act(async () => {
      vi.advanceTimersByTime(48)
      await Promise.resolve()
    })

    expect(screen.queryByText('Session changes')).not.toBeInTheDocument()
    expect(screen.queryByText('Last turn changes')).not.toBeInTheDocument()
  })

  it('switches to branch changes when available', async () => {
    renderSessionChangesPanel()

    await act(async () => {
      vi.runAllTimers()
      await Promise.resolve()
      await Promise.resolve()
    })

    fireEvent.click(screen.getByRole('button', { name: /Change mode:/ }))

    await act(async () => {
      vi.advanceTimersByTime(48)
      await Promise.resolve()
    })

    fireEvent.click(screen.getByText('Branch changes'))

    await act(async () => {
      vi.advanceTimersByTime(240)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(getVcsDiff).toHaveBeenCalledWith('branch', '/repo', expect.any(AbortSignal))
    expect(changeScopeStore.getMode('session-1')).toBe('branch')
    expect(screen.getAllByText('branch.ts').length).toBeGreaterThan(0)
  })

  it('supports keyboard navigation in the change mode menu and exposes toggle state', async () => {
    renderSessionChangesPanel()

    await act(async () => {
      vi.runAllTimers()
      await Promise.resolve()
      await Promise.resolve()
    })

    fireEvent.click(screen.getByRole('button', { name: /Change mode:/ }))

    await act(async () => {
      vi.runAllTimers()
      await Promise.resolve()
      await Promise.resolve()
    })

    const menu = screen.getByRole('menu', { name: 'Change mode' })
    const gitChangesOption = screen.getByRole('menuitemradio', { name: 'Git changes' })
    const branchChangesOption = screen.getByRole('menuitemradio', { name: 'Branch changes' })

    expect(gitChangesOption).toHaveFocus()
    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    expect(branchChangesOption).toHaveFocus()

    const treeButton = screen.getByRole('button', { name: 'Tree' })
    const listButton = screen.getByRole('button', { name: 'List' })
    const unifiedButton = screen.getByRole('button', { name: 'Unified' })
    const splitButton = screen.getByRole('button', { name: 'Split' })

    expect(treeButton).toHaveAttribute('aria-pressed', 'true')
    expect(unifiedButton).toHaveAttribute('aria-pressed', 'true')

    fireEvent.click(listButton)
    fireEvent.click(splitButton)

    expect(listButton).toHaveAttribute('aria-pressed', 'true')
    expect(treeButton).toHaveAttribute('aria-pressed', 'false')
    expect(splitButton).toHaveAttribute('aria-pressed', 'true')
    expect(unifiedButton).toHaveAttribute('aria-pressed', 'false')
  })

  it('opens the change mode menu from ArrowUp with focus on the last option', async () => {
    renderSessionChangesPanel()

    await act(async () => {
      vi.runAllTimers()
      await Promise.resolve()
      await Promise.resolve()
    })

    fireEvent.keyDown(screen.getByRole('button', { name: /Change mode:/ }), { key: 'ArrowUp' })

    await act(async () => {
      vi.runAllTimers()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(screen.getByRole('menuitemradio', { name: 'Branch changes' })).toHaveFocus()
  })

  it('does not offer unsupported Git initialization', async () => {
    getCurrentProject.mockResolvedValueOnce({
      id: 'global',
      worktree: '/repo',
      time: { created: 0, updated: 0 },
      sandboxes: [],
    })

    renderSessionChangesPanel()

    await act(async () => {
      vi.runAllTimers()
      await Promise.resolve()
    })

    expect(screen.getByText('No Git repository detected')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Initialize Git repository' })).not.toBeInTheDocument()
  })

  it('opens the selected change file in the files panel from the context menu', async () => {
    const openFilePreview = vi.spyOn(layoutStore, 'openFilePreview')

    render(
      <FullscreenProvider>
        <SessionChangesPanel sessionId="session-1" directory="/repo" position="bottom" />
      </FullscreenProvider>,
    )

    await act(async () => {
      vi.runAllTimers()
      await Promise.resolve()
      await Promise.resolve()
    })

    const fileButtons = screen.getAllByRole('button', { name: /git\.ts/ })
    fireEvent.contextMenu(fileButtons[0])
    fireEvent.click(screen.getByRole('button', { name: 'Open in Files' }))

    expect(openFilePreview).toHaveBeenCalledWith({ path: 'src/git.ts', name: 'git.ts' }, 'bottom')
  })
})
