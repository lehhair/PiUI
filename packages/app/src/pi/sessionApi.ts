/**
 * PiUI session API client — talks to packages/server /api/v1 only.
 * No OpenCode SDK. No real LLM calls from the browser.
 */

import type {
  ExtensionUiDialogResponseV1,
  ExtensionUiSnapshotV1,
  CommandRecordV2,
  SessionAttachmentV2,
  SessionReplacementResultV1,
  SessionSnapshotV1,
  FileCreateRequestV1,
  FileListResponseV1,
  FileMoveRequestV1,
  FileOperationResponseV1,
  FileReadResponseV1,
  FileNameSearchResponseV1,
  FileTextSearchResponseV1,
  PiSettingsPatchV1,
  PiSettingsSnapshotV1,
  ProjectTrustV1,
  ProviderAuthInfoV1,
  ConfiguredPackageV1,
  PiResourceSnapshotV1,
  PiResourceExtensionPathsV1,
  PiRuntimeInspectionV1,
  PiModelRuntimeSnapshotV1,
  PiNativeModelV1,
  ResolvedPackageResourcesV1,
  PackageResolveMissingActionV1,
  PackageUpdateV1,
  PiNativeEntriesPageV1,
  PiNativeJsonValueV1,
} from "@piui/protocol"
import type { PiSessionSummary } from "../types/session"
import type { Attachment } from "../features/attachment/types"
import { reconcilePiSessions, trackPiSession, untrackPiSession } from "./piSessionIndex"
import { nativeSessionStore } from "./nativeSessionStore"
import { extensionUiStore } from "./extensionUiStore"
import { LOCAL_SERVER_ID, makeBasicAuthHeader, serverStore } from "../store/serverStore"

const DEFAULT_BASE = "http://127.0.0.1:8787"
const rawFetch = globalThis.fetch.bind(globalThis)

export function newCommandId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `cmd-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

/**
 * Browser dev uses same-origin + Vite proxy (`/api` → :8787) to avoid CORS.
 * Override with VITE_PIUI_API when needed.
 */
export function getApiBase(): string {
  const envBase = (import.meta as ImportMeta & { env?: { VITE_PIUI_API?: string } }).env?.VITE_PIUI_API
  if (envBase) return envBase.replace(/\/$/, "")
  if (typeof window !== "undefined") {
    const active = serverStore.getActiveServer()
    if (active && active.id !== LOCAL_SERVER_ID) return active.url.replace(/\/$/, "")
    const storedLocal = serverStore.getStoredServers().find(server => server.id === LOCAL_SERVER_ID)
    if (active && storedLocal && active.url !== storedLocal.url) return active.url.replace(/\/$/, "")
    return ""
  }
  return DEFAULT_BASE
}

function piHeaders(init?: HeadersInit): Headers {
  const headers = new Headers(init)
  const gatewayAuth = serverStore.getActiveAuth()
  if (gatewayAuth?.password) {
    headers.set("authorization", makeBasicAuthHeader(gatewayAuth))
    return headers
  }
  const token = (import.meta as ImportMeta & { env?: { VITE_PIUI_TOKEN?: string } }).env?.VITE_PIUI_TOKEN
  if (token) headers.set("authorization", `Bearer ${token}`)
  return headers
}

export function getPiAuthToken(): string | undefined {
  if (serverStore.getActiveAuth()?.password) return undefined
  return (import.meta as ImportMeta & { env?: { VITE_PIUI_TOKEN?: string } }).env?.VITE_PIUI_TOKEN
}

export function piFetch(input: string, init?: RequestInit): Promise<Response> {
  return rawFetch(input, { ...init, headers: piHeaders(init?.headers) })
}

// Keep the rest of this transitional client on one authenticated transport.
const fetch = piFetch

export async function isPiServerUp(): Promise<boolean> {
  try {
    const res = await piFetch(`${getApiBase()}/api/v1/host/health`, { signal: AbortSignal.timeout(1500) })
    if (!res.ok) return false
    const body = (await res.json()) as { service?: string; protocolVersion?: number }
    return body.service === "piui-server" && body.protocolVersion === 1
  } catch {
    return false
  }
}

export async function listPiModels(): Promise<{
  driver: string
  models: PiNativeModelV1[]
  error?: string
}> {
  const res = await fetch(`${getApiBase()}/api/v1/drivers/pi/models`)
  if (!res.ok) throw new Error(`listPiModels ${res.status}`)
  return (await res.json()) as { driver: string; models: PiNativeModelV1[]; error?: string }
}

export function listPiSessionModels(sessionId: string): Promise<PiNativeModelV1[]> {
  return getPiJson(`/api/v1/sessions/${encodeURIComponent(sessionId)}/models`, "listPiSessionModels")
}

export async function listPiSessions(workspacePath?: string): Promise<PiSessionSummary[]> {
  const query = workspacePath ? `?workspacePath=${encodeURIComponent(workspacePath)}` : ""
  const res = await fetch(`${getApiBase()}/api/v1/sessions${query}`)
  if (!res.ok) throw new Error(`listPiSessions ${res.status}`)
  const data = (await res.json()) as { sessions: PiSessionSummary[] }
  for (const s of data.sessions) {
    trackPiSession(s.id, s.directory)
  }
  for (const removed of reconcilePiSessions(data.sessions.map(session => session.id), workspacePath)) {
    nativeSessionStore.clear(removed)
    extensionUiStore.remove(removed)
  }
  return data.sessions
}

export async function createPiSession(opts?: {
  title?: string
  seedMock?: boolean
  workspacePath?: string
}): Promise<{ summary: PiSessionSummary; snapshot: SessionSnapshotV1 }> {
  const res = await fetch(`${getApiBase()}/api/v1/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title: opts?.title,
      seedMock: opts?.seedMock === true,
      workspacePath: opts?.workspacePath,
    }),
  })
  if (!res.ok) throw new Error(`createPiSession ${res.status}`)
  const data = (await res.json()) as { session: PiSessionSummary; snapshot: SessionSnapshotV1 }
  trackPiSession(data.session.id, data.session.directory)
  return { summary: data.session, snapshot: data.snapshot }
}

