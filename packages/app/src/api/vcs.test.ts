import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getVcsDiff, getVcsFileDiff, getVcsInfo } from './vcs'

const mocks = vi.hoisted(() => ({
  resolveWorkspacePath: vi.fn(),
  getHostGitInfo: vi.fn(),
  getHostGitDiff: vi.fn(),
  getHostGitFileDiff: vi.fn(),
}))

vi.mock('../pi/transport/index.js', () => ({
  getHostGitInfo: mocks.getHostGitInfo,
  getHostGitDiff: mocks.getHostGitDiff,
  getHostGitFileDiff: mocks.getHostGitFileDiff,
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
    mocks.getHostGitInfo.mockResolvedValue({ root: true, branch: 'main', ahead: 2, behind: 1 })

    await expect(getVcsInfo('C:/workspace')).resolves.toEqual({ branch: 'main', ahead: 2, behind: 1 })
    expect(mocks.getHostGitInfo).toHaveBeenCalledWith('/workspace', undefined)
  })

  it('maps supported diff modes to the Pi endpoint', async () => {
    mocks.getHostGitDiff.mockResolvedValue({
      files: [{ file: 'src/app.ts', status: 'modified', additions: 3, deletions: 1 }],
    })

    await expect(getVcsDiff('staged', '/workspace')).resolves.toEqual([
      { file: 'src/app.ts', status: 'modified', additions: 3, deletions: 1 },
    ])
    expect(mocks.getHostGitDiff).toHaveBeenCalledWith('/workspace', 'staged', undefined)

    await getVcsDiff('branch', '/workspace')
    expect(mocks.getHostGitDiff).toHaveBeenLastCalledWith('/workspace', 'branch', undefined)
  })

  it('returns null outside a repository and preserves operational failures', async () => {
    mocks.getHostGitInfo.mockResolvedValue({ root: false, branch: null, ahead: 0, behind: 0 })
    mocks.getHostGitDiff.mockRejectedValue(new Error('not a repository'))

    await expect(getVcsInfo('/workspace')).resolves.toBeNull()
    await expect(getVcsDiff('git', '/workspace')).rejects.toThrow('not a repository')
  })

  it('loads a single file patch lazily', async () => {
    mocks.getHostGitFileDiff.mockResolvedValue({
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
    expect(mocks.getHostGitFileDiff).toHaveBeenCalledWith('/workspace', 'src/app.ts', 'git', undefined)
  })
})
