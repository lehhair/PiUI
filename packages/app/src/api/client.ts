// ============================================
// PiUI API barrel and project adapter
// ============================================

import type { HostProject } from './types'
import { getHostGitInfo } from '../pi/transport/index.js'
import { resolveWorkspacePath } from '../pi/workspaces'

// Re-export all types
export * from './types'

// Re-export from Attachment feature
export { fromFilePart, fromAgentPart } from '../features/attachment'

// Re-export from sub-modules
export * from './events'

// ============================================
// Project API Functions
// ============================================

/**
 * 获取当前工作区（PiUI 原生形状：path/gitRoot，无 OCUI worktree 概念）
 */
export async function getCurrentProject(directory?: string): Promise<HostProject> {
  const workspacePath = await resolveWorkspacePath(directory)
  if (!workspacePath) throw new Error('No PiUI workspace is available')
  const git = await getHostGitInfo(workspacePath).catch(() => null)
  const path = workspacePath.replace(/\\/g, '/').replace(/\/+$/, '')
  const name = path.split('/').pop() || path
  return {
    id: workspacePath,
    path,
    name,
    gitRoot: git?.root ? path : undefined,
  }
}

/**
 * 获取项目列表
 */
export async function getProjects(directory?: string): Promise<HostProject[]> {
  return directory ? [await getCurrentProject(directory)] : []
}
