import { LOCAL_SERVER_ID, serverStore } from '../store/serverStore'

const DEFAULT_BASE = 'http://127.0.0.1:8787'
const rawFetch = globalThis.fetch.bind(globalThis)

/**
 * HTTP transport base for the PiUI server.
 * Browser dev uses same-origin + Vite proxy (`/api` → :8787) to avoid CORS.
 * Override with VITE_PIUI_API when needed.
 */
export function getApiBase(): string {
  const envBase = (import.meta as ImportMeta & { env?: { VITE_PIUI_API?: string } }).env?.VITE_PIUI_API
  if (envBase) return envBase.replace(/\/$/, '')
  if (typeof window !== 'undefined') {
    const active = serverStore.getActiveServer()
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

export function piFetch(input: string, init?: RequestInit): Promise<Response> {
  return rawFetch(input, { ...init, headers: piHeaders(init?.headers) })
}

export async function isPiServerUp(): Promise<boolean> {
  try {
    const res = await piFetch(`${getApiBase()}/api/v1/host/health`, { signal: AbortSignal.timeout(1500) })
    if (!res.ok) return false
    const body = (await res.json()) as { service?: string; protocolVersion?: number }
    return body.service === 'piui-server' && body.protocolVersion === 1
  } catch {
    return false
  }
}
