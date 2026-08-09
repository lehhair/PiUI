import type { CommandRecord, ExtensionUiDialogResponse, JsonObject, JsonValue, RegistrySnapshot, CommandDescriptor, ToolDescriptor } from '@piui/protocol'
import type { SessionInfo } from '@earendil-works/pi-coding-agent'
import type { Model } from '@earendil-works/pi-ai'
import * as transport from '../transport/index.js'
import { piSessionInfoStore, piBranchStore, piSessionStateStore, piModelsStore } from '../state/index.js'
import { mergeLatestBranchPage } from '../branchMerge.js'
import { serverStore } from '../../store/serverStore'
import type { PiBranchPage } from '../domain/index.js'

/**
 * Load a session's native slash commands (extension commands, prompt
 * templates, skills) from the runtime registry.
 */
export async function loadPiSlashCommands(sessionId: string, signal?: AbortSignal): Promise<CommandDescriptor[]> {
  const registry = (await transport.getPiSessionRegistry(sessionId, signal)) as RegistrySnapshot | undefined
  return registry?.commands ?? []
}

/**
 * Load a session's native tool descriptors from the runtime registry.
 */
export async function loadPiSessionTools(sessionId: string, signal?: AbortSignal): Promise<ToolDescriptor[]> {
  const registry = (await transport.getPiSessionRegistry(sessionId, signal)) as RegistrySnapshot | undefined
  return registry?.tools ?? []
}

/**
 * Load all Pi sessions globally.
 */
export async function loadPiSessions(signal?: AbortSignal): Promise<SessionInfo[]> {
  const serverGeneration = serverStore.getActiveServerGeneration()
  const sessions = await retryUnavailable(() => transport.listAllPiSessions(signal), signal)
  if (serverStore.getActiveServerGeneration() !== serverGeneration) return sessions
  piSessionInfoStore.replaceAll(sessions)
  return sessions
}

/**
 * Load Pi sessions for specific working directory.
 */
export async function loadPiSessionsForCwd(cwd: string, signal?: AbortSignal): Promise<SessionInfo[]> {
  const serverGeneration = serverStore.getActiveServerGeneration()
  const sessions = await retryUnavailable(() => transport.listPiSessions({ cwd }, signal), signal)
  if (serverStore.getActiveServerGeneration() !== serverGeneration) return sessions
  piSessionInfoStore.replaceForCwd(cwd, sessions)
  return sessions
}

/**
 * Delete a Pi session file.
 */
export async function deletePiSession(cwd: string, sessionFile: string, signal?: AbortSignal): Promise<void> {
  await transport.deletePiSession(cwd, sessionFile, signal)
}

/**
 * Open a Pi session and load its initial data.
 */
export async function openPiSession(
  cwd: string,
  sessionFile?: string,
  signal?: AbortSignal,
  reuseFromSessionId?: string,
): Promise<transport.PiSessionOpenResult> {
  const result = await transport.openPiSession({ cwd, sessionFile, reuseFromSessionId }, signal)

  if (!result.sessionId) {
    throw new Error('Session open failed: no sessionId returned')
  }

  if (result.sessionFile && result.sessionFileReady !== false) {
    // Existing sessions have a persisted file and can be previewed immediately.
    await loadPiSessionData(result.sessionId, signal)
  } else {
    // A fresh Pi runtime has no session file until its first entry is written.
    // Use the state returned by session.open instead of previewing a path that
    // does not exist yet.
    const state = result.state && typeof result.state === 'object' && !Array.isArray(result.state)
      ? result.state as JsonObject
      : undefined
    if (state) piSessionStateStore.setState(result.sessionId, state)
    piBranchStore.setData(result.sessionId, {
      head: (state?.head ?? {
        sdkVersion: 'unknown',
        revision: 0,
        header: null,
        leafId: null,
        entryCount: 0,
        epoch: `fresh:${result.sessionId}`,
      }) as PiBranchPage['head'],
      items: [],
      hasMore: false,
    })
  }

  return result
}

