import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getCurrentProject, getProjects } from './client'

const mocks = vi.hoisted(() => ({
  resolveWorkspacePath: vi.fn(),
  getHostGitInfo: vi.fn(),
}))

vi.mock('../pi/transport/index.js', () => ({
  getHostGitInfo: mocks.getHostGitInfo,
}))
vi.mock('../pi/workspaces', () => ({
  resolveWorkspacePath: mocks.resolveWorkspacePath,
}))

describe('Pi project adapter', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.resolveWorkspacePath.mockResolvedValue('C:/work/PiUI')
  })

  it('maps the current workspace and Git state to a project', async () => {
    mocks.getHostGitInfo.mockResolvedValue({ root: true, branch: 'main', ahead: 0, behind: 0 })

    await expect(getCurrentProject('C:/work/PiUI')).resolves.toEqual({
      id: 'C:/work/PiUI',
      worktree: 'C:/work/PiUI',
      name: 'PiUI',
      vcs: 'git',
    })
    expect(mocks.getHostGitInfo).toHaveBeenCalledWith('C:/work/PiUI')
  })

  it('omits vcs outside a repository and tolerates git failures', async () => {
    mocks.getHostGitInfo.mockRejectedValue(new Error('not a repo'))

    await expect(getCurrentProject('C:/work/PiUI')).resolves.toEqual({
      id: 'C:/work/PiUI',
      worktree: 'C:/work/PiUI',
      name: 'PiUI',
      vcs: undefined,
    })
  })

  it('lists the selected directory as the only project', async () => {
    mocks.getHostGitInfo.mockResolvedValue({ root: false })

    await expect(getProjects('C:/work/PiUI')).resolves.toHaveLength(1)
    await expect(getProjects()).resolves.toEqual([])
  })

  it('fails when no workspace is available', async () => {
    mocks.resolveWorkspacePath.mockResolvedValue(null)

    await expect(getCurrentProject()).rejects.toThrow('No PiUI workspace is available')
  })
})