export async function deletePiSession(sessionId: string): Promise<{
  ok: true
  id: string
  commandId: string
  command: CommandRecordV2<"session.delete">
}> {
  const res = await fetch(`${getApiBase()}/api/v1/sessions/${encodeURIComponent(sessionId)}`, {
    method: "DELETE",
  })
  if (!res.ok) {
    let code: string | undefined
    try {
      code = ((await res.json()) as { code?: string }).code
    } catch {
      /* no structured error body */
    }
    throw Object.assign(new Error(`deletePiSession ${res.status}`), { status: res.status, code })
  }
  const result = (await res.json()) as {
    ok: true
    id: string
    commandId: string
    command: CommandRecordV2<"session.delete">
  }
  untrackPiSession(sessionId)
  nativeSessionStore.clear(sessionId)
  return result
}


export async function listWorkspaceFiles(
  workspacePath: string,
  path = "",
  signal?: AbortSignal,
): Promise<FileListResponseV1> {
  return listWorkspaceFilesAttempt(workspacePath, path, signal, true)
}

async function listWorkspaceFilesAttempt(
  workspacePath: string,
  path: string,
  signal: AbortSignal | undefined,
  allowRetry: boolean,
): Promise<FileListResponseV1> {
  const entries: FileListResponseV1["entries"] = []
  let cursor: string | undefined
  let page: FileListResponseV1 | undefined
  do {
    const q = new URLSearchParams({ limit: "2000" })
    if (path && path !== "." && path !== "./") q.set("path", path)
    if (cursor) q.set("cursor", cursor)
    const res = await fetch(
      `${getApiBase()}/api/v1/workspaces/${encodeURIComponent(workspacePath)}/files?${q}`,
      { signal },
    )
    if (!res.ok) {
      if (res.status === 409 && allowRetry) {
        const problem = await res.clone().json().catch(() => ({})) as { code?: string }
        if (problem.code === "STALE_REVISION") return listWorkspaceFilesAttempt(workspacePath, path, signal, false)
      }
      await throwPiApiError(res, "listWorkspaceFiles")
    }
    page = (await res.json()) as FileListResponseV1
    entries.push(...page.entries)
    cursor = page.nextCursor
  } while (cursor && entries.length < 20_000)
  return {
    path: page?.path ?? path,
    entries,
    total: page?.total ?? entries.length,
    truncated: Boolean(cursor),
    nextCursor: cursor,
  }
}

export async function readWorkspaceFile(workspacePath: string, path: string, signal?: AbortSignal): Promise<FileReadResponseV1> {
  const q = new URLSearchParams({ path })
  const res = await fetch(
    `${getApiBase()}/api/v1/workspaces/${encodeURIComponent(workspacePath)}/file?${q}`,
    { signal },
  )
  if (!res.ok) await throwPiApiError(res, "readWorkspaceFile")
  return (await res.json()) as FileReadResponseV1
}

export async function searchWorkspaceFiles(
  workspacePath: string,
  query: string,
  opts?: { type?: "file" | "directory"; limit?: number; signal?: AbortSignal },
): Promise<string[]> {
  const q = new URLSearchParams({ q: query })
  if (opts?.type) q.set("type", opts.type)
  if (opts?.limit) q.set("limit", String(opts.limit))
  const res = await fetch(
    `${getApiBase()}/api/v1/workspaces/${encodeURIComponent(workspacePath)}/search/files?${q}`,
    { signal: opts?.signal },
  )
  if (!res.ok) await throwPiApiError(res, "searchWorkspaceFiles")
  const data = (await res.json()) as FileNameSearchResponseV1
  return data.paths
}

export async function searchWorkspaceText(workspacePath: string, pattern: string, limit = 50, signal?: AbortSignal) {
  const q = new URLSearchParams({ q: pattern, limit: String(limit) })
  const res = await fetch(
    `${getApiBase()}/api/v1/workspaces/${encodeURIComponent(workspacePath)}/search/text?${q}`,
    { signal },
  )
  if (!res.ok) await throwPiApiError(res, "searchWorkspaceText")
  const data = (await res.json()) as FileTextSearchResponseV1
  return data.matches
}

export async function writeWorkspaceFile(
  workspacePath: string,
  path: string,
  content: string,
  ifMatch?: string,
  encoding: "utf-8" | "base64" = "utf-8",
): Promise<FileReadResponseV1> {
  const q = new URLSearchParams({ path })
  const res = await fetch(
    `${getApiBase()}/api/v1/workspaces/${encodeURIComponent(workspacePath)}/file?${q}`,
    {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        ...(ifMatch ? { "if-match": ifMatch } : {}),
      },
      body: JSON.stringify({ content, ifMatch, encoding }),
    },
  )
  if (!res.ok) await throwPiApiError(res, "writeWorkspaceFile")
  return (await res.json()) as FileReadResponseV1
}

export async function createWorkspaceEntry(
  workspacePath: string,
  request: FileCreateRequestV1,
): Promise<FileOperationResponseV1 | FileReadResponseV1> {
  const res = await fetch(`${getApiBase()}/api/v1/workspaces/${encodeURIComponent(workspacePath)}/files`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  })
  if (!res.ok) await throwPiApiError(res, "createWorkspaceEntry")
  return (await res.json()) as FileOperationResponseV1 | FileReadResponseV1
}

