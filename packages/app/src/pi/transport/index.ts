import type {
  JsonObject,
  JsonValue,
  HealthResponse,
  ShareInfo,
  PiRegistrySnapshot,
  CommandRecord,
  GitDiffMode,
  GitDiffResponse,
  GitFileDiffResponse,
  GitInfoResponse,
  GitStatusResponse,
  FileCreateRequest,
  FileListResponse,
  FileMoveRequest,
  FileNameSearchResponse,
  FileOperationResponse,
  FileReadResponse,
  FileTextSearchResponse,
  ImageInput,
  FollowUpParams,
  PromptParams,
  SendUserMessageParams,
  SetModelParams,
  SetThinkingLevelParams,
  SteerParams,
  TerminalCreateParams,
  TerminalInfo,
  TerminalUpdateParams,
} from '@piui/protocol'
import type { SessionInfo, SessionTreeNode, Skill } from '@earendil-works/pi-coding-agent'
import type { PiBranchPage, PiConfiguredPackage, PiModelRuntimeSnapshot, PiPackageUpdate, PiProjectTrust, PiProviderAuthInfo, PiSettingsSnapshot, ResolvedPaths } from '../domain/index.js'
import { getApiBase, getPiAuthToken, piFetch } from '../httpClient.js'
import { piCommandStore } from '../state/index.js'

// Response types
export type PiCommandResponse<T = JsonValue | undefined> = {
  data?: T extends undefined ? null : T
  // Serialized commands are accepted with 202 and carry the command record
  // instead of data; the result lands later (poll waitHostCommand).
  command?: CommandRecord
}