export function createPiSession(cwd: string, signal?: AbortSignal): Promise<transport.PiSessionCreateResult> {
  return transport.createPiSession(cwd, signal)
}

/**
 * Load session data (state + branch) for active session.
 */
const sessionDataFlights = new Map<string, Promise<void>>()
const BRANCH_PAGE_LIMIT = 100
const BRANCH_PAGE_MAX_BYTES = 2 * 1024 * 1024

export async function loadPiSessionData(sessionId: string, signal?: AbortSignal): Promise<void> {
  const generation = serverStore.getActiveServerGeneration()
  const flightKey = `${generation}:${sessionId}`
  const existing = sessionDataFlights.get(flightKey)
  if (existing) return existing

  const flight = loadPiSessionDataOnce(sessionId, signal).finally(() => {
    if (sessionDataFlights.get(flightKey) === flight) sessionDataFlights.delete(flightKey)
  })
  sessionDataFlights.set(flightKey, flight)
  return flight
}

async function loadPiSessionDataOnce(sessionId: string, signal?: AbortSignal): Promise<void> {
  const serverGeneration = serverStore.getActiveServerGeneration()
  let lastError: unknown
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
        const preview = await retryUnavailable(() => transport.previewPiSession(
          sessionId,
          { limit: BRANCH_PAGE_LIMIT, maxBytes: BRANCH_PAGE_MAX_BYTES },
          signal,
        ), signal)

      if (serverStore.getActiveServerGeneration() !== serverGeneration) return
      piSessionStateStore.setState(sessionId, preview.state)
      piBranchStore.setData(sessionId, preview.branch)
      return
    } catch (error) {
      lastError = error
      if (!isSessionBusyError(error) && !isTransientServerError(error)) break
      if (attempt === 2) break
      await waitForRetry(150 * (attempt + 1), undefined)
    }
  }

  if (serverStore.getActiveServerGeneration() !== serverGeneration) return
  console.error('Failed to load session data:', lastError)
  piSessionStateStore.setError(sessionId, lastError as Error)
  piBranchStore.setError(sessionId, lastError as Error)
  throw lastError
}

function isSessionBusyError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as { code?: unknown }).code === 'SESSION_BUSY')
}

function isTransientServerError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const candidate = error as { status?: unknown; code?: unknown }
  return candidate.status === 502 || candidate.status === 503 || candidate.status === 504
    || candidate.code === 'BACKEND_UNAVAILABLE'
    || candidate.code === 'WORKER_RESULT_UNKNOWN'
}

async function waitForRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw signal.reason ?? new DOMException('The operation was aborted', 'AbortError')
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, delayMs)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal?.reason ?? new DOMException('The operation was aborted', 'AbortError'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

async function retryUnavailable<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await operation()
    } catch (error) {
      lastError = error
      if (!isTransientServerError(error) || attempt === 2) throw error
      await waitForRetry(250 * 2 ** attempt, signal)
    }
  }
  throw lastError
}

/**
 * Load more branch entries (pagination).
 * Pages grow backwards: beforeCursor anchors the oldest entry of the current
 * page, so older items must be PREPENDED. checkpoint only exists on the
 * first (latest) page — preserve it when merging older pages.
 */
