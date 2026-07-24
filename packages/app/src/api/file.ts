// ============================================
// File Search API Functions
// Pi server first; OpenCode SDK only as fallback
// ============================================

import { getSDKClient, unwrap } from './sdk'
import { formatPathForApi } from '../utils/directoryUtils'
import type { FileNode, FileContent, FileStatusItem, SymbolInfo, TextSearchMatch } from './types'
import { serverStore } from '../store/serverStore'
import {
  isPiServerUp,
  listWorkspaceFiles,
  readWorkspaceFile,
  resolveWorkspaceId,
} from '../pi/sessionApi'

const ROOT_DIRECTORY_CACHE_TTL_MS = 10_000

const rootDirectoryCache = new Map<string, { data: FileNode[]; expiresAt: number }>()
const rootDirectoryInflight = new Map<string, Promise<FileNode[]>>()

function isRootDirectoryPath(path: string): boolean {
  return path === '' || path === '.' || path === './'
}

function getRootDirectoryCacheKey(directory?: string): string {
  return `${serverStore.getActiveServerId()}::${formatPathForApi(directory) ?? ''}`
}

function mapPiType(t: string): FileNode['type'] {
  if (t === 'directory') return 'directory'
  if (t === 'file' || t === 'symlink' || t === 'other') return 'file'
  return 'file'
}

/** Normalize explorer path to workspace-relative for Pi file API. */
function toPiRelativePath(path: string, directory?: string): string {
  if (!path || isRootDirectoryPath(path)) return ''
  let p = path.replace(/\\/g, '/')
  // virtual labels
  if (p === 'piui' || p.startsWith('piui/') || p.startsWith('piws:')) return ''

  const root = directory?.replace(/\\/g, '/').replace(/\/+$/, '')
  if (root && (/^[a-zA-Z]:/.test(root) || root.startsWith('/'))) {
    const lp = p.toLowerCase()
    const lr = root.toLowerCase()
    if (lp === lr || lp === `${lr}/`) return ''
    if (lp.startsWith(`${lr}/`)) return p.slice(root.length + 1)
    // absolute path that is not under workspace root → list root instead of 403
    if (/^[a-zA-Z]:/.test(p) || p.startsWith('/')) return ''
  }

  // bare absolute without directory
  if (/^[a-zA-Z]:/.test(p) || (p.startsWith('/') && p.length > 1 && !directory)) return ''
  return p.replace(/^\//, '')
}

async function fetchDirectoryPi(path: string, directory?: string): Promise<FileNode[] | null> {
  if (!(await isPiServerUp())) return null
  // Prefer absolute directory as workspace; fall back to current path if it is absolute
  const workspaceDir =
    directory && (/^[a-zA-Z]:/.test(directory) || directory.startsWith('/'))
      ? directory
      : path && (/^[a-zA-Z]:/.test(path) || path.startsWith('/'))
        ? path
        : directory
  const workspaceId = await resolveWorkspaceId(workspaceDir)
  if (!workspaceId) return null
  const rel = toPiRelativePath(path, workspaceDir)
  const listed = await listWorkspaceFiles(workspaceId, rel)
  return listed.entries
    .filter(e => !e.restricted)
    .map(e => ({
      name: e.name,
      path: e.path,
      absolute: e.path,
      type: mapPiType(e.type),
      ignored: false,
    })) as FileNode[]
}

async function fetchDirectory(path: string, directory?: string): Promise<FileNode[]> {
  const pi = await fetchDirectoryPi(path, directory)
  if (pi) return pi

  const sdk = getSDKClient()
  const isAbsolute = /^[a-zA-Z]:/.test(path) || path.startsWith('/')

  if (isAbsolute && !directory) {
    return unwrap(await sdk.file.list({ directory: formatPathForApi(path), path: '' }))
  }

  return unwrap(await sdk.file.list({ path, directory: formatPathForApi(directory) }))
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
  } = {},
): Promise<string[]> {
  if (await isPiServerUp()) {
    const workspaceId = await resolveWorkspaceId(options.directory)
    if (!workspaceId) return []
    try {
      const { searchWorkspaceFiles } = await import('../pi/sessionApi')
      return await searchWorkspaceFiles(workspaceId, query, {
        type: options.type,
        limit: options.limit,
      })
    } catch {
      return []
    }
  }
  const sdk = getSDKClient()
  return unwrap(
    await sdk.find.files({
      query,
      directory: formatPathForApi(options.directory),
      type: options.type,
      limit: options.limit,
    }),
  ) as string[]
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

  const request = fetchDirectory(path === '' ? '.' : path, directory)
    .then(data => {
      rootDirectoryCache.set(key, { data, expiresAt: Date.now() + ROOT_DIRECTORY_CACHE_TTL_MS })
      return data
    })
    .finally(() => {
      rootDirectoryInflight.delete(key)
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
  if (await isPiServerUp()) {
    const workspaceId = await resolveWorkspaceId(directory)
    if (workspaceId) {
      const rel = toPiRelativePath(path, directory)
      const file = await readWorkspaceFile(workspaceId, rel)
      return {
        type: 'text',
        content: file.content,
        encoding: file.encoding,
      } as FileContent
    }
  }
  const sdk = getSDKClient()
  return unwrap(await sdk.file.read({ path, directory: formatPathForApi(directory) }))
}

/**
 * 获取文件 git 状态
 */
export async function getFileStatus(directory?: string): Promise<FileStatusItem[]> {
  if (await isPiServerUp()) {
    const workspaceId = await resolveWorkspaceId(directory)
    if (!workspaceId) return []
    try {
      const { getWorkspaceGitStatus } = await import('../pi/sessionApi')
      const st = await getWorkspaceGitStatus(workspaceId)
      return st.items.map(item => ({
        path: item.path,
        status: item.status,
        added: item.added ?? 0,
        removed: item.removed ?? 0,
      })) as FileStatusItem[]
    } catch {
      return []
    }
  }
  const sdk = getSDKClient()
  return unwrap(await sdk.file.status({ directory: formatPathForApi(directory) }))
}

/**
 * 搜索代码符号
 */
export async function searchSymbols(query: string, directory?: string): Promise<SymbolInfo[]> {
  const sdk = getSDKClient()
  return unwrap(await sdk.find.symbols({ query, directory: formatPathForApi(directory) }))
}

/**
 * 搜索文件正文内容
 */
export async function searchText(pattern: string, directory?: string): Promise<TextSearchMatch[]> {
  const sdk = getSDKClient()
  return unwrap(await sdk.find.text({ pattern, directory: formatPathForApi(directory) }))
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