export async function moveWorkspaceEntry(workspacePath: string, request: FileMoveRequestV1): Promise<FileOperationResponseV1> {
  const res = await fetch(`${getApiBase()}/api/v1/workspaces/${encodeURIComponent(workspacePath)}/file`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  })
  if (!res.ok) await throwPiApiError(res, "moveWorkspaceEntry")
  return (await res.json()) as FileOperationResponseV1
}

export async function deleteWorkspaceEntry(workspacePath: string, path: string, recursive = false): Promise<void> {
  const q = new URLSearchParams({ path, recursive: String(recursive) })
  const res = await fetch(`${getApiBase()}/api/v1/workspaces/${encodeURIComponent(workspacePath)}/file?${q}`, {
    method: "DELETE",
  })
  if (!res.ok) await throwPiApiError(res, "deleteWorkspaceEntry")
}

async function throwPiApiError(response: Response, operation: string): Promise<never> {
  let problem: { code?: string; message?: string; details?: unknown } = {}
  try {
    problem = await response.json() as typeof problem
  } catch {
    /* response has no structured problem */
  }
  throw Object.assign(new Error(problem.message || `${operation} failed with HTTP ${response.status}`), {
    name: "PiApiError",
    operation,
    status: response.status,
    code: problem.code,
    details: problem.details,
  })
}

