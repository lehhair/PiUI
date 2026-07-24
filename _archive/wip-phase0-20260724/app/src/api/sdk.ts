// ============================================
// SDK Client — 已移除 @opencode-ai/sdk
// 通过 shim 的 createOpencodeClient（空 Proxy）
// 真正能力逐步改到 Pi Host（见 host/ws-host.ts）
// ============================================

import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk/v2/client"
import { serverStore, makeBasicAuthHeader } from "../store/serverStore"
import { isTauri } from "../utils/tauri"

let _apiRequestGeneration = 0
const _apiRequestControllers = new Set<AbortController>()

export function abortInFlightApiRequests(reason = "Server endpoint changed"): void {
  _apiRequestGeneration++
  for (const controller of _apiRequestControllers) {
    controller.abort(new DOMException(reason, "AbortError"))
  }
  _apiRequestControllers.clear()
}

let _cachedClient: OpencodeClient | null = null
let _cachedKey = ""

function buildCacheKey(): string {
  const baseUrl = serverStore.getActiveBaseUrl()
  const auth = serverStore.getActiveAuth()
  const authPart = auth?.password ? `${auth.username}:${auth.password}` : ""
  return `${baseUrl}|${authPart}`
}

function buildHeaders(): Record<string, string> {
  const headers: Record<string, string> = {}
  const auth = serverStore.getActiveAuth()
  if (auth?.password) {
    headers["Authorization"] = makeBasicAuthHeader(auth)
  }
  return headers
}

/**
 * 同步获取 client（现为 shim Proxy，不连 OpenCode）
 */
export function getSDKClient(): OpencodeClient {
  const key = buildCacheKey()
  if (_cachedClient && _cachedKey === key) return _cachedClient

  _cachedClient = createOpencodeClient({
    baseUrl: serverStore.getActiveBaseUrl(),
    headers: buildHeaders(),
    // fetch 不会被真正用到（Proxy 短路）
    fetch: globalThis.fetch.bind(globalThis),
  })
  _cachedKey = key
  return _cachedClient
}

export async function getSDKClientAsync(): Promise<OpencodeClient> {
  // 浏览器不需要 tauri fetch
  void isTauri
  _cachedClient = null
  _cachedKey = ""
  return getSDKClient()
}

export function invalidateSDKClient(): void {
  _cachedClient = null
  _cachedKey = ""
}

export function unwrap<T>(result: { data?: T; error?: unknown }): T {
  if (result.error != null) {
    const err = result.error
    if (err instanceof Error) throw err
    if (typeof err === "string") throw new Error(err)
    throw new Error(JSON.stringify(err))
  }
  return result.data as T
}
