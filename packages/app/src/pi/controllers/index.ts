import type { JsonObject } from '@piui/protocol'
import type { SessionInfo } from '@earendil-works/pi-coding-agent'
import type { Model } from '@earendil-works/pi-ai'
import * as transport from '../transport/index.js'
import { piSessionInfoStore, piBranchStore, piSessionStateStore, piModelsStore } from '../state/index.js'
import { mergeLatestBranchPage } from '../branchMerge.js'

/**
 * Load all Pi sessions globally.
 */
export async function loadPiSessions(signal?: AbortSignal): Promise<SessionInfo[]> {
  const sessions = await transport.listAllPiSessions(signal)
  piSessionInfoStore.replaceAll(sessions)
  return sessions
}

/**
 * Load Pi sessions for specific working directory.
 */
export async function loadPiSessionsForCwd(cwd: string, signal?: AbortSignal): Promise<SessionInfo[]> {
  const sessions = await transport.listPiSessions({ cwd }, signal)
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
export async function openPiSession(cwd: string, sessionFile?: string, signal?: AbortSignal): Promise<transport.PiSessionOpenResult> {
  const result = await transport.openPiSession({ cwd, sessionFile }, signal)

  if (!result.sessionId) {
    throw new Error('Session open failed: no sessionId returned')
  }

  // Load initial state and branch data
  await loadPiSessionData(result.sessionId, signal)

  return result
}

/**
 * Load session data (state + branch) for active session.
 */
export async function loadPiSessionData(sessionId: string, signal?: AbortSignal): Promise<void> {
  try {
    // Load both in parallel
    const [state, branch] = await Promise.all([
      transport.getPiSessionState(sessionId, signal),
      transport.getPiBranchPage(sessionId, { limit: 200 }, signal),
    ])

    piSessionStateStore.setState(state as JsonObject)
    piBranchStore.setData(branch)
  } catch (error) {
    console.error('Failed to load session data:', error)
    piSessionStateStore.setError(error as Error)
    piBranchStore.setError(error as Error)
    throw error
  }
}

/**
 * Load more branch entries (pagination).
 * Pages grow backwards: beforeCursor anchors the oldest entry of the current
 * page, so older items must be PREPENDED. checkpoint only exists on the
 * first (latest) page — preserve it when merging older pages.
 */
export async function loadMorePiBranchEntries(sessionId: string, signal?: AbortSignal): Promise<void> {
  const currentBranch = piBranchStore.getData()
  if (!currentBranch) {
    throw new Error('No branch data loaded')
  }

  if (!currentBranch.hasMore || !currentBranch.beforeCursor) {
    return // No more data
  }

  try {
    const olderPage = await transport.getPiBranchPage(
      sessionId,
      { cursor: currentBranch.beforeCursor, limit: 200 },
      signal,
    )

    // Prepend older items; keep latest head/hasMore/cursor from the new page
    piBranchStore.setData({
      ...olderPage,
      checkpoint: currentBranch.checkpoint,
      items: [...olderPage.items, ...currentBranch.items],
    })
  } catch (error) {
    console.error('Failed to load more branch entries:', error)
    throw error
  }
}

/**
 * Refresh branch with the latest page, merging local pagination history.
 * Used by the event stream when head revision changes.
 */
export async function refreshPiBranch(sessionId: string, signal?: AbortSignal): Promise<void> {
  const latest = await transport.getPiBranchPage(sessionId, { limit: 200 }, signal)
  piBranchStore.setData(mergeLatestBranchPage(piBranchStore.getData(), latest))
}

/**
 * Refresh runtime state only.
 * Used by the event stream when state-only events arrive.
 */
export async function refreshPiSessionState(sessionId: string, signal?: AbortSignal): Promise<void> {
  const state = await transport.getPiSessionState(sessionId, signal)
  piSessionStateStore.setState(state as JsonObject)
}

/**
 * Send a prompt to Pi session.
 */
export async function sendPiPrompt(sessionId: string, text: string, signal?: AbortSignal): Promise<void> {
  try {
    await transport.promptPi(sessionId, { text }, signal)
    // State will be updated via events
  } catch (error) {
    console.error('Failed to send prompt:', error)
    throw error
  }
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
    await transport.setPiModel(sessionId, { provider, modelId }, signal)
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
    await transport.setPiThinkingLevel(sessionId, { level }, signal)
  } catch (error) {
    console.error('Failed to set thinking level:', error)
    throw error
  }
}

/**
 * Rename a Pi session.
 */
export async function renamePiSession(sessionId: string, name: string, signal?: AbortSignal): Promise<void> {
  await transport.setPiSessionName(sessionId, name, signal)
}

/**
 * Load available models from the Pi model runtime into the models store.
 */
export async function loadPiModels(signal?: AbortSignal): Promise<Model<any>[]> {
  piModelsStore.setLoading(true)
  try {
    const result = await transport.listPiModels(signal)
    const models = (Array.isArray(result) ? result : []) as Model<any>[]
    piModelsStore.setModels(models)
    return models
  } catch (error) {
    piModelsStore.setError(error as Error)
    throw error
  }
}