export async function loadMorePiBranchEntries(sessionId: string, signal?: AbortSignal): Promise<void> {
  const currentBranch = piBranchStore.getData(sessionId)
  if (!currentBranch) {
    throw new Error('No branch data loaded')
  }

  if (!currentBranch.hasMore || !currentBranch.beforeCursor) {
    return // No more data
  }
  const serverGeneration = serverStore.getActiveServerGeneration()

  try {
    const olderPage = await transport.getPiBranchPage(
      sessionId,
      { cursor: currentBranch.beforeCursor, limit: BRANCH_PAGE_LIMIT, maxBytes: BRANCH_PAGE_MAX_BYTES },
      signal,
    )

    if (serverStore.getActiveServerGeneration() !== serverGeneration || piBranchStore.getData(sessionId) !== currentBranch) return

    // Prepend older items; keep latest head/hasMore/cursor from the new page
    piBranchStore.setData(sessionId, {
      ...olderPage,
      checkpoint: currentBranch.checkpoint,
      items: [...olderPage.items, ...currentBranch.items],
    })
  } catch (error) {
    const code = (error as { code?: string })?.code
    if (code === 'INVALID_REQUEST' || code === 'STALE_CURSOR') {
      // 光标已失效（worker 重启后密钥变化，或会话被替换/重载）。停掉分页并
      // 重载首页拿新光标，否则每次滚动都会拿同一个坏光标重试、无限刷 400。
      piBranchStore.setData(sessionId, {
        ...currentBranch,
        beforeCursor: undefined,
        hasMore: false,
      })
      void refreshPiBranch(sessionId).catch(() => undefined)
      return
    }
    console.error('Failed to load more branch entries:', error)
    throw error
  }
}

/**
 * Refresh branch with the latest page, merging local pagination history.
 * Used by the event stream when head revision changes.
 */
export async function refreshPiBranch(sessionId: string, signal?: AbortSignal): Promise<void> {
  const serverGeneration = serverStore.getActiveServerGeneration()
  const latest = await transport.getPiBranchPage(sessionId, { limit: BRANCH_PAGE_LIMIT, maxBytes: BRANCH_PAGE_MAX_BYTES }, signal)
  if (serverStore.getActiveServerGeneration() !== serverGeneration) return
  piBranchStore.setData(sessionId, mergeLatestBranchPage(piBranchStore.getData(sessionId), latest))
}

/**
 * Refresh runtime state only.
 * Used by the event stream when state-only events arrive.
 */
export async function refreshPiSessionState(sessionId: string, signal?: AbortSignal): Promise<void> {
  const serverGeneration = serverStore.getActiveServerGeneration()
  const state = await transport.getPiSessionState(sessionId, signal)
  if (serverStore.getActiveServerGeneration() !== serverGeneration) return
  piSessionStateStore.setState(sessionId, state as JsonObject)
}

/**
 * Send a prompt to Pi session.
 */
export async function sendPiPrompt(
  sessionId: string,
  text: string,
  options?: { streamingBehavior?: 'steer' | 'followUp' },
  signal?: AbortSignal,
): Promise<void> {
  try {
    await transport.promptPi(sessionId, { text, streamingBehavior: options?.streamingBehavior }, signal)
    // State will be updated via events
  } catch (error) {
    console.error('Failed to send prompt:', error)
    throw error
  }
}

/**
 * Compact the session context (native /compact). Serialized — submit, then
 * wait for completion so callers can resolve pending UI.
 */
export async function compactPiSession(sessionId: string, customInstructions?: string, signal?: AbortSignal): Promise<JsonValue> {
  try {
    const submitted = await transport.compactPi(sessionId, customInstructions, signal)
    // 压缩经常超过默认 30s 的 waitHostCommand 超时（会误报 Command timed out，
    // 但压缩其实还在跑）。给它 15 分钟，让结果由 compaction_end 事件/轮询正常落地。
    return await transport.waitHostCommand(submitted.id, signal, 15 * 60_000)
  } catch (error) {
    console.error('Failed to compact session:', error)
    throw error
  }
}

/**
 * Reload runtime resources (extensions, skills, prompts, themes). Serialized
 * — submit, then wait for completion.
 */
export async function reloadPiSessionResources(sessionId: string, signal?: AbortSignal): Promise<void> {
  const submitted = await transport.reloadPiSession(sessionId, signal)
  await transport.waitHostCommand(submitted.id, signal)
}

/**
 * Load the session's full runtime registry (tools, commands, extensions,
 * event handlers).
 */
export async function loadPiSessionRegistry(sessionId: string, signal?: AbortSignal): Promise<RegistrySnapshot | undefined> {
  return (await transport.getPiSessionRegistry(sessionId, signal)) as RegistrySnapshot | undefined
}

