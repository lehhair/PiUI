import { postHostCommand } from './transport/index.js'
import { trackPiWorkspace } from './piSessionIndex'

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

export async function openHostWorkspace(rootPath: string, displayName?: string, signal?: AbortSignal): Promise<HostWorkspace> {
  const data = await postHostCommand<{ workspace: HostWorkspace }>(
    'workspaces.open',
    displayName ? { rootPath, displayName } : { rootPath },
    signal,
  )
  trackPiWorkspace(data.workspace.path)
  return data.workspace
}

const workspaceResolutionPromises = new Map<string, Promise<string>>()
let defaultWorkspacePromise: Promise<string | null> | null = null

async function ensureDefaultWorkspacePath(): Promise<string | null> {
  if (!defaultWorkspacePromise) {
    defaultWorkspacePromise = (async () => {
      try {
        const first = (await listHostWorkspaces())[0]
        return first?.path ?? null
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
    const key = directory.replace(/\\/g, '/').replace(/\/+$/, '')
    let pending = workspaceResolutionPromises.get(key)
    if (!pending) {
      pending = openHostWorkspace(directory)
        .then(workspace => workspace.path)
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
