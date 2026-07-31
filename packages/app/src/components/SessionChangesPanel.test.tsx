import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionChangesPanel } from './SessionChangesPanel'
import { changeScopeStore } from '../store/changeScopeStore'
import { layoutStore } from '../store/layoutStore'
import { FullscreenProvider } from '../contexts'

const { getHostGitInfo, getHostGitDiff, getHostGitFileDiff } = vi.hoisted(() => ({
  getHostGitInfo: vi.fn(),
  getHostGitDiff: vi.fn(),
  getHostGitFileDiff: vi.fn(),
}))

vi.mock('../pi/transport/index.js', () => ({
  getHostGitInfo,
  getHostGitDiff,
  getHostGitFileDiff,
}))

vi.mock('../pi/workspaces', () => ({ resolveWorkspacePath: async (directory?: string) => directory ?? null }))

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
    getHostGitInfo.mockResolvedValue({
      branch: 'feature/test',
      defaultBranch: 'main',
      root: true,
      detached: false,
      unborn: false,
      ahead: 0,
      behind: 0,
    })
    getHostGitFileDiff.mockImplementation(async (_workspace, file) => ({
      file,
      status: 'modified',
      additions: 1,
      deletions: 1,
      binary: false,
      patch: `diff --git a/${file} b/${file}
--- a/${file}
+++ b/${file}
@@ -1 +1 @@
-old
+new
`,
    }))
    getHostGitDiff.mockImplementation(async (_workspace, mode) => ({
      mode,
      files: mode === 'branch'
        ? [{ file: 'src/branch.ts', status: 'modified', additions: 1, deletions: 1, binary: false }]
        : [{ file: 'src/git.ts', status: 'modified', additions: 1, deletions: 1, binary: false }],
    }))
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

    expect(getHostGitDiff).toHaveBeenCalledWith('/repo', 'git', expect.any(AbortSignal))
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

    expect(getHostGitDiff).toHaveBeenCalledWith('/repo', 'branch', expect.any(AbortSignal))
    expect(changeScopeStore.getMode('session-1')).toBe('branch')
    expect(screen.getAllByText('branch.ts').length).toBeGreaterThan(0)
  })

  it('hides the branch scope for unborn repositories', async () => {
    getHostGitInfo.mockResolvedValue({
      branch: 'master',
      unborn: true,
      root: true,
      detached: false,
      ahead: 0,
      behind: 0,
    })
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

    expect(screen.queryByText('Branch changes')).not.toBeInTheDocument()
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

    expect(screen.getByRole('menuitemradio', { name: 'Unstaged' })).toHaveFocus()
  })

  it('does not offer unsupported Git initialization', async () => {
    getHostGitInfo.mockRejectedValueOnce(new Error('not a git repository'))

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
