// ============================================
// LSP API - Language Server Protocol 状态
// ============================================

import type { FormatterStatus as SDKFormatterStatus, LspStatus as SDKLspStatus } from '@opencode-ai/sdk/v2/client'
import { getSDKClient, unwrap } from './sdk'
import { formatPathForApi } from '../utils/directoryUtils'

export interface LSPStatus {
  running: boolean
  language?: string
  capabilities?: string[]
}

/**
 * 获取 LSP 服务状态
 */
export async function getLspStatus(directory?: string): Promise<LSPStatus> {
  const sdk = getSDKClient()
  const result = unwrap<SDKLspStatus[]>(await sdk.lsp.status({ directory: formatPathForApi(directory) }))
  // SDK 返回 LspStatus[]（id/name/root/status），转换为 UI 层期望的格式
  if (Array.isArray(result) && result.length > 0) {
    const first = result[0]
    return {
      running: first.status === 'connected',
      language: first.name,
    }
  }
  return { running: false }
}

export interface FormatterStatus {
  available: boolean
  name?: string
}

/**
 * 获取格式化器状态
 */
export async function getFormatterStatus(directory?: string): Promise<FormatterStatus> {
  const sdk = getSDKClient()
  const result = unwrap<SDKFormatterStatus[]>(await sdk.formatter.status({ directory: formatPathForApi(directory) }))
  // SDK 返回 FormatterStatus[]（name/extensions/enabled），转换为 UI 层期望的格式
  if (Array.isArray(result) && result.length > 0) {
    const first = result[0]
    return {
      available: first.enabled === true,
      name: first.name,
    }
  }
  return { available: false }
}
