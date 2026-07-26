import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getActiveModels, getCurrentProject, getDefaultModels, getPath, initGitProject } from './client'

const mocks = vi.hoisted(() => ({
  resolveWorkspacePath: vi.fn(),
  getWorkspaceGitInfo: vi.fn(),
  listPiModels: vi.fn(),
}))

vi.mock('../pi/sessionApi', () => mocks)

describe('Pi project and model adapters', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.resolveWorkspacePath.mockResolvedValue('C:/work/PiUI')
  })

  it('maps the current workspace and Git state to a project', async () => {
    mocks.getWorkspaceGitInfo.mockResolvedValue({ root: true, branch: 'main', ahead: 0, behind: 0 })

    await expect(getCurrentProject('C:/work/PiUI')).resolves.toEqual({
      id: 'C:/work/PiUI',
      worktree: 'C:/work/PiUI',
      name: 'PiUI',
      vcs: 'git',
    })
    expect(mocks.getWorkspaceGitInfo).toHaveBeenCalledWith('C:/work/PiUI')
  })

  it('maps only models reported by the Pi server', async () => {
    mocks.listPiModels.mockResolvedValue({
      models: [{
        id: 'model-1',
        name: 'Model One',
        providerId: 'provider-1',
        providerName: 'Provider One',
        family: 'family',
        contextLimit: 100,
        outputLimit: 20,
        supportsReasoning: true,
        supportsImages: false,
        supportsPdf: false,
        supportsAudio: false,
        supportsVideo: false,
        supportsToolcall: true,
        variants: ['high'],
      }],
    })

    await expect(getActiveModels()).resolves.toEqual([
      expect.objectContaining({ id: 'model-1', providerId: 'provider-1', variants: ['high'] }),
    ])
  })

  it('rejects unsupported host path and Git initialization operations explicitly', async () => {
    await expect(getDefaultModels()).rejects.toThrow('PiUI does not expose provider default models')
    await expect(getPath()).rejects.toThrow('PiUI does not expose host path metadata')
    await expect(initGitProject('/workspace')).rejects.toThrow('PiUI does not support Git repository initialization yet')
  })
})
