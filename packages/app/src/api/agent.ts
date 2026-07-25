// ============================================
// Agent API Functions
// Agent metadata facade pending a native PiUI endpoint.
// ============================================

import { getSDKClient, unwrap } from './sdk'
import { formatPathForApi } from '../utils/directoryUtils'
import type { ApiAgent } from './types'

/**
 * 获取 agent 列表
 */
export async function getAgents(directory?: string): Promise<ApiAgent[]> {
  const sdk = getSDKClient()
  return unwrap(await sdk.app.agents({ directory: formatPathForApi(directory) }))
}

/**
 * 获取可选择的 agent 列表（过滤掉 hidden 的）
 */
export async function getSelectableAgents(directory?: string): Promise<ApiAgent[]> {
  const agents = await getAgents(directory)
  return agents.filter(agent => !agent.hidden)
}