async function getPiJson<T>(path: string, operation: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${getApiBase()}${path}`, init)
  if (!response.ok) await throwPiApiError(response, operation)
  return await response.json() as T
}

async function sendPiVoid(path: string, operation: string, init: RequestInit): Promise<void> {
  const response = await fetch(`${getApiBase()}${path}`, init)
  if (!response.ok) await throwPiApiError(response, operation)
}

export async function getPiCommand(commandId: string): Promise<CommandRecordV2> {
  return (await getPiJson<{ command: CommandRecordV2 }>(
    `/api/v1/commands/${encodeURIComponent(commandId)}`,
    "getPiCommand",
  )).command
}

export async function waitForPiCommand(commandId: string, timeoutMs = 30_000): Promise<CommandRecordV2> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const command = await getPiCommand(commandId)
    if (command.status === "completed") return command
    if (command.status === "failed" || command.status === "cancelled" || command.status === "unknown_after_crash") {
      throw Object.assign(new Error(command.error?.message || `Command ${command.status}`), { command })
    }
    await new Promise(resolve => setTimeout(resolve, 150))
  }
  throw new Error(`Command did not complete within ${timeoutMs}ms`)
}

export async function getPiSettings(workspacePath: string): Promise<PiSettingsSnapshotV1> {
  const res = await fetch(`${getApiBase()}/api/v1/workspaces/${encodeURIComponent(workspacePath)}/pi-settings`)
  if (!res.ok) await throwPiApiError(res, "getPiSettings")
  return await res.json() as PiSettingsSnapshotV1
}

export async function patchPiSettings(workspacePath: string, patch: PiSettingsPatchV1): Promise<PiSettingsSnapshotV1> {
  const res = await fetch(`${getApiBase()}/api/v1/workspaces/${encodeURIComponent(workspacePath)}/pi-settings`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  })
  if (!res.ok) await throwPiApiError(res, "patchPiSettings")
  return await res.json() as PiSettingsSnapshotV1
}

export async function getProjectTrust(workspacePath: string): Promise<ProjectTrustV1> {
  const res = await fetch(`${getApiBase()}/api/v1/workspaces/${encodeURIComponent(workspacePath)}/trust`)
  if (!res.ok) await throwPiApiError(res, "getProjectTrust")
  return await res.json() as ProjectTrustV1
}

export async function setProjectTrust(workspacePath: string, decision: boolean | null): Promise<ProjectTrustV1> {
  const res = await fetch(`${getApiBase()}/api/v1/workspaces/${encodeURIComponent(workspacePath)}/trust`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ decision }),
  })
  if (!res.ok) await throwPiApiError(res, "setProjectTrust")
  return await res.json() as ProjectTrustV1
}

export async function listPiProviders(): Promise<ProviderAuthInfoV1[]> {
  const res = await fetch(`${getApiBase()}/api/v1/providers`)
  if (!res.ok) await throwPiApiError(res, "listPiProviders")
  return ((await res.json()) as { providers: ProviderAuthInfoV1[] }).providers
}

export function inspectModelRuntime(sessionId?: string): Promise<PiModelRuntimeSnapshotV1> {
  const scope = sessionId ? `/api/v1/sessions/${encodeURIComponent(sessionId)}` : "/api/v1"
  return getPiJson<PiModelRuntimeSnapshotV1>(`${scope}/model-runtime`, "inspectModelRuntime")
}

export async function reloadModelRuntime(sessionId?: string): Promise<void> {
  const scope = sessionId ? `/api/v1/sessions/${encodeURIComponent(sessionId)}` : "/api/v1"
  await getPiJson(`${scope}/model-runtime/reload`, "reloadModelRuntime", { method: "POST" })
}

export function refreshModelRuntime(sessionId?: string, options: Record<string, unknown> = {}): Promise<{ result: unknown }> {
  const scope = sessionId ? `/api/v1/sessions/${encodeURIComponent(sessionId)}` : "/api/v1"
  return getPiJson(`${scope}/model-runtime/refresh`, "refreshModelRuntime", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(options),
  })
}

export async function setProviderApiKey(providerId: string, apiKey: string): Promise<void> {
  const res = await fetch(`${getApiBase()}/api/v1/providers/${encodeURIComponent(providerId)}/runtime-api-key`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ apiKey }),
  })
  if (!res.ok) await throwPiApiError(res, "setProviderApiKey")
}

export async function logoutProvider(providerId: string): Promise<void> {
  const res = await fetch(`${getApiBase()}/api/v1/providers/${encodeURIComponent(providerId)}/auth`, { method: "DELETE" })
  if (!res.ok) await throwPiApiError(res, "logoutProvider")
}

export function removeProviderApiKey(providerId: string, sessionId?: string): Promise<void> {
  const path = sessionId
    ? `/api/v1/sessions/${encodeURIComponent(sessionId)}/providers/${encodeURIComponent(providerId)}/runtime-api-key`
    : `/api/v1/providers/${encodeURIComponent(providerId)}/runtime-api-key`
  return sendPiVoid(path, "removeProviderApiKey", { method: "DELETE" })
}

export async function listSessionProviders(sessionId: string): Promise<ProviderAuthInfoV1[]> {
  const data = await getPiJson<{ providers: ProviderAuthInfoV1[] }>(
    `/api/v1/sessions/${encodeURIComponent(sessionId)}/providers`,
    "listSessionProviders",
  )
  return data.providers
}

export async function setSessionProviderApiKey(sessionId: string, providerId: string, apiKey: string): Promise<void> {
  await getPiJson(
    `/api/v1/sessions/${encodeURIComponent(sessionId)}/providers/${encodeURIComponent(providerId)}/runtime-api-key`,
    "setSessionProviderApiKey",
    { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ apiKey }) },
  )
}

export function startProviderAuth(providerId: string, type: "api_key" | "oauth", sessionId?: string): Promise<{ flowId: string }> {
  const path = sessionId
    ? `/api/v1/sessions/${encodeURIComponent(sessionId)}/providers/${encodeURIComponent(providerId)}/auth-flows`
    : `/api/v1/providers/${encodeURIComponent(providerId)}/auth-flows`
  return getPiJson(path, "startProviderAuth", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type }),
  })
}

export async function respondProviderAuth(
  flowId: string,
  promptId: string,
  value: string,
  sessionId?: string,
): Promise<void> {
  const path = sessionId
    ? `/api/v1/sessions/${encodeURIComponent(sessionId)}/auth-flows/${encodeURIComponent(flowId)}/prompts/${encodeURIComponent(promptId)}/response`
    : `/api/v1/auth-flows/${encodeURIComponent(flowId)}/prompts/${encodeURIComponent(promptId)}/response`
  await getPiJson(path, "respondProviderAuth", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ value }),
  })
}

export function cancelProviderAuth(flowId: string, sessionId?: string): Promise<void> {
  const path = sessionId
    ? `/api/v1/sessions/${encodeURIComponent(sessionId)}/auth-flows/${encodeURIComponent(flowId)}`
    : `/api/v1/auth-flows/${encodeURIComponent(flowId)}`
  return sendPiVoid(path, "cancelProviderAuth", { method: "DELETE" })
}

export function logoutSessionProvider(sessionId: string, providerId: string): Promise<void> {
  return sendPiVoid(
    `/api/v1/sessions/${encodeURIComponent(sessionId)}/providers/${encodeURIComponent(providerId)}/auth`,
    "logoutSessionProvider",
    { method: "DELETE" },
  )
}

export async function listPiPackages(workspacePath: string): Promise<ConfiguredPackageV1[]> {
  const res = await fetch(`${getApiBase()}/api/v1/workspaces/${encodeURIComponent(workspacePath)}/packages`)
  if (!res.ok) await throwPiApiError(res, "listPiPackages")
  return ((await res.json()) as { packages: ConfiguredPackageV1[] }).packages
}

export async function managePiPackage(
  workspacePath: string,
  action: "install" | "remove" | "update",
  source?: string,
  local = true,
): Promise<ConfiguredPackageV1[]> {
  return (await managePiPackageDetailed(workspacePath, action, source, local)).packages
}

export async function managePiPackageDetailed(
  workspacePath: string,
  action: "install" | "remove" | "update",
  source?: string,
  local = true,
): Promise<{ commandId: string; packages: ConfiguredPackageV1[] }> {
  const commandId = newCommandId()
  const res = await fetch(
    `${getApiBase()}/api/v1/workspaces/${encodeURIComponent(workspacePath)}/commands/packages/${action}`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-command-id": commandId },
      body: JSON.stringify({ source, local, persist: true }),
    },
  )
  if (!res.ok) await throwPiApiError(res, "managePiPackage")
  return await res.json() as { commandId: string; packages: ConfiguredPackageV1[] }
}

export function resolvePiPackages(
  workspacePath: string,
  missingAction: PackageResolveMissingActionV1 = "skip",
): Promise<ResolvedPackageResourcesV1> {
  const query = new URLSearchParams({ missingAction })
  return getPiJson(
    `/api/v1/workspaces/${encodeURIComponent(workspacePath)}/packages/resolved?${query}`,
    "resolvePiPackages",
  )
}

export function resolvePiExtensionSources(
  workspacePath: string,
  sources: string[],
  options: { local?: boolean; temporary?: boolean } = {},
): Promise<ResolvedPackageResourcesV1> {
  return getPiJson(
    `/api/v1/workspaces/${encodeURIComponent(workspacePath)}/packages/resolve-extension-sources`,
    "resolvePiExtensionSources",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sources, ...options }),
    },
  )
}

export async function changePiPackageSource(
  workspacePath: string,
  source: string,
  action: "add" | "remove",
  local = true,
): Promise<{ changed: boolean; packages: ConfiguredPackageV1[] }> {
  return getPiJson(
    `/api/v1/workspaces/${encodeURIComponent(workspacePath)}/packages/sources`,
    "changePiPackageSource",
    {
      method: action === "add" ? "POST" : "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source, local }),
    },
  )
}

export async function getPiPackageInstalledPath(
  workspacePath: string,
  source: string,
  scope: "user" | "project",
): Promise<string> {
  const query = new URLSearchParams({ source, scope })
  const data = await getPiJson<{ path: string }>(
    `/api/v1/workspaces/${encodeURIComponent(workspacePath)}/packages/installed-path?${query}`,
    "getPiPackageInstalledPath",
  )
  return data.path
}

export async function checkPiPackageUpdates(workspacePath: string): Promise<PackageUpdateV1[]> {
  const data = await getPiJson<{ updates: PackageUpdateV1[] }>(
    `/api/v1/workspaces/${encodeURIComponent(workspacePath)}/packages/updates`,
    "checkPiPackageUpdates",
  )
  return data.updates
}

export async function inspectPiResources(sessionId: string): Promise<PiResourceSnapshotV1> {
  const res = await fetch(`${getApiBase()}/api/v1/sessions/${encodeURIComponent(sessionId)}/resources`)
  if (!res.ok) await throwPiApiError(res, "inspectPiResources")
  return await res.json() as PiResourceSnapshotV1
}

export async function reloadPiResources(sessionId: string): Promise<string> {
  const commandId = newCommandId()
  const res = await fetch(`${getApiBase()}/api/v1/sessions/${encodeURIComponent(sessionId)}/commands/reload-resources`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-command-id": commandId },
    body: JSON.stringify({ commandId }),
  })
  if (!res.ok) await throwPiApiError(res, "reloadPiResources")
  return ((await res.json()) as { commandId?: string }).commandId ?? commandId
}

export function extendPiResources(sessionId: string, paths: PiResourceExtensionPathsV1): Promise<PiResourceSnapshotV1> {
  return getPiJson(`/api/v1/sessions/${encodeURIComponent(sessionId)}/resources`, "extendPiResources", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(paths),
  })
}

export function inspectPiRuntime(sessionId: string): Promise<PiRuntimeInspectionV1> {
  return getPiJson(`/api/v1/sessions/${encodeURIComponent(sessionId)}/runtime-inspection`, "inspectPiRuntime")
}

export async function inspectPiSystemPrompt(sessionId: string): Promise<string> {
  const data = await getPiJson<{ text: string }>(
    `/api/v1/sessions/${encodeURIComponent(sessionId)}/system-prompt`,
    "inspectPiSystemPrompt",
  )
  return data.text
}

export async function inspectPiToolDefinition(sessionId: string, toolName: string): Promise<unknown> {
  const data = await getPiJson<{ definition: unknown }>(
    `/api/v1/sessions/${encodeURIComponent(sessionId)}/tools/${encodeURIComponent(toolName)}/definition`,
    "inspectPiToolDefinition",
  )
  return data.definition
}

export async function hasPiExtensionHandlers(sessionId: string, eventType: string): Promise<boolean> {
  const data = await getPiJson<{ registered: boolean }>(
    `/api/v1/sessions/${encodeURIComponent(sessionId)}/extension-handlers/${encodeURIComponent(eventType)}`,
    "hasPiExtensionHandlers",
  )
  return data.registered
}


export async function setSessionModel(sessionId: string, provider: string, modelId: string) {
  const res = await fetch(
    `${getApiBase()}/api/v1/sessions/${encodeURIComponent(sessionId)}/commands/set-model`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider, id: modelId }),
    },
  )
  if (!res.ok) throw new Error(`setSessionModel ${res.status}`)
  const data = (await res.json()) as { snapshot: SessionSnapshotV1 }
  return data.snapshot
}

export async function setSessionThinkingLevel(sessionId: string, level: string) {
  const res = await fetch(
    `${getApiBase()}/api/v1/sessions/${encodeURIComponent(sessionId)}/commands/set-thinking-level`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ level }),
    },
  )
  if (!res.ok) throw new Error(`setSessionThinkingLevel ${res.status}`)
  const data = (await res.json()) as { snapshot: SessionSnapshotV1 }
  return data.snapshot
}

interface SessionCommandResult<T extends keyof import("@piui/protocol").CommandPayloadsV2> {
  commandId: string
  command: CommandRecordV2<T>
}

export interface AcceptedSessionCommand<T extends keyof import("@piui/protocol").CommandPayloadsV2>
  extends SessionCommandResult<T> {
  accepted: true
  reused: boolean
  snapshot: SessionSnapshotV1
}

export interface SessionReplacementResponse<T extends "session.fork" | "session.clone" | "session.import" | "session.new" | "session.switch">
  extends SessionCommandResult<T> {
  replacement: SessionReplacementResultV1
  sourceSnapshot: SessionSnapshotV1
  targetSnapshot: SessionSnapshotV1
}

async function postSessionCommand<T>(sessionId: string, command: string, body: unknown): Promise<T> {
  const res = await piFetch(
    `${getApiBase()}/api/v1/sessions/${encodeURIComponent(sessionId)}/commands/${command}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  )
  if (!res.ok) throw new Error(`${command} ${res.status}`)
  return (await res.json()) as T
}

