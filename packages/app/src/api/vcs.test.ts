import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getVcsDiff, getVcsFileDiff, getVcsInfo } from './vcs'

const mocks = vi.hoisted(() => ({
  resolveWorkspacePath: vi.fn(),
  getWorkspaceGitInfo: vi.fn(),
  getWorkspaceGitDiff: vi.fn(),
  getWorkspaceGitFileDiff: vi.fn(),
}))

vi.mock('../pi/sessionApi', () => ({
  getWorkspaceGitInfo: mocks.getWorkspaceGitInfo,
  getWorkspaceGitDiff: mocks.getWorkspaceGitDiff,
  getWorkspaceGitFileDiff: mocks.getWorkspaceGitFileDiff,
}))
vi.mock('../pi/workspaces', () => ({
  resolveWorkspacePath: mocks.resolveWorkspacePath,
}))

describe('Pi workspace VCS API', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.resolveWorkspacePath.mockResolvedValue('/workspace')
  })

  it('maps branch and tracking counts', async () => {
    mocks.getWorkspaceGitInfo.mockResolvedValue({ root: true, branch: 'main', ahead: 2, behind: 1 })

    await expect(getVcsInfo('C:/workspace')).resolves.toEqual({ branch: 'main', ahead: 2, behind: 1 })
    expect(mocks.getWorkspaceGitInfo).toHaveBeenCalledWith('/workspace')
  })

  it('maps supported diff modes to the Pi endpoint', async () => {
    mocks.getWorkspaceGitDiff.mockResolvedValue({
      files: [{ file: 'src/app.ts', status: 'modified', additions: 3, deletions: 1 }],
    })

    await expect(getVcsDiff('staged', '/workspace')).resolves.toEqual([
      { file: 'src/app.ts', status: 'modified', additions: 3, deletions: 1 },
    ])
    expect(mocks.getWorkspaceGitDiff).toHaveBeenCalledWith('/workspace', 'staged')

    await getVcsDiff('branch', '/workspace')
    expect(mocks.getWorkspaceGitDiff).toHaveBeenLastCalledWith('/workspace', 'branch')
  })

  it('returns null outside a repository and preserves operational failures', async () => {
    mocks.getWorkspaceGitInfo.mockResolvedValue({ root: false, branch: null, ahead: 0, behind: 0 })
    mocks.getWorkspaceGitDiff.mockRejectedValue(new Error('not a repository'))

    await expect(getVcsInfo('/workspace')).resolves.toBeNull()
    await expect(getVcsDiff('git', '/workspace')).rejects.toThrow('not a repository')
  })

  it('loads a single file patch lazily', async () => {
    mocks.getWorkspaceGitFileDiff.mockResolvedValue({
      file: 'src/app.ts',
      oldPath: 'src/old.ts',
      status: 'renamed',
      additions: 1,
      deletions: 1,
      binary: false,
      patch: 'diff --git ...',
    })
    await expect(getVcsFileDiff('git', 'src/app.ts', '/workspace')).resolves.toMatchObject({
      file: 'src/app.ts', oldPath: 'src/old.ts', patch: 'diff --git ...',
    })
    expect(mocks.getWorkspaceGitFileDiff).toHaveBeenCalledWith('/workspace', 'git', 'src/app.ts', undefined)
  })
})
