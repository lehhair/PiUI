// ============================================
// File Search API Functions
// Pi-native workspace file APIs
// ============================================

import type { FileNode, FileContent, FileStatusItem, SymbolInfo, TextSearchMatch } from './types'
import {
  createWorkspaceEntry,
  deleteWorkspaceEntry,
  listWorkspaceFiles,
  readWorkspaceFile,
  moveWorkspaceEntry,
  searchWorkspaceFiles,
  searchWorkspaceText,
  writeWorkspaceFile,
} from '../pi/sessionApi'
import { getHostGitStatus } from '../pi/transport/index.js'
import { resolveWorkspacePath } from '../pi/workspaces'

const ROOT_DIRECTORY_CACHE_TTL_MS = 10_000

const rootDirectoryCache = new Map<string, { data: FileNode[]; expiresAt: number }>()
const rootDirectoryInflight = new Map<string, Promise<FileNode[]>>()
const rootDirectoryGeneration = new Map<string, number>()

function isRootDirectoryPath(path: string): boolean {
  return path === '' || path === '.' || path === './'
}

function getRootDirectoryCacheKey(directory?: string): string {
  return directory?.replace(/\\/g, '/').replace(/\/+$/, '') ?? ''
}

async function requireWorkspacePath(directory?: string): Promise<string> {
  const workspacePath = await resolveWorkspacePath(directory)
  if (!workspacePath) throw new Error('No PiUI workspace is available')
  return workspacePath
}

function mapPiType(t: string): FileNode['type'] {
  if (t === 'directory') return 'directory'
  if (t === 'file' || t === 'symlink' || t === 'other') return 'file'
  return 'file'
}