/** Submit a serialized session command and wait for its result. */
async function submitAndWait(submit: () => Promise<CommandRecord>, signal?: AbortSignal): Promise<JsonValue> {
  const submitted = await submit()
  return transport.waitHostCommand(submitted.id, signal)
}

/** Create a new native session from the current runtime (replacement). */
export async function newPiSessionFrom(sessionId: string, signal?: AbortSignal): Promise<transport.PiForkResult> {
  return (await submitAndWait(() => transport.newPiSession(sessionId, sessionId), signal) ?? {}) as transport.PiForkResult
}

export async function cyclePiModel(sessionId: string, direction?: 'forward' | 'backward', signal?: AbortSignal): Promise<void> {
  await submitAndWait(() => transport.cyclePiModel(sessionId, direction, signal), signal)
}

export async function cyclePiThinkingLevel(sessionId: string, signal?: AbortSignal): Promise<void> {
  await submitAndWait(() => transport.cyclePiThinkingLevel(sessionId, signal), signal)
}

export async function setPiScopedModels(sessionId: string, patterns: string[], signal?: AbortSignal): Promise<void> {
  await submitAndWait(() => transport.setPiScopedModels(sessionId, patterns, signal), signal)
}

/** Run a one-shot bash command; resolves with the native result. */
export async function executePiBash(sessionId: string, command: string, excludeFromContext?: boolean, clientId?: string, signal?: AbortSignal): Promise<JsonValue> {
  return submitAndWait(() => transport.executePiBash(sessionId, command, excludeFromContext, clientId, signal), signal)
}

export async function abortPiBashExecution(sessionId: string, signal?: AbortSignal): Promise<void> {
  await transport.abortPiBash(sessionId, signal)
}

/** Export the session; resolves with the native result (output path etc.). */
export async function exportPiSession(sessionId: string, format: 'html' | 'jsonl', outputPath: string, signal?: AbortSignal): Promise<JsonValue> {
  const submit = format === 'html'
    ? () => transport.exportPiSessionHtml(sessionId, outputPath, signal)
    : () => transport.exportPiSessionJsonl(sessionId, outputPath, signal)
  return submitAndWait(submit, signal)
}

export async function waitForPiIdle(sessionId: string, signal?: AbortSignal): Promise<void> {
  await submitAndWait(() => transport.waitPiForIdle(sessionId, signal), signal)
}

export async function sendPiCustomMessage(
  sessionId: string,
  params: Parameters<typeof transport.sendPiCustomMessage>[1],
  signal?: AbortSignal,
): Promise<void> {
  await submitAndWait(() => transport.sendPiCustomMessage(sessionId, params, signal), signal)
}

export async function appendPiCustomEntry(sessionId: string, customType: string, data: JsonValue, signal?: AbortSignal): Promise<void> {
  await submitAndWait(() => transport.appendPiCustomEntry(sessionId, customType, data, signal), signal)
}

/**
 * Send steering input to Pi session.
 */
export async function sendPiSteer(sessionId: string, text: string, signal?: AbortSignal): Promise<void> {
  try {
    await transport.steerPi(sessionId, { text }, signal)
  } catch (error) {
    console.error('Failed to send steer:', error)
    throw error
  }
}

/**
 * Send follow-up input to Pi session.
 */
export async function sendPiFollowUp(sessionId: string, text: string, signal?: AbortSignal): Promise<void> {
  try {
    await transport.followUpPi(sessionId, { text }, signal)
  } catch (error) {
    console.error('Failed to send follow-up:', error)
    throw error
  }
}

/**
 * Send a user message through the unified native entry (sendUserMessage).
 * deliverAs: 'steer' interrupts the current turn, 'followUp' queues after
 * it; omit when idle. Images are native ImageContent blocks.
 */
export async function sendPiUserMessage(
  sessionId: string,
  text: string,
  images?: transport.PiImageInput[],
  deliverAs?: 'steer' | 'followUp',
  signal?: AbortSignal,
): Promise<void> {
  await transport.sendPiUserMessage(sessionId, { text, images, deliverAs }, signal)
}

