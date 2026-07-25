// ============================================
// PiUI API barrel and project/model adapters
// ============================================

import type { ModelInfo, ApiProject, ApiPath } from './types'
import { getWorkspaceGitInfo, listPiModels, resolveWorkspaceId } from '../pi/sessionApi'

// Re-export all types
export * from './types'

// Re-export from Attachment feature
export { fromFilePart, fromAgentPart } from '../features/attachment'

// Re-export from sub-modules
export * from './session'
export * from './message'
export * from './permission'
export * from './file'
export * from './agent'
export * from './skill'
export * from './events'
export * from './config'
export * from './vcs'
export * from './mcp'
export * from './pty'
export * from './worktree'
export * from './command'
export * from './global'
export * from './tool'
export * from './lsp'

// ============================================
// Model API Functions
// ============================================

export async function getActiveModels(directory?: string): Promise<ModelInfo[]> {
  void directory
  const { models } = await listPiModels()
  return models.map(model => ({
    id: model.id,
    name: model.name,
    providerId: model.providerId,
    providerName: model.providerName,
    family: model.family,
    contextLimit: model.contextLimit,
    outputLimit: model.outputLimit,
    supportsReasoning: model.supportsReasoning,
    supportsImages: model.supportsImages,
    supportsPdf: model.supportsPdf,
    supportsAudio: model.supportsAudio,
    supportsVideo: model.supportsVideo,
    supportsToolcall: model.supportsToolcall,
    variants: model.variants,
  }))
}

export async function getDefaultModels(directory?: string): Promise<Record<string, string>> {
  void directory
  throw new Error('PiUI does not expose provider default models')
}

// ============================================
// Project API Functions
// ============================================

/**
 * 获取当前项目
 */
export async function getCurrentProject(directory?: string): Promise<ApiProject> {
  const workspaceId = await resolveWorkspaceId(directory)
  if (!workspaceId) throw new Error('No PiUI workspace is available')
  const git = await getWorkspaceGitInfo(workspaceId).catch(() => null)
  const worktree = directory ?? ''
  const name = worktree.replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop() || worktree
  return {
    id: workspaceId,
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

/**
 * 初始化 Git 仓库
 */
export async function initGitProject(directory?: string): Promise<ApiProject> {
  void directory
  throw new Error('PiUI does not support Git repository initialization yet')
}

/**
 * 更新项目
 */
export async function updateProject(
  projectId: string,
  params: {
    name?: string
    icon?: { url?: string; override?: string; color?: string }
  },
  directory?: string,
): Promise<ApiProject> {
  void projectId
  void params
  void directory
  throw new Error('PiUI does not support project metadata updates yet')
}

// ============================================
// Path API Functions
// ============================================

export async function getPath(): Promise<ApiPath> {
  throw new Error('PiUI does not expose host path metadata')
}
