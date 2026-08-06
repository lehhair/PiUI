import { postHostCommand } from './transport/index.js'
import { trackPiWorkspace } from './piSessionIndex'
import { serverStore } from '../store/serverStore'

/**
 * Host workspace commands (workspaces.*). A workspace is just a directory
 * the server remembers; the canonical path is its identity.
 */
export interface HostWorkspace {
  path: string
  displayName?: string
  createdAt?: string
  lastOpenedAt?: string
}

export async function listHostWorkspaces(signal?: AbortSignal): Promise<HostWorkspace[]> {
  const data = await postHostCommand<{ workspaces: HostWorkspace[] }>('workspaces.list', undefined, signal)
  return data.workspaces
}

export async function openHostWorkspace(rootPath?: string, displayName?: string, signal?: AbortSignal): Promise<HostWorkspace> {
  const params: { rootPath?: string; displayName?: string } = {}
  if (rootPath) params.rootPath = rootPath
  if (displayName) params.displayName = displayName
  const data = await postHostCommand<{ workspace: HostWorkspace }>(
    'workspaces.open',
    params,
    signal,
  )
  trackPiWorkspace(data.workspace.path)
  return data.workspace
}

export async function watchHostWorkspace(workspacePath: string, signal?: AbortSignal): Promise<void> {
  await postHostCommand<{ ok: boolean }>('workspaces.watch', { workspacePath }, signal)
}

const workspaceResolutionPromises = new Map<string, Promise<string | null>>()
let defaultWorkspacePromise: Promise<string | null> | null = null

async function ensureDefaultWorkspacePath(): Promise<string | null> {
  if (!defaultWorkspacePromise) {
    defaultWorkspacePromise = (async () => {
      try {
        const first = (await listHostWorkspaces())[0]
        if (first) return first.path
        const fallback = await openHostWorkspace()
        await watchHostWorkspace(fallback.path)
        return fallback.path
      } catch {
        return null
      }
    })()
  }
  try {
    return await defaultWorkspacePromise
  } finally {
    defaultWorkspacePromise = null
  }
}

/**
 * Return the workspace path for a directory (opening it on demand), or the
 * server's first known workspace when no directory is selected.
 */
export async function resolveWorkspacePath(directory?: string): Promise<string | null> {
  if (directory && (/^[a-zA-Z]:[\\/]/.test(directory) || directory.startsWith('/'))) {
    const normalized = directory.replace(/\\/g, '/').replace(/\/+$/, '')
    const key = `${serverStore.getActiveServerId()}:${serverStore.getActiveServerGeneration()}:${normalized}`
    let pending = workspaceResolutionPromises.get(key)
    if (!pending) {
      pending = openHostWorkspace(directory)
        .then(async workspace => {
          await watchHostWorkspace(workspace.path)
          return workspace.path
        })
        .catch(error => {
          workspaceResolutionPromises.delete(key)
          // Saved directory no longer exists on disk — treat as absent
          if (error && typeof error === 'object' && 'code' in error && error.code === 'WORKSPACE_NOT_FOUND') {
            return null
          }
          throw error
        })
      workspaceResolutionPromises.set(key, pending)
    }
    return pending
  }
  return ensureDefaultWorkspacePath()
}

export function resetWorkspaceResolutionCache(): void {
  workspaceResolutionPromises.clear()
  defaultWorkspacePromise = null
}