export function navigatePiSessionTree(
  sessionId: string,
  entryId: string,
  summarize = false,
  options: { customInstructions?: string; replaceInstructions?: boolean; label?: string } = {},
  commandId = newCommandId(),
) {
  return postSessionCommand<
    SessionCommandResult<"session.navigateTree"> & {
      editorText?: string
      cancelled: boolean
      aborted: boolean
      snapshot: SessionSnapshotV1
    }
  >(sessionId, "navigate-tree", {
    entryId,
    summarize,
    commandId,
    ...options,
  })
}

export function setPiSessionLabel(
  sessionId: string,
  entryId: string,
  label?: string,
  commandId = newCommandId(),
) {
  return postSessionCommand<SessionCommandResult<"session.setLabel"> & { snapshot: SessionSnapshotV1 }>(
    sessionId,
    "set-label",
    { entryId, label, commandId },
  )
}

export function setPiSessionName(sessionId: string, name: string, commandId = newCommandId()) {
  return postSessionCommand<SessionCommandResult<"session.setName"> & { snapshot: SessionSnapshotV1 }>(
    sessionId,
    "set-name",
    { name, commandId },
  )
}

export function forkPiSession(
  sessionId: string,
  entryId: string,
  position: "before" | "at" = "at",
  commandId = newCommandId(),
) {
  return postSessionCommand<SessionReplacementResponse<"session.fork">>(sessionId, "fork", {
    entryId,
    position,
    commandId,
  })
}