/**
 * Abort current Pi operation.
 */
export async function abortPiOperation(sessionId: string, signal?: AbortSignal): Promise<void> {
  try {
    await transport.abortPi(sessionId, signal)
  } catch (error) {
    console.error('Failed to abort operation:', error)
    throw error
  }
}

/**
 * Set Pi model.
 */
export async function setPiModel(sessionId: string, provider: string, modelId: string, signal?: AbortSignal): Promise<void> {
  try {
    await submitAndWait(() => transport.setPiModel(sessionId, { provider, modelId }, signal), signal)
  } catch (error) {
    console.error('Failed to set model:', error)
    throw error
  }
}

/**
 * Set Pi thinking level.
 */
export async function setPiThinkingLevel(sessionId: string, level: string, signal?: AbortSignal): Promise<void> {
  try {
    await submitAndWait(() => transport.setPiThinkingLevel(sessionId, { level }, signal), signal)
  } catch (error) {
    console.error('Failed to set thinking level:', error)
    throw error
  }
}

/**
 * Rename a Pi session.
 */
export async function renamePiSession(sessionId: string, name: string, signal?: AbortSignal): Promise<void> {
  // 序列化命令，等它真正执行完——否则调用方紧接着刷新列表读到的还是旧名字
  const submitted = await transport.setPiSessionName(sessionId, name, signal)
  await transport.waitHostCommand(submitted.id, signal)
}

/**
 * Respond to an extension UI dialog request.
 */
export async function respondPiExtensionUi(
  sessionId: string,
  requestId: string,
  response: ExtensionUiDialogResponse,
  signal?: AbortSignal,
): Promise<void> {
  await transport.respondPiExtensionUi(sessionId, requestId, response, signal)
}

/**
 * Send editor text state to extensions (composer content sync).
 */
export async function setPiExtensionEditorState(sessionId: string, text: string, signal?: AbortSignal): Promise<void> {
  await transport.setPiExtensionEditorState(sessionId, text, signal)
}

/**
 * Fork the session at an entry (native fork: new session file, runtime
 * switches to it). fork is a serialized command — submit, then wait for
 * the result carrying targetSessionId.
 */
export async function forkPiSession(
  sessionId: string,
  entryId: string,
  position: 'before' | 'at' = 'at',
  signal?: AbortSignal,
): Promise<transport.PiForkResult> {
  const submitted = await transport.forkPiSession(sessionId, { entryId, position }, signal)
  const result = await transport.waitHostCommand(submitted.id, signal)
  return (result ?? {}) as transport.PiForkResult
}

/**
 * Navigate the session tree to an entry (branch switch / undo). Serialized —
 * submit, then wait for the result carrying editorText/cancelled.
 */
export async function navigatePiTree(
  sessionId: string,
  params: transport.PiNavigateTreeParams,
  signal?: AbortSignal,
): Promise<transport.PiNavigateTreeResult> {
  const submitted = await transport.navigatePiTree(sessionId, params, signal)
  const result = await transport.waitHostCommand(submitted.id, signal)
  return (result ?? {}) as transport.PiNavigateTreeResult
}

/**
 * Import a session file and switch to it. Same replacement shape as fork.
 */
export async function importPiSession(
  sessionId: string,
  inputPath: string,
  cwdOverride?: string,
  signal?: AbortSignal,
): Promise<transport.PiForkResult> {
  const submitted = await transport.importPiSession(sessionId, inputPath, cwdOverride, signal)
  const result = await transport.waitHostCommand(submitted.id, signal)
  return (result ?? {}) as transport.PiForkResult
}

/**
 * Set an entry label, then refresh session state (tree labels ride along).
 */
export async function setPiEntryLabel(sessionId: string, entryId: string, label?: string, signal?: AbortSignal): Promise<void> {
  const submitted = await transport.setPiLabel(sessionId, entryId, label, signal)
  await transport.waitHostCommand(submitted.id, signal)
}

