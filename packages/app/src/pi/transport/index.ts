import type {
  JsonObject,
  JsonValue,
  HealthResponse,
  PiRegistrySnapshot,
  HostRegistrySnapshot,
  CommandRecord,
} from '@piui/protocol'
import type { SessionEntry, SessionInfo } from '@earendil-works/pi-coding-agent'
import type { PiBranchPage } from '../domain/index.js'
import { getApiBase, piFetch } from '../sessionApi.js'

// Response types
export type PiCommandResponse<T = JsonValue | undefined> = {
  data: T extends undefined ? null : T
}

export type PiSessionOpenResult = {
  sessionId: string
  sessionFile?: string | null
  cwd?: string
  state?: JsonValue
  [key: string]: JsonValue | undefined
}

// Command parameter types
export type PiPromptParams = {
  text: string
  expandPromptTemplates?: boolean
  images?: string[]
}

export type PiSteerParams = {
  text: string
  images?: string[]
}

export type PiFollowUpParams = {
  text: string
  images?: string[]
}

export type PiSetModelParams = {
  provider: string
  modelId: string
}

export type PiSetThinkingLevelParams = {
  level: string
}

export type PiEntriesGetParams = {
  cursor?: string
  limit?: number
  maxBytes?: number
}

export type PiBranchGetParams = {
  cursor?: string
  limit?: number
  maxBytes?: number
}

export type PiSessionListParams = {
  cwd: string
}

export type PiSessionOpenParams = {
  cwd: string
  sessionFile?: string
}

// Command result types
export type PiEntriesPage = {
  items: SessionEntry[]
  cursor?: string
  hasMore: boolean
}

export type PiSessionListResult = SessionInfo[]

// Transport layer - raw API calls
export async function fetchHostHealth(signal?: AbortSignal): Promise<HealthResponse> {
  return readJson<HealthResponse>(`${getApiBase()}/api/v1/host/health`, { signal })
}

export async function fetchPiRegistry(signal?: AbortSignal): Promise<PiRegistrySnapshot> {
  return readJson<PiRegistrySnapshot>(`${getApiBase()}/api/v1/pi/registry`, { signal })
}

export async function fetchHostRegistry(signal?: AbortSignal): Promise<HostRegistrySnapshot> {
  return readJson<HostRegistrySnapshot>(`${getApiBase()}/api/v1/host/registry`, { signal })
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

export async function postPiSessionCommand<T = JsonValue | undefined>(
  sessionId: string,
  name: string,
  params?: JsonObject,
  signal?: AbortSignal,
): Promise<T extends undefined ? null : T> {
  const body = params ? JSON.stringify(params) : '{}'
  const response = await readJson<PiCommandResponse<T>>(
    `${getApiBase()}/api/v1/pi/sessions/${encodeURIComponent(sessionId)}/commands/${encodeURIComponent(name)}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      signal,
    },
  )
  return response.data
}

// Session commands
export function listPiSessions(params: PiSessionListParams, signal?: AbortSignal): Promise<PiSessionListResult> {
  return postPiGlobalCommand<PiSessionListResult>('session.list', params, signal)
}

export function listAllPiSessions(signal?: AbortSignal): Promise<PiSessionListResult> {
  return postPiGlobalCommand<PiSessionListResult>('session.listAll', undefined, signal)
}

export function openPiSession(params: PiSessionOpenParams, signal?: AbortSignal): Promise<PiSessionOpenResult> {
  return postPiGlobalCommand<PiSessionOpenResult>('session.open', params, signal)
}

export function deletePiSession(cwd: string, sessionFile: string, signal?: AbortSignal): Promise<null> {
  return postPiGlobalCommand('session.delete', { cwd, sessionFile }, signal)
}

// State commands
export function getPiSessionState(sessionId: string, signal?: AbortSignal): Promise<JsonValue> {
  return postPiSessionCommand(sessionId, 'state.get', undefined, signal)
}

export function getPiEntriesPage(sessionId: string, params: PiEntriesGetParams, signal?: AbortSignal): Promise<PiEntriesPage> {
  return postPiSessionCommand(sessionId, 'entries.get', params, signal)
}

export function getPiBranchPage(sessionId: string, params: PiBranchGetParams, signal?: AbortSignal): Promise<PiBranchPage> {
  return postPiSessionCommand(sessionId, 'branch.get', params, signal)
}

export function getPiTree(sessionId: string, signal?: AbortSignal): Promise<JsonValue> {
  return postPiSessionCommand(sessionId, 'tree.get', undefined, signal)
}

export function getPiSessionRegistry(sessionId: string, signal?: AbortSignal): Promise<JsonValue> {
  return postPiSessionCommand(sessionId, 'registry.get', undefined, signal)
}

// Action commands
export function promptPi(sessionId: string, params: PiPromptParams, signal?: AbortSignal): Promise<CommandRecord> {
  return postPiSessionCommand(sessionId, 'prompt', params, signal)
}

export function steerPi(sessionId: string, params: PiSteerParams, signal?: AbortSignal): Promise<CommandRecord> {
  return postPiSessionCommand(sessionId, 'steer', params, signal)
}

export function followUpPi(sessionId: string, params: PiFollowUpParams, signal?: AbortSignal): Promise<CommandRecord> {
  return postPiSessionCommand(sessionId, 'followUp', params, signal)
}

export function abortPi(sessionId: string, signal?: AbortSignal): Promise<CommandRecord> {
  return postPiSessionCommand(sessionId, 'abort', undefined, signal)
}

// Model commands
export function setPiModel(sessionId: string, params: PiSetModelParams, signal?: AbortSignal): Promise<CommandRecord> {
  return postPiSessionCommand(sessionId, 'setModel', params, signal)
}

export function cyclePiModel(sessionId: string, direction?: 'forward' | 'backward', signal?: AbortSignal): Promise<CommandRecord> {
  return postPiSessionCommand(sessionId, 'cycleModel', direction ? { direction } : undefined, signal)
}

export function setPiThinkingLevel(sessionId: string, params: PiSetThinkingLevelParams, signal?: AbortSignal): Promise<CommandRecord> {
  return postPiSessionCommand(sessionId, 'setThinkingLevel', params, signal)
}

export function cyclePiThinkingLevel(sessionId: string, signal?: AbortSignal): Promise<CommandRecord> {
  return postPiSessionCommand(sessionId, 'cycleThinkingLevel', undefined, signal)
}

// Helper
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