export function clonePiSession(sessionId: string, entryId?: string, commandId = newCommandId()) {
  return postSessionCommand<SessionReplacementResponse<"session.clone">>(sessionId, "clone", {
    entryId,
    commandId,
  })
}

export function importPiSession(
  sessionId: string,
  inputPath: string,
  cwdOverride?: string,
  commandId = newCommandId(),
) {
  return postSessionCommand<SessionReplacementResponse<"session.import">>(sessionId, "import", {
    inputPath,
    cwdOverride,
    commandId,
  })
}

export function createNativePiSession(sessionId: string, parentSessionId?: string, commandId = newCommandId()) {
  return postSessionCommand<SessionReplacementResponse<"session.new">>(sessionId, "new-session", {
    parentSessionId,
    commandId,
  })
}

export function switchNativePiSession(sessionId: string, targetSessionId: string, commandId = newCommandId()) {
  return postSessionCommand<SessionReplacementResponse<"session.switch">>(sessionId, "switch-session", {
    targetSessionId,
    commandId,
  })
}

export function cyclePiSessionModel(
  sessionId: string,
  direction: "forward" | "backward" = "forward",
  commandId = newCommandId(),
) {
  return postSessionCommand<SessionCommandResult<"session.cycleModel"> & { snapshot: SessionSnapshotV1 }>(
    sessionId,
    "cycle-model",
    { direction, commandId },
  )
}

export function cyclePiThinkingLevel(sessionId: string, commandId = newCommandId()) {
  return postSessionCommand<SessionCommandResult<"session.cycleThinkingLevel"> & { snapshot: SessionSnapshotV1 }>(
    sessionId,
    "cycle-thinking-level",
    { commandId },
  )
}

export function setPiScopedModels(sessionId: string, patterns: string[], commandId = newCommandId()) {
  return postSessionCommand<SessionCommandResult<"session.setScopedModels"> & {
    snapshot: SessionSnapshotV1
    diagnostics?: unknown[]
  }>(sessionId, "set-scoped-models", { patterns, commandId })
}

export async function executePiBash(
  sessionId: string,
  command: string,
  excludeFromContext = false,
  commandId = newCommandId(),
): Promise<CommandRecordV2> {
  await postSessionCommand(sessionId, "bash", { command, excludeFromContext, commandId })
  return waitForPiCommand(commandId)
}

export function abortPiBash(sessionId: string, commandId = newCommandId()) {
  return postSessionCommand<SessionCommandResult<"session.abortBash"> & { snapshot: SessionSnapshotV1 }>(
    sessionId,
    "abort-bash",
    { commandId },
  )
}

export async function exportPiSession(
  sessionId: string,
  format: "html" | "jsonl",
  outputPath?: string,
  commandId = newCommandId(),
): Promise<CommandRecordV2> {
  await postSessionCommand(sessionId, format === "html" ? "export-html" : "export-jsonl", { outputPath, commandId })
  return waitForPiCommand(commandId)
}

export function sendPiUserMessage(
  sessionId: string,
  text: string,
  deliverAs?: "steer" | "followUp",
  attachments?: SessionAttachmentV2[],
  commandId = newCommandId(),
) {
  return postSessionCommand<SessionCommandResult<"session.sendUserMessage"> & { accepted: true; reused: boolean }>(sessionId, "send-user-message", {
    text,
    deliverAs,
    attachments,
    commandId,
  })
}

export function sendPiCustomMessage(
  sessionId: string,
  body: import("@piui/protocol").CommandPayloadsV2["session.sendCustomMessage"],
  commandId = newCommandId(),
) {
  return postSessionCommand<SessionSnapshotV1>(sessionId, "custom-message", { ...body, commandId })
    .then(snapshot => ({ snapshot }))
}

export function appendPiCustomEntry(
  sessionId: string,
  customType: string,
  data?: unknown,
  commandId = newCommandId(),
) {
  return postSessionCommand<SessionSnapshotV1>(sessionId, "custom-entry", { customType, data, commandId })
    .then(snapshot => ({ snapshot }))
}

export function waitForPiSessionIdle(sessionId: string, commandId = newCommandId()) {
  return postSessionCommand<SessionSnapshotV1>(sessionId, "wait-for-idle", { commandId })
    .then(snapshot => ({ snapshot }))
}

export function compactSession(sessionId: string, instructions?: string, commandId = newCommandId()) {
  return postSessionCommand<AcceptedSessionCommand<"session.compact">>(sessionId, "compact", {
    instructions,
    commandId,
  })
}

