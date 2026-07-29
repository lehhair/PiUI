import type { HealthResponse, HostRegistrySnapshot, JsonObject, JsonValue, PiRegistrySnapshot } from '@piui/protocol'
import { getApiBase, piFetch } from './sessionApi'

export type PiNativeSessionInfo = {
  id: string
  path: string
  cwd: string
  name?: string
  created: string
  modified: string
  firstMessage: string
  allMessagesText: string
  messageCount: number
  parentSessionPath?: string
  [key: string]: JsonValue | undefined
}

export type PiSessionOpenResult = {
  sessionId: string
  sessionFile?: string | null
  cwd?: string
  state?: JsonValue
  [key: string]: JsonValue | undefined
}

export type PiCommandResponse<T = JsonValue | undefined> = {
  data: T extends undefined ? null : T
}

export async function fetchHostHealth(signal?: AbortSignal): Promise<HealthResponse> {
  return readJson<HealthResponse>(`${getApiBase()}/api/v1/host/health`, { signal })
}

export async function fetchHostRegistry(signal?: AbortSignal): Promise<HostRegistrySnapshot> {
  return readJson<HostRegistrySnapshot>(`${getApiBase()}/api/v1/host/registry`, { signal })
}

export async function fetchPiRegistry(signal?: AbortSignal): Promise<PiRegistrySnapshot> {
  return readJson<PiRegistrySnapshot>(`${getApiBase()}/api/v1/pi/registry`, { signal })
}

export async function postPiGlobalCommand<T = JsonValue | undefined>(
  name: string,
  params?: JsonObject,
  signal?: AbortSignal,
): Promise<T extends undefined ? null : T> {
  const body = params ? JSON.stringify(params) : '{}'
  const response = await readJson<PiCommandResponse<T>>(`${getApiBase()}/api/v1/pi/commands/${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
    signal,
  })
  return response.data
}

export function listPiNativeSessions(signal?: AbortSignal): Promise<PiNativeSessionInfo[]> {
  return postPiGlobalCommand<PiNativeSessionInfo[]>('session.listAll', undefined, signal)
}

export function listPiNativeSessionsForCwd(cwd: string, signal?: AbortSignal): Promise<PiNativeSessionInfo[]> {
  return postPiGlobalCommand<PiNativeSessionInfo[]>('session.list', { cwd }, signal)
}

export function openPiNativeSession(cwd: string, sessionFile?: string, signal?: AbortSignal): Promise<PiSessionOpenResult> {
  return postPiGlobalCommand<PiSessionOpenResult>(
    'session.open',
    sessionFile ? { cwd, sessionFile } : { cwd },
    signal,
  )
}

async function readJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await piFetch(url, init)
  if (!response.ok) {
    const message = await response.text().catch(() => '')
    let code: string | undefined
    try {
      const body = JSON.parse(message) as { code?: unknown }
      if (typeof body.code === 'string') code = body.code
    } catch {
      // Keep non-JSON error detail in the message.
    }
    throw Object.assign(new Error(`${url} ${response.status}${message ? ` ${message}` : ''}`), {
      status: response.status,
      code,
    })
  }
  return await response.json() as T
}
