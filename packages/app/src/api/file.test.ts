import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createDirectory,
  createFile,
  deleteEntry,
  getFileContent,
  getFileStatus,
  listDirectory,
  moveEntry,
  saveFile,
  searchFiles,
  searchSymbols,
  searchText,
} from './file'

const mocks = vi.hoisted(() => ({
  resolveWorkspacePath: vi.fn(),
  listWorkspaceFiles: vi.fn(),
  readWorkspaceFile: vi.fn(),
  searchWorkspaceFiles: vi.fn(),
  searchWorkspaceText: vi.fn(),
  getHostGitStatus: vi.fn(),
  writeWorkspaceFile: vi.fn(),
  createWorkspaceEntry: vi.fn(),
  moveWorkspaceEntry: vi.fn(),
  deleteWorkspaceEntry: vi.fn(),
}))

vi.mock('../pi/workspaces', () => ({
  resolveWorkspacePath: mocks.resolveWorkspacePath,
}))
vi.mock('../pi/transport/index.js', () => ({
  listHostFiles: mocks.listWorkspaceFiles,
  readHostFile: mocks.readWorkspaceFile,
  searchHostFilesByName: mocks.searchWorkspaceFiles,
  searchHostFilesText: mocks.searchWorkspaceText,
  writeHostFile: mocks.writeWorkspaceFile,
  createHostFileEntry: mocks.createWorkspaceEntry,
  moveHostFileEntry: mocks.moveWorkspaceEntry,
  deleteHostFileEntry: mocks.deleteWorkspaceEntry,
  getHostGitStatus: mocks.getHostGitStatus,
}))

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
    expect(mocks.listWorkspaceFiles).toHaveBeenCalledWith('C:/workspace', { path: '', limit: 2000, cursor: undefined })
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
    expect(mocks.listWorkspaceFiles).toHaveBeenCalledWith('C:/workspace', { path: '', limit: 2000, cursor: undefined })
  })

  it('delegates filename and text searches without an SDK fallback', async () => {
    const textMatches = [{
      path: { text: 'src/app.ts' },
      lines: { text: 'const app = "PiUI"' },
      line_number: 1,
      absolute_offset: 0,
      submatches: [{ start: 13, end: 17, match: { text: 'PiUI' } }],
    }]
    mocks.searchWorkspaceFiles.mockResolvedValue({ paths: ['src/app.ts'] })
    mocks.searchWorkspaceText.mockResolvedValue({ matches: textMatches })

    await expect(searchFiles('app', { directory: '/workspace', type: 'file', limit: 20 })).resolves.toEqual([
      'src/app.ts',
    ])
    await expect(searchText('PiUI', '/workspace')).resolves.toEqual(textMatches)
    expect(mocks.searchWorkspaceFiles).toHaveBeenCalledWith('C:/workspace', 'app', { type: 'file', limit: 20 }, undefined)
    expect(mocks.searchWorkspaceText).toHaveBeenCalledWith('C:/workspace', 'PiUI')
  })

  it('maps Git status and reports unsupported symbol search explicitly', async () => {
    mocks.getHostGitStatus.mockResolvedValue({
      items: [{ path: 'src/app.ts', status: 'modified' }],
    })

    await expect(getFileStatus('/workspace')).resolves.toEqual([
      { path: 'src/app.ts', status: 'modified', added: 0, removed: 0 },
    ])
    await expect(searchSymbols('App', '/workspace')).rejects.toThrow('PiUI symbol search is not supported yet')
  })

  it('exposes save, create, move, and delete as usable workspace operations', async () => {
    mocks.writeWorkspaceFile.mockResolvedValue({
      type: 'text', content: 'saved', encoding: 'utf-8', mimeType: 'text/plain', etag: 'next', size: 5,
    })
    await expect(saveFile('src/a.txt', {
      type: 'text', content: 'saved', encoding: 'utf-8', etag: 'old',
    }, '/workspace')).resolves.toMatchObject({ content: 'saved', etag: 'next' })
    expect(mocks.writeWorkspaceFile).toHaveBeenCalledWith('C:/workspace', 'src/a.txt', 'saved', { ifMatch: 'old', encoding: 'utf-8' })

    await createFile('src/new.ts', '/workspace', 'export {}')
    await createDirectory('src/nested', '/workspace')
    await moveEntry('src/new.ts', 'src/nested/new.ts', '/workspace')
    await deleteEntry('src/nested', '/workspace', true)
    expect(mocks.createWorkspaceEntry).toHaveBeenNthCalledWith(1, 'C:/workspace', {
      path: 'src/new.ts', type: 'file', content: 'export {}',
    })
    expect(mocks.createWorkspaceEntry).toHaveBeenNthCalledWith(2, 'C:/workspace', {
      path: 'src/nested', type: 'directory',
    })
    expect(mocks.moveWorkspaceEntry).toHaveBeenCalledWith('C:/workspace', {
      from: 'src/new.ts', to: 'src/nested/new.ts',
    })
    expect(mocks.deleteWorkspaceEntry).toHaveBeenCalledWith('C:/workspace', 'src/nested', true)
  })
})
