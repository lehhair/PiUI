import type {
  FileNodeDto,
  FileReadResponse,
  GitFileStatus,
  GitStatusItem,
  WorkspaceTextSearchMatch,
} from '@piui/protocol'
import {
  createHostFileEntry,
  deleteHostFileEntry,
  getHostGitStatus,
  listHostFiles,
  moveHostFileEntry,
  readHostFile,
  searchHostFilesByName,
  searchHostFilesText,
  writeHostFile,
} from './transport/index.js'
import { serverStore } from '../store/serverStore'
import { resolveWorkspacePath } from './workspaces'

/**
 * Workspace file client over native host commands (files and git).
 * Returns protocol types directly — no view-model mapping.
 */

const ROOT_DIRECTORY_CACHE_TTL_MS = 1500
const rootDirectoryCache = new Map<string, { data: FileNodeDto[]; expiresAt: number }>()
const rootDirectoryInflight = new Map<string, Promise<FileNodeDto[]>>()
const rootDirectoryGeneration = new Map<string, number>()

function getRootDirectoryCacheKey(directory?: string): string {
  return `${serverStore.getActiveServerId()}:${directory?.replace(/\\/g, '/').replace(/\/+$/, '') ?? ''}`
}

async function requireWorkspacePath(directory?: string): Promise<string> {
  const workspacePath = await resolveWorkspacePath(directory)
  if (!workspacePath) throw new Error('No PiUI workspace is available')
  return workspacePath
}

