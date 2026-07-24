// ============================================
// API Client for OpenCode Backend
// 基于 @opencode-ai/sdk: /config, /project, /provider 相关接口
// ============================================

import { getSDKClient, unwrap } from './sdk'
import { formatPathForApi } from '../utils/directoryUtils'
import type { ModelInfo, ApiProject, ApiPath } from './types'

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function requireRecord(value: unknown, message: string): Record<string, unknown> {
  if (isRecord(value)) return value
  throw new Error(message)
}

function requireArray<T = unknown>(value: unknown, message: string): T[] {
  if (Array.isArray(value)) return value as T[]
  throw new Error(message)
}

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
// 基于 SDK: config.providers()
// ============================================

export async function getActiveModels(directory?: string): Promise<ModelInfo[]> {
  const sdk = getSDKClient()
  const data = requireRecord(
    unwrap(await sdk.config.providers({ directory: formatPathForApi(directory) })),
    'Invalid OpenCode providers response',
  )
  const providers = requireArray<Record<string, unknown>>(data.providers, 'Invalid OpenCode providers response')
  const models: ModelInfo[] = []

  for (const provider of providers) {
    const providerModels = isRecord(provider.models) ? provider.models : {}
    for (const [, rawModel] of Object.entries(providerModels)) {
      if (!isRecord(rawModel)) continue
      const model = rawModel
      if (model.status === 'active') {
        const limit = isRecord(model.limit) ? model.limit : {}
        const capabilities = isRecord(model.capabilities) ? model.capabilities : {}
        const inputCapabilities = isRecord(capabilities.input) ? capabilities.input : {}
        const variants = isRecord(model.variants) ? Object.keys(model.variants) : []
        const modelId = typeof model.id === 'string' ? model.id : ''
        if (!modelId) continue

        models.push({
          id: modelId,
          name: typeof model.name === 'string' ? model.name : modelId,
          providerId: typeof provider.id === 'string' ? provider.id : '',
          providerName: typeof provider.name === 'string' ? provider.name : typeof provider.id === 'string' ? provider.id : '',
          family: typeof model.family === 'string' ? model.family : '',
          contextLimit: typeof limit.context === 'number' ? limit.context : 0,
          outputLimit: typeof limit.output === 'number' ? limit.output : 0,
          supportsReasoning: capabilities.reasoning === true,
          supportsImages: inputCapabilities.image === true,
          supportsPdf: inputCapabilities.pdf === true,
          supportsAudio: inputCapabilities.audio === true,
          supportsVideo: inputCapabilities.video === true,
          supportsToolcall: capabilities.toolcall === true,
          variants,
        })
      }
    }
  }

  return models
}

export async function getDefaultModels(directory?: string): Promise<Record<string, string>> {
  const sdk = getSDKClient()
  const data = requireRecord(
    unwrap(await sdk.config.providers({ directory: formatPathForApi(directory) })),
    'Invalid OpenCode providers response',
  )
  const defaults = requireRecord(data.default, 'Invalid OpenCode default model response')
  return Object.fromEntries(Object.entries(defaults).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
}

// ============================================
// Project API Functions
// 基于 SDK: project.*
// ============================================

/**
 * 获取当前项目
 */
export async function getCurrentProject(directory?: string): Promise<ApiProject> {
  const sdk = getSDKClient()
  return unwrap(await sdk.project.current({ directory: formatPathForApi(directory) }))
}

/**
 * 获取项目列表
 */
export async function getProjects(directory?: string): Promise<ApiProject[]> {
  const sdk = getSDKClient()
  return requireArray<ApiProject>(unwrap(await sdk.project.list({ directory: formatPathForApi(directory) })), 'Invalid OpenCode project list response')
}

/**
 * 初始化 Git 仓库
 */
export async function initGitProject(directory?: string): Promise<ApiProject> {
  const sdk = getSDKClient()
  return unwrap(await sdk.project.initGit({ directory: formatPathForApi(directory) }))
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
  const sdk = getSDKClient()
  return unwrap(
    await sdk.project.update({
      projectID: projectId,
      directory: formatPathForApi(directory),
      ...params,
    }),
  )
}

// ============================================
// Path API Functions
// ============================================

export async function getPath(): Promise<ApiPath> {
  const sdk = getSDKClient()
  return requireRecord(unwrap(await sdk.path.get()), 'Invalid OpenCode path response') as unknown as ApiPath
}
