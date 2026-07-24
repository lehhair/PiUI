// ============================================
// HTTP Utilities
// 仅保留给 SSE / PTY WebSocket 使用的 URL 与 auth 辅助函数
// ============================================

import { serverStore, makeBasicAuthHeader } from '../store/serverStore'

/**
 * 获取当前 API Base URL
 * 优先使用 serverStore 中的活动服务器，回退到常量
 */
export function getApiBaseUrl(): string {
  return serverStore.getActiveBaseUrl()
}

/**
 * 获取当前活动服务器的 Authorization header
 * 如果服务器配置了密码则返回 Basic Auth header，否则返回 undefined
 */
export function getAuthHeader(): Record<string, string> {
  const auth = serverStore.getActiveAuth()
  if (auth?.password) {
    return { Authorization: makeBasicAuthHeader(auth) }
  }
  return {}
}

type QueryValue = string | number | boolean | undefined

/**
 * 构建查询字符串
 * 值会进行 URL 编码以安全处理空格、特殊字符等
 * （Go 后端的 r.URL.Query().Get() 会自动解码）
 */
export function buildQueryString(params: Record<string, QueryValue>): string {
  const parts: string[] = []
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    }
  }
  return parts.length > 0 ? '?' + parts.join('&') : ''
}
