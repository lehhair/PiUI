import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getVcsDiff, getVcsInfo } from './vcs'

const mocks = vi.hoisted(() => ({
  resolveWorkspaceId: vi.fn(),
  getWorkspaceGitInfo: vi.fn(),
  getWorkspaceGitDiff: vi.fn(),
}))

vi.mock('../pi/sessionApi', () => mocks)

describe('Pi workspace VCS API', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.resolveWorkspaceId.mockResolvedValue('workspace-1')
  })

  it('maps branch and tracking counts', async () => {
    mocks.getWorkspaceGitInfo.mockResolvedValue({ root: true, branch: 'main', ahead: 2, behind: 1 })

    await expect(getVcsInfo('C:/workspace')).resolves.toEqual({ branch: 'main', ahead: 2, behind: 1 })
    expect(mocks.getWorkspaceGitInfo).toHaveBeenCalledWith('workspace-1')
  })

  it('maps supported diff modes to the Pi endpoint', async () => {
    mocks.getWorkspaceGitDiff.mockResolvedValue({
      files: [{ file: 'src/app.ts', status: 'modified', additions: 3, deletions: 1 }],
    })

    await expect(getVcsDiff('staged', '/workspace')).resolves.toEqual([
      { file: 'src/app.ts', status: 'modified', additions: 3, deletions: 1 },
    ])
    expect(mocks.getWorkspaceGitDiff).toHaveBeenCalledWith('workspace-1', 'git')

    await getVcsDiff('branch', '/workspace')
    expect(mocks.getWorkspaceGitDiff).toHaveBeenLastCalledWith('workspace-1', 'branch')
  })

  it('returns empty values when the directory is not a repository', async () => {
    mocks.getWorkspaceGitInfo.mockResolvedValue({ root: false, branch: null, ahead: 0, behind: 0 })
    mocks.getWorkspaceGitDiff.mockRejectedValue(new Error('not a repository'))

    await expect(getVcsInfo('/workspace')).resolves.toBeNull()
    await expect(getVcsDiff('git', '/workspace')).resolves.toEqual([])
  })
})
