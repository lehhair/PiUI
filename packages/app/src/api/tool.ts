// ============================================
// Tool API - 工具管理
// ============================================

import { getSDKClient, unwrap } from './sdk'
import { formatPathForApi } from '../utils/directoryUtils'
import type { ToolIDs, ToolList } from '../types/api/tool'

/**
 * 获取工具 ID 列表
 */
export async function getToolIds(directory?: string): Promise<ToolIDs> {
  const sdk = getSDKClient()
  return unwrap(await sdk.tool.ids({ directory: formatPathForApi(directory) }))
}

/**
 * 获取工具列表（带详细信息）
 */
export async function getTools(provider: string, model: string, directory?: string): Promise<ToolList> {
  const sdk = getSDKClient()
  return unwrap(await sdk.tool.list({ provider, model, directory: formatPathForApi(directory) }))
}