export async function setPiActiveTools(sessionId: string, toolNames: string[], signal?: AbortSignal): Promise<void> {
  const submitted = await transport.setPiActiveTools(sessionId, toolNames, signal)
  await transport.waitHostCommand(submitted.id, signal)
}

export async function setPiAutoCompaction(sessionId: string, enabled: boolean, signal?: AbortSignal): Promise<void> {
  const submitted = await transport.setPiAutoCompaction(sessionId, enabled, signal)
  await transport.waitHostCommand(submitted.id, signal)
}

export async function setPiAutoRetry(sessionId: string, enabled: boolean, signal?: AbortSignal): Promise<void> {
  const submitted = await transport.setPiAutoRetry(sessionId, enabled, signal)
  await transport.waitHostCommand(submitted.id, signal)
}

/** Abort an active compaction (immediate). */
export async function abortPiCompaction(sessionId: string, signal?: AbortSignal): Promise<void> {
  await transport.abortPiCompaction(sessionId, signal)
}

/** Abort an active branch summary (immediate). */
export async function abortPiBranchSummary(sessionId: string, signal?: AbortSignal): Promise<void> {
  await transport.abortPiBranchSummary(sessionId, signal)
}

/** Abort an active auto-retry (immediate). */
export async function abortPiRetry(sessionId: string, signal?: AbortSignal): Promise<void> {
  await transport.abortPiRetry(sessionId, signal)
}

/** Clear pending steering/follow-up queues (immediate). */
export async function clearPiQueue(sessionId: string, signal?: AbortSignal): Promise<void> {
  await transport.clearPiQueue(sessionId, signal)
}

export async function setPiSteeringMode(sessionId: string, mode: 'all' | 'one-at-a-time', signal?: AbortSignal): Promise<void> {
  await transport.setPiSteeringMode(sessionId, mode, signal)
}

export async function setPiFollowUpMode(sessionId: string, mode: 'all' | 'one-at-a-time', signal?: AbortSignal): Promise<void> {
  await transport.setPiFollowUpMode(sessionId, mode, signal)
}

/**
 * Load available models from the Pi model runtime into the models store.
 */
const modelFlights = new Map<number, Promise<Model<any>[]>>()

export async function loadPiModels(signal?: AbortSignal): Promise<Model<any>[]> {
  const serverGeneration = serverStore.getActiveServerGeneration()
  const existing = modelFlights.get(serverGeneration)
  if (existing) return existing

  const flight = loadPiModelsOnce(serverGeneration, signal)
  modelFlights.set(serverGeneration, flight)
  void flight.finally(() => {
    if (modelFlights.get(serverGeneration) === flight) modelFlights.delete(serverGeneration)
  }).catch(() => undefined)
  return flight
}

export async function setPiProjectTrust(cwd: string, decision: boolean | null, signal?: AbortSignal): Promise<void> {
  await transport.setProjectTrust(cwd, decision, signal)
}

export async function logoutPiProvider(providerId: string, signal?: AbortSignal): Promise<void> {
  await transport.logoutProvider(providerId, signal)
}

export async function startPiProviderAuth(providerId: string, authType?: 'api_key' | 'oauth', signal?: AbortSignal): Promise<void> {
  await transport.startProviderAuth(providerId, authType, signal)
}

async function loadPiModelsOnce(serverGeneration: number, signal?: AbortSignal): Promise<Model<any>[]> {
  piModelsStore.setLoading(true)
  try {
    const result = await retryUnavailable(() => transport.listPiModels(signal), signal)
    const models = (Array.isArray(result) ? result : []) as unknown as Model<any>[]
    if (serverStore.getActiveServerGeneration() !== serverGeneration) return models
    piModelsStore.setModels(models)
    return models
  } catch (error) {
    if (serverStore.getActiveServerGeneration() !== serverGeneration) throw error
    piModelsStore.setError(error as Error)
    throw error
  }
}
