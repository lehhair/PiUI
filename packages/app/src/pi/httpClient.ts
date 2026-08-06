import { LOCAL_SERVER_ID, serverStore } from '../store/serverStore'
import { getHttpFetch, isTauri } from '../utils/tauri'
import { PROTOCOL_VERSION } from '@piui/protocol'

const DEFAULT_BASE = 'http://127.0.0.1:8787'
const DEFAULT_REQUEST_TIMEOUT_MS = 20_000

// 请求代次 + 在途请求注册表：server 切换/重连时一锅端中止，旧 server 的响应
// 不可能回来污染新 server 的状态（参考 OpenCodeUI 的 sdk.ts generation 模式）。
let requestGeneration = 0
const inflightControllers = new Set<AbortController>()

export function abortInFlightPiRequests(): void {
  requestGeneration += 1
  for (const controller of inflightControllers) controller.abort()
  inflightControllers.clear()
}

// 连接级失败（connection refused / reset / dns）说明请求根本没送达 server，
// 此时重试对任何方法都安全；HTTP 层返回了状态码的错误绝不在这里重试。
const NETWORK_RETRY_DELAYS_MS = [300, 900]

function isNetworkLevelError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  if (error.name === 'AbortError' || error.name === 'TimeoutError') return false
  if (error instanceof TypeError) return true
  return /fetch failed|network|econnrefused|econnreset|enotfound|connection|error sending request/i.test(error.message)
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')
}

/**
 * HTTP transport base for the PiUI server.
 * Browser dev uses same-origin + Vite proxy (`/api` → :8787) to avoid CORS.
 * Tauri 壳的同源是 tauri://localhost，不是 API，必须始终用完整 URL。
 * Override with VITE_PIUI_API when needed.
 */
export function getApiBase(): string {
  const envBase = (import.meta as ImportMeta & { env?: { VITE_PIUI_API?: string } }).env?.VITE_PIUI_API
  if (envBase) return envBase.replace(/\/$/, '')
  if (typeof window !== 'undefined') {
    const active = serverStore.getActiveServer()
    if (isTauri()) {
      if (active?.url) return active.url.replace(/\/$/, '')
      return DEFAULT_BASE
    }
    if (active && active.id !== LOCAL_SERVER_ID) return active.url.replace(/\/$/, '')
    const storedLocal = serverStore.getStoredServers().find(server => server.id === LOCAL_SERVER_ID)
    if (active && storedLocal && active.url !== storedLocal.url) return active.url.replace(/\/$/, '')
    return ''
  }
  return DEFAULT_BASE
}

function piHeaders(init?: HeadersInit): Headers {
  const headers = new Headers(init)
  const activeToken = serverStore.getActiveToken()
  if (activeToken) {
    headers.set('authorization', `Bearer ${activeToken}`)
    return headers
  }
  const token = (import.meta as ImportMeta & { env?: { VITE_PIUI_TOKEN?: string } }).env?.VITE_PIUI_TOKEN
  if (token) headers.set('authorization', `Bearer ${token}`)
  return headers
}

export function getPiAuthToken(): string | undefined {
  const activeToken = serverStore.getActiveToken()
  if (activeToken) return activeToken
  return (import.meta as ImportMeta & { env?: { VITE_PIUI_TOKEN?: string } }).env?.VITE_PIUI_TOKEN
}

export async function piFetch(input: string, init?: RequestInit): Promise<Response> {
  const generation = requestGeneration
  const inflight = new AbortController()
  inflightControllers.add(inflight)
  try {
    const fetchImpl = await getHttpFetch()
    if (generation !== requestGeneration) {
      throw new DOMException('Stale PiUI request: server changed', 'AbortError')
    }
    const timeout = AbortSignal.timeout(DEFAULT_REQUEST_TIMEOUT_MS)
    const signals = [inflight.signal, timeout]
    if (init?.signal) signals.push(init.signal)
    const signal = AbortSignal.any(signals)
    const headers = piHeaders(init?.headers)

    let lastError: unknown
    for (let attempt = 0; attempt <= NETWORK_RETRY_DELAYS_MS.length; attempt++) {
      try {
        return await fetchImpl(input, { ...init, signal, headers })
      } catch (error) {
        if (signal.aborted || isAbortError(error) || !isNetworkLevelError(error)) throw error
        lastError = error
        const delay = NETWORK_RETRY_DELAYS_MS[attempt]
        if (delay === undefined) break
        await new Promise(resolve => setTimeout(resolve, delay))
      }
    }
    throw lastError
  } finally {
    inflightControllers.delete(inflight)
  }
}

export async function isPiServerUp(): Promise<boolean> {
  try {
    const res = await piFetch(`${getApiBase()}/api/v1/host/health`, { signal: AbortSignal.timeout(1500) })
    if (!res.ok) return false
    const body = (await res.json()) as { service?: string; protocolVersion?: number }
    return body.service === 'piui-server' && body.protocolVersion === PROTOCOL_VERSION
  } catch {
    return false
  }
}