export type PiSessionOpenResult = {
  sessionId: string
  sessionFile?: string | null
  cwd?: string
  state?: JsonValue
  [key: string]: JsonValue | undefined
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
export type PiSessionListResult = SessionInfo[]

// Transport layer - raw API calls
export async function fetchHostHealth(signal?: AbortSignal): Promise<HealthResponse> {
  return readJson<HealthResponse>(`${getApiBase()}/api/v1/host/health`, { signal })
}

export async function fetchHostShare(signal?: AbortSignal): Promise<ShareInfo> {
  return readJson<ShareInfo>(`${getApiBase()}/api/v1/host/share`, { signal })
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
  if (response.command) piCommandStore.upsert(response.command)
  return (response.data !== undefined ? response.data : response.command) as T extends undefined ? null : T
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
  if (response.command) piCommandStore.upsert(response.command)
  return (response.data !== undefined ? response.data : response.command) as T extends undefined ? null : T
}

// Host commands (workspaces / files / git), POST /api/v1/host/commands/:name
export async function postHostCommand<T = JsonValue | undefined>(
  name: string,
  params?: JsonObject,
  signal?: AbortSignal,
): Promise<T> {
  const response = await readJson<{ data: T }>(
    `${getApiBase()}/api/v1/host/commands/${encodeURIComponent(name)}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params ?? {}),
      signal,
    },
  )
  return response.data
}

// Host git commands (git.*), workspace-scoped
export function getHostGitInfo(workspacePath: string, signal?: AbortSignal): Promise<GitInfoResponse> {
  return postHostCommand('git.info', { workspacePath }, signal)
}

export function getHostGitStatus(workspacePath: string, signal?: AbortSignal): Promise<GitStatusResponse> {
  return postHostCommand('git.status', { workspacePath }, signal)
}

export function getHostGitDiff(workspacePath: string, mode: GitDiffMode, signal?: AbortSignal): Promise<GitDiffResponse> {
  return postHostCommand('git.diff', { workspacePath, mode }, signal)
}

export function getHostGitFileDiff(workspacePath: string, path: string, mode: GitDiffMode, signal?: AbortSignal): Promise<GitFileDiffResponse> {
  return postHostCommand('git.fileDiff', { workspacePath, path, mode }, signal)
}

// Host file commands (files.*), workspace-scoped
export function listHostFiles(
  workspacePath: string,
  params?: { path?: string; limit?: number; cursor?: string },
  signal?: AbortSignal,
): Promise<FileListResponse> {
  return postHostCommand('files.list', { workspacePath, ...params }, signal)
}

export function readHostFile(workspacePath: string, path: string, signal?: AbortSignal): Promise<FileReadResponse> {
  return postHostCommand('files.read', { workspacePath, path }, signal)
}

export function writeHostFile(
  workspacePath: string,
  path: string,
  content: string,
  options?: { ifMatch?: string; encoding?: 'utf-8' | 'base64' },
  signal?: AbortSignal,
): Promise<FileReadResponse> {
  return postHostCommand('files.write', { workspacePath, path, content, ...options }, signal)
}

export function createHostFileEntry(workspacePath: string, request: FileCreateRequest, signal?: AbortSignal): Promise<FileOperationResponse> {
  return postHostCommand('files.create', { workspacePath, ...request }, signal)
}

export function moveHostFileEntry(workspacePath: string, request: FileMoveRequest, signal?: AbortSignal): Promise<FileOperationResponse> {
  return postHostCommand('files.move', { workspacePath, ...request }, signal)
}

export function deleteHostFileEntry(workspacePath: string, path: string, recursive = false, signal?: AbortSignal): Promise<{ ok: boolean }> {
  return postHostCommand('files.delete', { workspacePath, path, recursive }, signal)
}

export function searchHostFilesByName(
  workspacePath: string,
  query: string,
  options?: { type?: 'file' | 'directory'; limit?: number },
  signal?: AbortSignal,
): Promise<FileNameSearchResponse> {
  return postHostCommand('files.searchName', { workspacePath, query, ...options }, signal)
}

export function searchHostFilesText(workspacePath: string, query: string, limit?: number, signal?: AbortSignal): Promise<FileTextSearchResponse> {
  return postHostCommand('files.searchText', { workspacePath, query, limit }, signal)
}

// Host terminal commands. Terminal output itself uses a dedicated WebSocket stream.
export function listHostTerminals(workspacePath: string, signal?: AbortSignal): Promise<{ terminals: TerminalInfo[] }> {
  return postHostCommand('terminals.list', { workspacePath }, signal)
}

export function createHostTerminal(
  workspacePath: string,
  params: TerminalCreateParams = {},
  signal?: AbortSignal,
): Promise<TerminalInfo> {
  return postHostCommand('terminals.create', { workspacePath, ...params }, signal)
}

export function updateHostTerminal(
  workspacePath: string,
  terminalId: string,
  params: TerminalUpdateParams,
  signal?: AbortSignal,
): Promise<TerminalInfo> {
  return postHostCommand('terminals.update', { workspacePath, terminalId, ...params }, signal)
}

export function removeHostTerminal(workspacePath: string, terminalId: string, signal?: AbortSignal): Promise<{ ok: boolean }> {
  return postHostCommand('terminals.remove', { workspacePath, terminalId }, signal)
}

export function issueHostTerminalToken(workspacePath: string, terminalId: string, signal?: AbortSignal): Promise<{ token: string; expiresIn: number }> {
  return postHostCommand('terminals.connectToken', { workspacePath, terminalId }, signal)
}

export function getHostTerminalWebSocketUrl(terminalId: string, ticket: string, cursor?: number): string {
  const base = getApiBase() || (typeof window !== 'undefined' ? window.location.origin : 'http://127.0.0.1:8787')
  const url = new URL(`${base.replace(/^http/, 'ws')}/api/v1/host/terminals/${encodeURIComponent(terminalId)}/stream`)
  url.searchParams.set('ticket', ticket)
  if (cursor !== undefined && Number.isSafeInteger(cursor) && cursor >= 0) url.searchParams.set('cursor', String(cursor))
  const token = getPiAuthToken()
  if (token && getApiBase()) url.searchParams.set('token', token)
  return url.toString()
}

// Global Pi commands (settings / trust / providers / model runtime / packages)
export function getPiSettings(cwd: string, signal?: AbortSignal): Promise<PiSettingsSnapshot> {
  return postPiGlobalCommand('settings.get', { cwd }, signal)
}

export function patchPiSettings(cwd: string, patch: JsonObject, signal?: AbortSignal): Promise<PiSettingsSnapshot> {
  return postPiGlobalCommand('settings.patch', { cwd, patch }, signal)
}

export function getProjectTrust(cwd: string, signal?: AbortSignal): Promise<PiProjectTrust> {
  return postPiGlobalCommand('trust.get', { cwd }, signal)
}

export function setProjectTrust(cwd: string, decision: boolean | null, signal?: AbortSignal): Promise<PiProjectTrust> {
  return postPiGlobalCommand('trust.set', { cwd, decision }, signal)
}

export function listPiProviders(signal?: AbortSignal): Promise<PiProviderAuthInfo[]> {
  return postPiGlobalCommand('providers.list', undefined, signal)
}

export function startProviderAuth(providerId: string, authType?: 'api_key' | 'oauth', signal?: AbortSignal): Promise<{ flowId: string }> {
  return postPiGlobalCommand('providers.startAuth', { providerId, authType }, signal)
}

export function respondProviderAuth(flowId: string, promptId: string, value: string, signal?: AbortSignal): Promise<JsonValue> {
  return postPiGlobalCommand('providers.respondAuth', { flowId, promptId, value }, signal)
}

export function cancelProviderAuth(flowId: string, signal?: AbortSignal): Promise<JsonValue> {
  return postPiGlobalCommand('providers.cancelAuth', { flowId }, signal)
}

export function logoutProvider(providerId: string, signal?: AbortSignal): Promise<JsonValue> {
  return postPiGlobalCommand('providers.logout', { providerId }, signal)
}

export function inspectModelRuntime(signal?: AbortSignal): Promise<PiModelRuntimeSnapshot> {
  return postPiGlobalCommand('modelRuntime.inspect', undefined, signal)
}

export function setProviderApiKey(providerId: string, apiKey: string, signal?: AbortSignal): Promise<JsonValue> {
  return postPiGlobalCommand('modelRuntime.setApiKey', { providerId, apiKey }, signal)
}

export function removeProviderApiKey(providerId: string, signal?: AbortSignal): Promise<JsonValue> {
  return postPiGlobalCommand('modelRuntime.removeApiKey', { providerId }, signal)
}

export function reloadModelRuntime(signal?: AbortSignal): Promise<JsonValue> {
  return postPiGlobalCommand('modelRuntime.reload', undefined, signal)
}

export function refreshModelRuntime(options?: JsonObject, signal?: AbortSignal): Promise<JsonValue> {
  return postPiGlobalCommand('modelRuntime.refresh', options ? { options } : undefined, signal)
}

export function listPiPackages(cwd: string, signal?: AbortSignal): Promise<PiConfiguredPackage[]> {
  return postPiGlobalCommand('packages.list', { cwd }, signal)
}

export function managePiPackage(
  cwd: string,
  params: { commandId?: string; action: 'install' | 'remove' | 'update'; source?: string; local?: boolean; persist?: boolean },
  signal?: AbortSignal,
): Promise<PiConfiguredPackage[]> {
  return postPiGlobalCommand('packages.manage', { cwd, ...params }, signal)
}

export function resolvePiPackages(cwd: string, missingAction?: 'install' | 'skip' | 'error', signal?: AbortSignal): Promise<ResolvedPaths> {
  return postPiGlobalCommand('packages.resolve', { cwd, missingAction }, signal)
}

export function resolvePiExtensionSources(
  cwd: string,
  sources: string[],
  options?: { local?: boolean; temporary?: boolean },
  signal?: AbortSignal,
): Promise<ResolvedPaths> {
  return postPiGlobalCommand('packages.resolveSources', { cwd, sources, ...options }, signal)
}

export function changePiPackageSource(cwd: string, source: string, operation: 'add' | 'remove', local?: boolean, signal?: AbortSignal): Promise<{ changed: boolean; packages: PiConfiguredPackage[] }> {
  return postPiGlobalCommand('packages.changeSource', { cwd, source, operation, local }, signal)
}

export function getPiPackageInstalledPath(cwd: string, source: string, scope?: 'user' | 'project', signal?: AbortSignal): Promise<string | null> {
  return postPiGlobalCommand('packages.installedPath', { cwd, source, scope }, signal)
}

export function checkPiPackageUpdates(cwd: string, signal?: AbortSignal): Promise<PiPackageUpdate[]> {
  return postPiGlobalCommand('packages.checkUpdates', { cwd }, signal)
}
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

// Catalog commands
export function listPiModels(signal?: AbortSignal): Promise<JsonValue> {
  return postPiGlobalCommand<JsonValue>('models.list', undefined, signal)
}

// State commands
export function getPiSessionState(sessionId: string, signal?: AbortSignal): Promise<JsonValue> {
  return postPiSessionCommand(sessionId, 'state.get', undefined, signal)
}

export function getPiBranchPage(sessionId: string, params: PiBranchGetParams, signal?: AbortSignal): Promise<PiBranchPage> {
  return postPiSessionCommand(sessionId, 'branch.get', params, signal)
}

export function getPiTree(sessionId: string, signal?: AbortSignal): Promise<SessionTreeNode[]> {
  return postPiSessionCommand(sessionId, 'tree.get', undefined, signal)
}

export function getPiSessionRegistry(sessionId: string, signal?: AbortSignal): Promise<JsonValue> {
  return postPiSessionCommand(sessionId, 'registry.get', undefined, signal)
}

export function getPiSkills(sessionId: string, signal?: AbortSignal): Promise<Skill[]> {
  return postPiSessionCommand(sessionId, 'skills.list', undefined, signal)
}

// Action commands
export function promptPi(sessionId: string, params: PromptParams, signal?: AbortSignal): Promise<CommandRecord> {
  return postPiSessionCommand(sessionId, 'prompt', params, signal)
}

export function steerPi(sessionId: string, params: SteerParams, signal?: AbortSignal): Promise<CommandRecord> {
  return postPiSessionCommand(sessionId, 'steer', params, signal)
}

export function followUpPi(sessionId: string, params: FollowUpParams, signal?: AbortSignal): Promise<CommandRecord> {
  return postPiSessionCommand(sessionId, 'followUp', params, signal)
}

export function abortPi(sessionId: string, signal?: AbortSignal): Promise<CommandRecord> {
  return postPiSessionCommand(sessionId, 'abort', undefined, signal)
}

export function compactPi(sessionId: string, customInstructions?: string, signal?: AbortSignal): Promise<CommandRecord> {
  return postPiSessionCommand(sessionId, 'compact', customInstructions ? { customInstructions } : undefined, signal)
}

export function reloadPiSession(sessionId: string, signal?: AbortSignal): Promise<CommandRecord> {
  return postPiSessionCommand(sessionId, 'reload', undefined, signal)
}

export function newPiSession(sessionId: string, parentSession?: string, signal?: AbortSignal): Promise<CommandRecord> {
  return postPiSessionCommand(sessionId, 'newSession', parentSession ? { parentSession } : undefined, signal)
}

export function setPiScopedModels(sessionId: string, patterns: string[], signal?: AbortSignal): Promise<CommandRecord> {
  return postPiSessionCommand(sessionId, 'setScopedModels', { patterns }, signal)
}

export function executePiBash(sessionId: string, command: string, excludeFromContext?: boolean, signal?: AbortSignal): Promise<CommandRecord> {
  return postPiSessionCommand(sessionId, 'bash', { command, excludeFromContext }, signal)
}

export function abortPiBash(sessionId: string, signal?: AbortSignal): Promise<JsonValue> {
  return postPiSessionCommand(sessionId, 'abortBash', undefined, signal)
}

export function exportPiSessionHtml(sessionId: string, outputPath?: string, signal?: AbortSignal): Promise<CommandRecord> {
  return postPiSessionCommand(sessionId, 'exportHtml', outputPath ? { outputPath } : undefined, signal)
}

export function exportPiSessionJsonl(sessionId: string, outputPath?: string, signal?: AbortSignal): Promise<CommandRecord> {
  return postPiSessionCommand(sessionId, 'exportJsonl', outputPath ? { outputPath } : undefined, signal)
}

export function waitPiForIdle(sessionId: string, signal?: AbortSignal): Promise<CommandRecord> {
  return postPiSessionCommand(sessionId, 'waitForIdle', undefined, signal)
}

export type PiCustomMessageContent = Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>

export function sendPiCustomMessage(
  sessionId: string,
  params: {
    customType: string
    content: PiCustomMessageContent
    display: boolean
    details?: JsonValue
    triggerTurn?: boolean
    deliverAs?: 'steer' | 'followUp' | 'nextTurn'
  },
  signal?: AbortSignal,
): Promise<CommandRecord> {
  return postPiSessionCommand(sessionId, 'sendCustomMessage', params as unknown as JsonObject, signal)
}

export function appendPiCustomEntry(sessionId: string, customType: string, data: JsonValue, signal?: AbortSignal): Promise<CommandRecord> {
  return postPiSessionCommand(sessionId, 'appendCustomEntry', { customType, data: data === undefined ? null : data }, signal)
}

export type PiImageInput = ImageInput

export function sendPiUserMessage(
  sessionId: string,
  params: SendUserMessageParams,
  signal?: AbortSignal,
): Promise<CommandRecord> {
  return postPiSessionCommand(sessionId, 'sendUserMessage', params as unknown as JsonObject, signal)
}

export function setPiSessionName(sessionId: string, name: string, signal?: AbortSignal): Promise<CommandRecord> {
  return postPiSessionCommand(sessionId, 'setSessionName', { name }, signal)
}

export function respondPiExtensionUi(
  sessionId: string,
  requestId: string,
  response: JsonObject,
  signal?: AbortSignal,
): Promise<CommandRecord> {
  return postPiSessionCommand(sessionId, 'respondExtensionUi', { requestId, response }, signal)
}

export function setPiExtensionEditorState(sessionId: string, text: string, signal?: AbortSignal): Promise<CommandRecord> {
  return postPiSessionCommand(sessionId, 'setExtensionEditorState', { text }, signal)
}

export type PiForkResult = {
  operation?: string
  sourceSessionId?: string
  targetSessionId?: string
  targetSessionFile?: string | null
  targetCwd?: string
  cancelled?: boolean
  [key: string]: JsonValue | undefined
}

export function forkPiSession(
  sessionId: string,
  params: { entryId: string; position?: 'before' | 'at' },
  signal?: AbortSignal,
): Promise<CommandRecord> {
  return postPiSessionCommand(sessionId, 'fork', params as unknown as JsonObject, signal)
}

export type PiNavigateTreeParams = {
  entryId: string
  summarize?: boolean
  customInstructions?: string
  replaceInstructions?: boolean
  label?: string
}

export type PiNavigateTreeResult = {
  editorText?: string | null
  cancelled?: boolean
  aborted?: boolean
}

export function navigatePiTree(sessionId: string, params: PiNavigateTreeParams, signal?: AbortSignal): Promise<CommandRecord> {
  return postPiSessionCommand(sessionId, 'navigateTree', params as unknown as JsonObject, signal)
}


export function importPiSession(sessionId: string, inputPath: string, cwdOverride?: string, signal?: AbortSignal): Promise<CommandRecord> {
  return postPiSessionCommand(sessionId, 'importSession', { inputPath, cwdOverride }, signal)
}

export function setPiLabel(sessionId: string, entryId: string, label?: string, signal?: AbortSignal): Promise<CommandRecord> {
  return postPiSessionCommand(sessionId, 'setLabel', { entryId, label }, signal)
}

export function setPiActiveTools(sessionId: string, toolNames: string[], signal?: AbortSignal): Promise<CommandRecord> {
  return postPiSessionCommand(sessionId, 'setActiveTools', { toolNames }, signal)
}

export function setPiAutoCompaction(sessionId: string, enabled: boolean, signal?: AbortSignal): Promise<CommandRecord> {
  return postPiSessionCommand(sessionId, 'setAutoCompaction', { enabled }, signal)
}

export function setPiAutoRetry(sessionId: string, enabled: boolean, signal?: AbortSignal): Promise<CommandRecord> {
  return postPiSessionCommand(sessionId, 'setAutoRetry', { enabled }, signal)
}

// Immediate runtime commands (200 data responses)
export function abortPiCompaction(sessionId: string, signal?: AbortSignal): Promise<JsonValue> {
  return postPiSessionCommand(sessionId, 'abortCompaction', undefined, signal)
}

export function abortPiBranchSummary(sessionId: string, signal?: AbortSignal): Promise<JsonValue> {
  return postPiSessionCommand(sessionId, 'abortBranchSummary', undefined, signal)
}

export function abortPiRetry(sessionId: string, signal?: AbortSignal): Promise<JsonValue> {
  return postPiSessionCommand(sessionId, 'abortRetry', undefined, signal)
}

export function clearPiQueue(sessionId: string, signal?: AbortSignal): Promise<JsonValue> {
  return postPiSessionCommand(sessionId, 'clearQueue', undefined, signal)
}

export function setPiSteeringMode(sessionId: string, mode: 'all' | 'one-at-a-time', signal?: AbortSignal): Promise<JsonValue> {
  return postPiSessionCommand(sessionId, 'setSteeringMode', { mode }, signal)
}

export function setPiFollowUpMode(sessionId: string, mode: 'all' | 'one-at-a-time', signal?: AbortSignal): Promise<JsonValue> {
  return postPiSessionCommand(sessionId, 'setFollowUpMode', { mode }, signal)
}

/**
 * Poll a submitted command until it completes/fails (serialized commands
 * like fork return 'accepted' immediately; the result lands later).
 */
export async function waitHostCommand(commandId: string, signal?: AbortSignal, timeoutMs = 30_000): Promise<JsonValue> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const record = await readJson<{ command: CommandRecord }>(
      `${getApiBase()}/api/v1/host/commands/${encodeURIComponent(commandId)}`,
      { signal },
    )
    const status = record.command.status
    if (status === 'completed') return record.command.result ?? null
    if (status === 'failed') {
      throw Object.assign(new Error(record.command.error?.message ?? 'Command failed'), {
        code: record.command.error?.code,
      })
    }
    if (status === 'cancelled' || status === 'unknown_after_crash') {
      throw Object.assign(new Error(record.command.error?.message ?? `Command ${status}`), {
        code: record.command.error?.code ?? 'SESSION_RUNTIME_CRASHED',
        retryable: record.command.error?.retryable,
      })
    }
    if (Date.now() > deadline) throw new Error('Command timed out')
    await new Promise(resolve => setTimeout(resolve, 200))
  }
}

// Model commands
export function setPiModel(sessionId: string, params: SetModelParams, signal?: AbortSignal): Promise<CommandRecord> {
  return postPiSessionCommand(sessionId, 'setModel', params, signal)
}

export function cyclePiModel(sessionId: string, direction?: 'forward' | 'backward', signal?: AbortSignal): Promise<CommandRecord> {
  return postPiSessionCommand(sessionId, 'cycleModel', direction ? { direction } : undefined, signal)
}

export function setPiThinkingLevel(sessionId: string, params: SetThinkingLevelParams, signal?: AbortSignal): Promise<CommandRecord> {
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
