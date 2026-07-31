// ============================================
// PiUI API barrel and project adapter
// ============================================

import type { ApiProject } from './types'
import { getHostGitInfo } from '../pi/transport/index.js'
import { resolveWorkspacePath } from '../pi/workspaces'

// Re-export all types
export * from './types'

// Re-export from Attachment feature
export { fromFilePart, fromAgentPart } from '../features/attachment'

// Re-export from sub-modules
export * from './permission'
export * from './file'
export * from './events'
export * from './config'
export * from './vcs'
export * from './mcp'
export * from './pty'
export * from './worktree'
export * from './global'

// ============================================
// Project API Functions
// ============================================

/**
 * 获取当前项目
 */
export async function getCurrentProject(directory?: string): Promise<ApiProject> {
  const workspacePath = await resolveWorkspacePath(directory)
  if (!workspacePath) throw new Error('No PiUI workspace is available')
  const git = await getHostGitInfo(workspacePath).catch(() => null)
  const worktree = workspacePath
  const name = worktree.replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop() || worktree
  return {
    id: workspacePath,
    worktree,
    name,
    vcs: git?.root ? 'git' : undefined,
  }
}

/**
 * 获取项目列表
 */
export async function getProjects(directory?: string): Promise<ApiProject[]> {
  return directory ? [await getCurrentProject(directory)] : []
}