/** Join a workspace-relative entry path to the workspace root for display. */
export function toAbsoluteEntryPath(workspaceDir: string | undefined, entryPath: string): string {
  const entry = entryPath.replace(/\\/g, '/')
  if (/^[a-zA-Z]:\//.test(entry) || entry.startsWith('/')) return entry
  if (!workspaceDir || (!/^[a-zA-Z]:[\\/]/.test(workspaceDir) && !workspaceDir.startsWith('/'))) return entry
  const root = workspaceDir.replace(/\\/g, '/').replace(/\/+$/, '')
  return `${root || '/'}${root ? '/' : ''}${entry.replace(/^\/+/, '')}`
}

function isRootDirectoryPath(path: string): boolean {
  return !path || path === '.' || path === '/'
}

/** Normalize explorer path to workspace-relative for the file commands. */
function toPiRelativePath(path: string, directory?: string): string {
  if (!path || isRootDirectoryPath(path)) return ''
  const p = path.replace(/\\/g, '/')
  if (p === 'piui' || p.startsWith('piui/')) return ''

  const root = directory?.replace(/\\/g, '/').replace(/\/+$/, '')
  if (root && (/^[a-zA-Z]:/.test(root) || root.startsWith('/'))) {
    const caseInsensitive = /^[a-zA-Z]:/.test(root) || root.startsWith('//')
    const lp = caseInsensitive ? p.toLowerCase() : p
    const lr = caseInsensitive ? root.toLowerCase() : root
    if (lp === lr || lp === `${lr}/`) return ''
    if (lp.startsWith(`${lr}/`)) return p.slice(root.length + 1)
    if (/^[a-zA-Z]:/.test(p) || p.startsWith('/')) return ''
  }

  if (/^[a-zA-Z]:/.test(p) || (p.startsWith('/') && p.length > 1 && !directory)) return ''
  return p.replace(/^\//, '')
}

async function fetchDirectory(path: string, directory?: string): Promise<FileNodeDto[]> {
  const workspaceDir =
    directory && (/^[a-zA-Z]:/.test(directory) || directory.startsWith('/'))
      ? directory
      : path && (/^[a-zA-Z]:/.test(path) || path.startsWith('/'))
        ? path
        : directory
  const isAbsolute = Boolean(workspaceDir && (/^[a-zA-Z]:[\\/]/.test(workspaceDir) || workspaceDir.startsWith('/')))
  // Browsing a directory must not register it as a watched workspace:
  // requireWorkspacePath -> resolveWorkspacePath fires workspaces.open (spawns a
  // Pi worker prewarm) and workspaces.watch (recursive chokidar watcher). On a
  // huge tree such as E:\dev (tens of thousands of subdirectories) the recursive
  // watcher grinds the server to a halt. files.list auto-registers the workspace
  // record server-side (workspace() find/resolve) without watching or prewarming;
  // the workspace is properly opened + watched only when the user actually picks
  // the directory and the app switches to it.
  const workspacePath = isAbsolute && workspaceDir ? workspaceDir : await requireWorkspacePath(workspaceDir)
  const rel = toPiRelativePath(path, workspaceDir)
  const entries: FileNodeDto[] = []
  let cursor: string | undefined
  do {
    const page = await listHostFiles(workspacePath, { path: rel, limit: 2000, cursor })
    entries.push(...page.entries)
    cursor = page.nextCursor
  } while (cursor && entries.length < 20_000)
  return entries.filter(e => !e.restricted)
}

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
  const result = await searchHostFilesByName(workspacePath, query, {
    type: options.type,
    limit: options.limit,
  }, options.signal)
  return result.paths
}

export async function listDirectory(path: string, directory?: string): Promise<FileNodeDto[]> {
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

export async function getFileContent(path: string, directory?: string): Promise<FileReadResponse> {
  const workspacePath = await requireWorkspacePath(directory)
  const rel = toPiRelativePath(path, directory)
  return readHostFile(workspacePath, rel)
}

export async function saveFile(path: string, content: Pick<FileReadResponse, 'content'> & Partial<FileReadResponse>, directory?: string): Promise<FileReadResponse> {
  const workspacePath = await requireWorkspacePath(directory)
  const relative = toPiRelativePath(path, directory)
  const saved = await writeHostFile(
    workspacePath,
    relative,
    content.content,
    { ifMatch: content.etag, encoding: content.encoding === 'base64' ? 'base64' : 'utf-8' },
  )
  invalidateWorkspaceFileCaches(directory)
  return saved
}

export async function createFile(path: string, directory?: string, content = ''): Promise<void> {
  const workspacePath = await requireWorkspacePath(directory)
  await createHostFileEntry(workspacePath, { path: toPiRelativePath(path, directory), type: 'file', content })
  invalidateWorkspaceFileCaches(directory)
}

export async function createDirectory(path: string, directory?: string): Promise<void> {
  const workspacePath = await requireWorkspacePath(directory)
  await createHostFileEntry(workspacePath, { path: toPiRelativePath(path, directory), type: 'directory' })
  invalidateWorkspaceFileCaches(directory)
}

export async function moveEntry(from: string, to: string, directory?: string): Promise<void> {
  const workspacePath = await requireWorkspacePath(directory)
  await moveHostFileEntry(workspacePath, {
    from: toPiRelativePath(from, directory),
    to: toPiRelativePath(to, directory),
  })
  invalidateWorkspaceFileCaches(directory)
}

export async function deleteEntry(path: string, directory?: string, recursive = false): Promise<void> {
  const workspacePath = await requireWorkspacePath(directory)
  await deleteHostFileEntry(workspacePath, toPiRelativePath(path, directory), recursive)
  invalidateWorkspaceFileCaches(directory)
}

export async function getFileStatus(directory?: string): Promise<GitStatusItem[]> {
  const workspacePath = await requireWorkspacePath(directory)
  const status = await getHostGitStatus(workspacePath)
  return status.items
}

export function simplifyGitStatus(status: GitFileStatus): 'added' | 'modified' | 'deleted' {
  if (status === 'added' || status === 'untracked' || status === 'copied') return 'added'
  if (status === 'deleted') return 'deleted'
  return 'modified'
}

export function invalidateWorkspaceFileCaches(directory?: string): void {
  const key = getRootDirectoryCacheKey(directory)
  rootDirectoryCache.delete(key)
  rootDirectoryInflight.delete(key)
  rootDirectoryGeneration.set(key, (rootDirectoryGeneration.get(key) ?? 0) + 1)
}

export function clearAllWorkspaceFileCaches(): void {
  const keys = new Set([...rootDirectoryCache.keys(), ...rootDirectoryInflight.keys(), ...rootDirectoryGeneration.keys()])
  for (const key of keys) {
    rootDirectoryGeneration.set(key, (rootDirectoryGeneration.get(key) ?? 0) + 1)
  }
  rootDirectoryCache.clear()
  rootDirectoryInflight.clear()
}

export async function searchText(pattern: string, directory?: string, signal?: AbortSignal): Promise<WorkspaceTextSearchMatch[]> {
  const workspacePath = await requireWorkspacePath(directory)
  return signal
    ? (await searchHostFilesText(workspacePath, pattern, 50, signal)).matches
    : (await searchHostFilesText(workspacePath, pattern)).matches
}

export async function searchDirectories(query: string, baseDirectory?: string, limit: number = 50): Promise<string[]> {
  return searchFiles(query, {
    directory: baseDirectory,
    type: 'directory',
    limit,
  })
}
