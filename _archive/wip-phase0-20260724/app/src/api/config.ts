// ============================================
// Config API - 配置管理
// ============================================

import { getSDKClient, unwrap } from './sdk'
import { formatPathForApi } from '../utils/directoryUtils'
import type { Config } from '../types/api/config'
import type { ProvidersResponse } from '../types/api/model'

/**
 * 获取当前配置
 */
export async function getConfig(directory?: string): Promise<Config> {
  const sdk = getSDKClient()
  return unwrap(await sdk.config.get({ directory: formatPathForApi(directory) }))
}

/**
 * 获取用户全局配置（官方桌面设置写入的配置源）
 */
export async function getGlobalConfig(): Promise<Config> {
  const sdk = getSDKClient()
  return unwrap(await sdk.global.config.get())
}

/**
 * 更新配置
 */
export async function updateConfig(config: Config, directory?: string): Promise<Config> {
  const sdk = getSDKClient()
  return unwrap(await sdk.config.update({ directory: formatPathForApi(directory), config }))
}

/**
 * 更新用户全局配置。
 * 官方接口是 deep merge patch：支持新增/修改，不支持删除任意字段。
 */
export async function updateGlobalConfig(config: Config): Promise<Config> {
  const sdk = getSDKClient()
  return unwrap(await sdk.global.config.update({ config }))
}

/**
 * 获取 provider 配置列表
 */
export async function getProviderConfigs(directory?: string): Promise<ProvidersResponse> {
  const sdk = getSDKClient()
  return unwrap(await sdk.config.providers({ directory: formatPathForApi(directory) }))
}
