import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getFileContent, getFileStatus, listDirectory, searchFiles, searchSymbols, searchText } from './file'

const mocks = vi.hoisted(() => ({
  resolveWorkspacePath: vi.fn(),
  listWorkspaceFiles: vi.fn(),
  readWorkspaceFile: vi.fn(),
  searchWorkspaceFiles: vi.fn(),
  searchWorkspaceText: vi.fn(),
  getWorkspaceGitStatus: vi.fn(),
}))

vi.mock('../pi/sessionApi', () => mocks)

describe('Pi workspace file API', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.resolveWorkspacePath.mockResolvedValue('C:/workspace')
  })

  it('maps directory entries and reads files through the resolved workspace', async () => {
    mocks.listWorkspaceFiles.mockResolvedValue({
      entries: [
        { name: 'src', path: 'src', type: 'directory' },
        { name: 'README.md', path: 'README.md', type: 'file' },
        { name: 'secret', path: 'secret', type: 'file', restricted: true },
      ],
    })
    mocks.readWorkspaceFile.mockResolvedValue({ content: '# PiUI', encoding: 'utf-8' })

    await expect(listDirectory('.', 'C:/workspace')).resolves.toEqual([
      { name: 'src', path: 'src', absolute: 'C:/workspace/src', type: 'directory', ignored: false },
      { name: 'README.md', path: 'README.md', absolute: 'C:/workspace/README.md', type: 'file', ignored: false },
    ])
    await expect(getFileContent('README.md', 'C:/workspace')).resolves.toEqual({
      type: 'text',
      content: '# PiUI',
      encoding: 'utf-8',
    })
    expect(mocks.listWorkspaceFiles).toHaveBeenCalledWith('C:/workspace', '')
    expect(mocks.readWorkspaceFile).toHaveBeenCalledWith('C:/workspace', 'README.md')
  })

  it('keeps the selected POSIX parent in child directory paths', async () => {
    mocks.listWorkspaceFiles.mockResolvedValue({
      entries: [{ name: 'abcc', path: 'abcc', type: 'directory' }],
    })

    await expect(listDirectory('/abc/')).resolves.toEqual([
      { name: 'abcc', path: 'abcc', absolute: '/abc/abcc', type: 'directory', ignored: false },
    ])
    expect(mocks.resolveWorkspacePath).toHaveBeenCalledWith('/abc/')
    expect(mocks.listWorkspaceFiles).toHaveBeenCalledWith('C:/workspace', '')
  })

  it('delegates filename and text searches without an SDK fallback', async () => {
    const textMatches = [{
      path: { text: 'src/app.ts' },
      lines: { text: 'const app = "PiUI"' },
      line_number: 1,
      absolute_offset: 0,
      submatches: [{ start: 13, end: 17, match: { text: 'PiUI' } }],
    }]
    mocks.searchWorkspaceFiles.mockResolvedValue(['src/app.ts'])
    mocks.searchWorkspaceText.mockResolvedValue(textMatches)

    await expect(searchFiles('app', { directory: '/workspace', type: 'file', limit: 20 })).resolves.toEqual([
      'src/app.ts',
    ])
    await expect(searchText('PiUI', '/workspace')).resolves.toEqual(textMatches)
    expect(mocks.searchWorkspaceFiles).toHaveBeenCalledWith('C:/workspace', 'app', { type: 'file', limit: 20 })
    expect(mocks.searchWorkspaceText).toHaveBeenCalledWith('C:/workspace', 'PiUI')
  })

  it('maps Git status and reports unsupported symbol search explicitly', async () => {
    mocks.getWorkspaceGitStatus.mockResolvedValue({
      items: [{ path: 'src/app.ts', status: 'modified' }],
    })

    await expect(getFileStatus('/workspace')).resolves.toEqual([
      { path: 'src/app.ts', status: 'modified', added: 0, removed: 0 },
    ])
    await expect(searchSymbols('App', '/workspace')).rejects.toThrow('PiUI symbol search is not supported yet')
  })
})