export function abortPiCompaction(sessionId: string, commandId = newCommandId()) {
  return postSessionCommand<SessionCommandResult<"session.abortCompaction"> & { snapshot: SessionSnapshotV1 }>(
    sessionId,
    "abort-compaction",
    { commandId },
  )
}

export function abortPiBranchSummary(sessionId: string, commandId = newCommandId()) {
  return postSessionCommand<SessionCommandResult<"session.abortBranchSummary"> & { snapshot: SessionSnapshotV1 }>(
    sessionId,
    "abort-branch-summary",
    { commandId },
  )
}

export function abortPiRetry(sessionId: string, commandId = newCommandId()) {
  return postSessionCommand<SessionCommandResult<"session.abortRetry"> & { snapshot: SessionSnapshotV1 }>(
    sessionId,
    "abort-retry",
    { commandId },
  )
}

export function clearPiQueue(sessionId: string, commandId = newCommandId()) {
  return postSessionCommand<SessionCommandResult<"session.clearQueue"> & {
    cleared: { steering: string[]; followUp: string[] }
    snapshot: SessionSnapshotV1
  }>(sessionId, "clear-queue", { commandId })
}

export function setPiAutoCompaction(sessionId: string, enabled: boolean, commandId = newCommandId()) {
  return postSessionCommand<SessionCommandResult<"session.setAutoCompaction"> & { snapshot: SessionSnapshotV1 }>(
    sessionId,
    "set-auto-compaction",
    { enabled, commandId },
  )
}

export function setPiAutoRetry(sessionId: string, enabled: boolean, commandId = newCommandId()) {
  return postSessionCommand<SessionCommandResult<"session.setAutoRetry"> & { snapshot: SessionSnapshotV1 }>(
    sessionId,
    "set-auto-retry",
    { enabled, commandId },
  )
}

export function setPiQueueModes(
  sessionId: string,
  modes: { steeringMode?: "all" | "one-at-a-time"; followUpMode?: "all" | "one-at-a-time" },
  commandId = newCommandId(),
) {
  return postSessionCommand<SessionCommandResult<"session.setQueueModes"> & { snapshot: SessionSnapshotV1 }>(
    sessionId,
    "set-queue-modes",
    { ...modes, commandId },
  )
}

export function setPiActiveTools(sessionId: string, toolNames: string[], commandId = newCommandId()) {
  return postSessionCommand<SessionCommandResult<"session.setActiveTools"> & { snapshot: SessionSnapshotV1 }>(
    sessionId,
    "set-tools",
    { toolNames, commandId },
  )
}

export async function listSessionCommands(sessionId: string) {
  const res = await fetch(
    `${getApiBase()}/api/v1/sessions/${encodeURIComponent(sessionId)}/pi/commands`,
  )
  if (!res.ok) throw new Error(`listSessionCommands ${res.status}`)
  return (await res.json()) as {
    commands: Array<{
      name: string
      description?: string
      source: "extension" | "prompt" | "skill"
      sourceInfo: unknown
    }>
  }
}

export async function listSessionSkills(sessionId: string) {
  const res = await fetch(
    `${getApiBase()}/api/v1/sessions/${encodeURIComponent(sessionId)}/pi/skills`,
  )
  if (!res.ok) throw new Error(`listSessionSkills ${res.status}`)
  return (await res.json()) as {
    skills: Array<{
      name: string
      description: string
      filePath: string
      baseDir: string
      sourceInfo: unknown
      disableModelInvocation: boolean
    }>
  }
}

export async function abortSessionCommand(sessionId: string, commandId = newCommandId()): Promise<{
  snapshot: SessionSnapshotV1
  cleared: { steering: string[]; followUp: string[] }
}> {
  const res = await fetch(
    `${getApiBase()}/api/v1/sessions/${encodeURIComponent(sessionId)}/commands/abort`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ commandId }),
    },
  )
  if (!res.ok) {
    let detail = String(res.status)
    try {
      const error = (await res.json()) as { message?: string; code?: string }
      detail = error.message || error.code || detail
    } catch {
      /* no structured error body */
    }
    throw new Error(`abortSessionCommand failed: ${detail}`)
  }
  const data = (await res.json()) as {
    snapshot?: SessionSnapshotV1
    cleared?: { steering: string[]; followUp: string[] }
  }
  if (!data.snapshot) throw new Error("abortSessionCommand failed: missing snapshot")
  return { snapshot: data.snapshot, cleared: data.cleared ?? { steering: [], followUp: [] } }
}