function toAbsoluteEntryPath(workspaceDir: string | undefined, entryPath: string): string {
  const entry = entryPath.replace(/\\/g, '/')
  if (/^[a-zA-Z]:\//.test(entry) || entry.startsWith('/')) return entry
  if (!workspaceDir || (!/^[a-zA-Z]:[\\/]/.test(workspaceDir) && !workspaceDir.startsWith('/'))) return entry
  const root = workspaceDir.replace(/\\/g, '/').replace(/\/+$/, '')
  return `${root || '/'}${root ? '/' : ''}${entry.replace(/^\/+/, '')}`
}

/** Normalize explorer path to workspace-relative for Pi file API. */
function toPiRelativePath(path: string, directory?: string): string {
  if (!path || isRootDirectoryPath(path)) return ''
  const p = path.replace(/\\/g, '/')
  // virtual labels
  if (p === 'piui' || p.startsWith('piui/')) return ''

  const root = directory?.replace(/\\/g, '/').replace(/\/+$/, '')
  if (root && (/^[a-zA-Z]:/.test(root) || root.startsWith('/'))) {
    const caseInsensitive = /^[a-zA-Z]:/.test(root) || root.startsWith('//')
    const lp = caseInsensitive ? p.toLowerCase() : p
    const lr = caseInsensitive ? root.toLowerCase() : root
    if (lp === lr || lp === `${lr}/`) return ''
    if (lp.startsWith(`${lr}/`)) return p.slice(root.length + 1)
    // absolute path that is not under workspace root → list root instead of 403
    if (/^[a-zA-Z]:/.test(p) || p.startsWith('/')) return ''
  }

  // bare absolute without directory
  if (/^[a-zA-Z]:/.test(p) || (p.startsWith('/') && p.length > 1 && !directory)) return ''
  return p.replace(/^\//, '')
}

async function fetchDirectory(path: string, directory?: string): Promise<FileNode[]> {
  // Prefer absolute directory as workspace; fall back to current path if it is absolute
  const workspaceDir =
    directory && (/^[a-zA-Z]:/.test(directory) || directory.startsWith('/'))
      ? directory
      : path && (/^[a-zA-Z]:/.test(path) || path.startsWith('/'))
        ? path
        : directory
  const workspacePath = await requireWorkspacePath(workspaceDir)
  const rel = toPiRelativePath(path, workspaceDir)
  const listed = await listWorkspaceFiles(workspacePath, rel)
  return listed.entries
    .filter(e => !e.restricted)
    .map(e => ({
      name: e.name,
      path: e.path,
      absolute: toAbsoluteEntryPath(workspaceDir, e.path),
      type: mapPiType(e.type),
      ignored: false,
    })) as FileNode[]
}

/**
 * 搜索文件或目录
 */
export async function searchFiles(
  query: string,
  options: {
    directory?: string
    type?: 'file' | 'directory'
    limit?: number
    signal?: AbortSignal
  } = {},
): Promise<string[]> {
  const workspacePath = await requireWorkspacePath(options.directory)
  return searchWorkspaceFiles(workspacePath, query, {
    type: options.type,
    limit: options.limit,
    ...(options.signal ? { signal: options.signal } : {}),
  })
}

/**
 * 列出目录内容
 */
export async function listDirectory(path: string, directory?: string): Promise<FileNode[]> {
  if (!isRootDirectoryPath(path)) {
    return fetchDirectory(path, directory)
  }

  const key = getRootDirectoryCacheKey(directory)
  const now = Date.now()
  const cached = rootDirectoryCache.get(key)
  if (cached && cached.expiresAt > now) {
    return cached.data
  }

  const inflight = rootDirectoryInflight.get(key)
  if (inflight) {
    return inflight
  }

  const generation = rootDirectoryGeneration.get(key) ?? 0
  const request = fetchDirectory(path === '' ? '.' : path, directory)
    .then(data => {
      if ((rootDirectoryGeneration.get(key) ?? 0) === generation) {
        rootDirectoryCache.set(key, { data, expiresAt: Date.now() + ROOT_DIRECTORY_CACHE_TTL_MS })
      }
      return data
    })
    .finally(() => {
      if (rootDirectoryInflight.get(key) === request) rootDirectoryInflight.delete(key)
    })

  rootDirectoryInflight.set(key, request)
  return request
}

export async function prefetchRootDirectory(directory?: string): Promise<void> {
  await listDirectory('.', directory)
}

/**
 * 读取文件内容
 */
export async function getFileContent(path: string, directory?: string): Promise<FileContent> {
  const workspacePath = await requireWorkspacePath(directory)
  const rel = toPiRelativePath(path, directory)
  const file = await readWorkspaceFile(workspacePath, rel)
  const result: FileContent = {
    type: file.type ?? (file.encoding === 'base64' ? 'binary' : 'text'),
    content: file.content,
    encoding: file.encoding,
  }
  if (file.mimeType !== undefined) result.mimeType = file.mimeType
  if (file.etag !== undefined) result.etag = file.etag
  if (file.size !== undefined) result.size = file.size
  return result
}

export async function saveFile(path: string, content: FileContent, directory?: string): Promise<FileContent> {
  const workspacePath = await requireWorkspacePath(directory)
  const relative = toPiRelativePath(path, directory)
  const saved = await writeWorkspaceFile(
    workspacePath,
    relative,
    content.content,
    content.etag,
    content.encoding === 'base64' ? 'base64' : 'utf-8',
  )
  invalidateWorkspaceFileCaches(directory)
  return {
    type: saved.type,
    content: saved.content,
    encoding: saved.encoding,
    mimeType: saved.mimeType,
    etag: saved.etag,
    size: saved.size,
  }
}

export async function createFile(path: string, directory?: string, content = ''): Promise<void> {
  const workspacePath = await requireWorkspacePath(directory)
  await createWorkspaceEntry(workspacePath, { path: toPiRelativePath(path, directory), type: 'file', content })
  invalidateWorkspaceFileCaches(directory)
}

export async function createDirectory(path: string, directory?: string): Promise<void> {
  const workspacePath = await requireWorkspacePath(directory)
  await createWorkspaceEntry(workspacePath, { path: toPiRelativePath(path, directory), type: 'directory' })
  invalidateWorkspaceFileCaches(directory)
}

export async function moveEntry(from: string, to: string, directory?: string): Promise<void> {
  const workspacePath = await requireWorkspacePath(directory)
  await moveWorkspaceEntry(workspacePath, {
    from: toPiRelativePath(from, directory),
    to: toPiRelativePath(to, directory),
  })
  invalidateWorkspaceFileCaches(directory)
}

export async function deleteEntry(path: string, directory?: string, recursive = false): Promise<void> {
  const workspacePath = await requireWorkspacePath(directory)
  await deleteWorkspaceEntry(workspacePath, toPiRelativePath(path, directory), recursive)
  invalidateWorkspaceFileCaches(directory)
}

/**
 * 获取文件 git 状态
 */
export async function getFileStatus(directory?: string): Promise<FileStatusItem[]> {
  const workspacePath = await requireWorkspacePath(directory)
  const status = await getHostGitStatus(workspacePath)
  return status.items.map(item => ({
    path: item.path,
    status: item.status === 'added' || item.status === 'untracked' || item.status === 'copied'
      ? 'added'
      : item.status === 'deleted'
        ? 'deleted'
        : 'modified',
    added: 0,
    removed: 0,
  }))
}

export function invalidateWorkspaceFileCaches(directory?: string): void {
  const key = getRootDirectoryCacheKey(directory)
  rootDirectoryCache.delete(key)
  rootDirectoryInflight.delete(key)
  rootDirectoryGeneration.set(key, (rootDirectoryGeneration.get(key) ?? 0) + 1)
}

/**
 * 搜索代码符号
 */
export async function searchSymbols(query: string, directory?: string): Promise<SymbolInfo[]> {
  void query
  void directory
  throw new Error('PiUI symbol search is not supported yet')
}

/**
 * 搜索文件正文内容
 */
export async function searchText(pattern: string, directory?: string, signal?: AbortSignal): Promise<TextSearchMatch[]> {
  const workspacePath = await requireWorkspacePath(directory)
  return signal
    ? searchWorkspaceText(workspacePath, pattern, 50, signal)
    : searchWorkspaceText(workspacePath, pattern)
}

/**
 * 搜索目录（便捷方法）
 */
export async function searchDirectories(query: string, baseDirectory?: string, limit: number = 50): Promise<string[]> {
  return searchFiles(query, {
    directory: baseDirectory,
    type: 'directory',
    limit,
  })
}