export async function createMockSession(workspacePath: string, title?: string) {
  const res = await fetch(`${getApiBase()}/api/v1/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workspacePath, title, seedMock: true }),
  })
  if (!res.ok) throw new Error(`createMockSession ${res.status}`)
  return (await res.json()) as { snapshot: SessionSnapshotV1 }
}

export async function fetchSnapshot(sessionId: string): Promise<SessionSnapshotV1> {
  return getPiJson(`/api/v1/sessions/${encodeURIComponent(sessionId)}/snapshot`, "fetchSnapshot")
}

export async function fetchPiNativeEntriesPage(
  sessionId: string,
  cursor?: string,
  limit = 50,
): Promise<PiNativeEntriesPageV1> {
  const query = new URLSearchParams({ limit: String(limit), maxBytes: String(32 * 1024 * 1024) })
  if (cursor) query.set("cursor", cursor)
  return getPiJson(`/api/v1/sessions/${encodeURIComponent(sessionId)}/native/entries?${query}`, "fetchPiNativeEntriesPage")
}

export async function fetchPiNativeBranchPage(
  sessionId: string,
  cursor?: string,
  limit = 50,
): Promise<PiNativeEntriesPageV1> {
  const query = new URLSearchParams({ limit: String(limit), maxBytes: String(32 * 1024 * 1024) })
  if (cursor) query.set("cursor", cursor)
  return getPiJson(`/api/v1/sessions/${encodeURIComponent(sessionId)}/native/branch?${query}`, "fetchPiNativeBranchPage")
}

export function fetchPiNativeTree(sessionId: string): Promise<Array<Record<string, PiNativeJsonValueV1>>> {
  return getPiJson(`/api/v1/sessions/${encodeURIComponent(sessionId)}/native/tree`, "fetchPiNativeTree")
}

export function piNativeAttachmentUrl(sessionId: string, entryId: string, blockIndex: number): string {
  return `${getApiBase()}/api/v1/sessions/${encodeURIComponent(sessionId)}/native/entries/${encodeURIComponent(entryId)}/attachments/${blockIndex}`
}

export async function fetchExtensionUiSnapshot(sessionId: string): Promise<ExtensionUiSnapshotV1> {
  const res = await fetch(`${getApiBase()}/api/v1/sessions/${encodeURIComponent(sessionId)}/extension-ui`)
  if (!res.ok) throw new Error(`fetchExtensionUiSnapshot ${res.status}`)
  return (await res.json()) as ExtensionUiSnapshotV1
}

export async function respondExtensionUi(
  sessionId: string,
  requestId: string,
  response: ExtensionUiDialogResponseV1,
  workerGeneration?: string,
): Promise<{ accepted: true; alreadySettled: boolean }> {
  const res = await fetch(
    `${getApiBase()}/api/v1/sessions/${encodeURIComponent(sessionId)}/extension-ui/requests/${encodeURIComponent(requestId)}/response`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...response, workerGeneration }),
    },
  )
  if (!res.ok) throw new Error(`respondExtensionUi ${res.status}`)
  return (await res.json()) as { accepted: true; alreadySettled: boolean }
}

export async function setExtensionEditorState(sessionId: string, editorText: string): Promise<ExtensionUiSnapshotV1> {
  const res = await fetch(`${getApiBase()}/api/v1/sessions/${encodeURIComponent(sessionId)}/extension-ui`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ editorText }),
  })
  if (!res.ok) throw new Error(`setExtensionEditorState ${res.status}`)
  return (await res.json()) as ExtensionUiSnapshotV1
}

export function serializeSessionAttachments(attachments: Attachment[]): SessionAttachmentV2[] {
  return attachments.flatMap<SessionAttachmentV2>(attachment => {
    if (attachment.type === "agent" || attachment.type === "command") return []

    if (attachment.type === "folder") {
      if (!attachment.relativePath) throw new Error(`Attachment path missing: ${attachment.displayName}`)
      return [{ type: "directory" as const, path: attachment.relativePath }]
    }

    if (attachment.type === "file" && attachment.relativePath) {
      return [{ type: "file" as const, path: attachment.relativePath }]
    }

    const dataUrl = attachment.url?.match(/^data:([^;,]+);base64,([A-Za-z0-9+/]+={0,2})$/)
    if (attachment.mime?.startsWith("image/") || dataUrl?.[1].startsWith("image/")) {
      if (!dataUrl) throw new Error(`Image data missing: ${attachment.displayName}`)
      return [{
        type: "image" as const,
        mimeType: attachment.mime || dataUrl[1],
        data: dataUrl[2],
        name: attachment.displayName,
      }]
    }

    if (attachment.content !== undefined) {
      return [{ type: "text" as const, text: attachment.content, name: attachment.displayName }]
    }

    if (attachment.type === "text" && dataUrl?.[1].startsWith("text/")) {
      const bytes = Uint8Array.from(atob(dataUrl[2]), character => character.charCodeAt(0))
      return [{ type: "text" as const, text: new TextDecoder().decode(bytes), name: attachment.displayName }]
    }

    throw new Error(`Unsupported Pi attachment: ${attachment.displayName}`)
  })
}

/** Prompt session. stream=true emits WS snapshots. Real driver may call LLM. */
export async function promptSession(
  sessionId: string,
  text: string,
  opts?: {
    stream?: boolean
    model?: { providerID: string; modelID: string }
    attachments?: Attachment[]
    thinkingLevel?: string
    deliverAs?: "steer" | "followUp"
    expandPromptTemplates?: boolean
    commandId?: string
  },
): Promise<AcceptedSessionCommand<"session.prompt" | "session.steer" | "session.followUp">> {
  const command = opts?.deliverAs === "steer"
    ? "steer"
    : opts?.deliverAs === "followUp"
      ? "follow-up"
      : "prompt"
  const res = await piFetch(
    `${getApiBase()}/api/v1/sessions/${encodeURIComponent(sessionId)}/commands/${command}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text,
        attachments: opts?.attachments ? serializeSessionAttachments(opts.attachments) : undefined,
        commandId: opts?.commandId ?? newCommandId(),
        stream: opts?.stream === true,
        model: opts?.model
          ? { provider: opts.model.providerID, id: opts.model.modelID }
          : undefined,
        thinkingLevel: opts?.thinkingLevel,
        expandPromptTemplates: opts?.expandPromptTemplates,
      }),
    },
  )
  if (!res.ok) {
    let detail = String(res.status)
    try {
      const err = (await res.json()) as { message?: string; code?: string }
      detail = err.message || err.code || detail
    } catch {
      /* */
    }
    throw new Error(`promptSession failed: ${detail}`)
  }
  return (await res.json()) as AcceptedSessionCommand<"session.prompt" | "session.steer" | "session.followUp">
}
