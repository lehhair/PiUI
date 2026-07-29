import type { JsonObject } from '@piui/protocol'
import * as transport from '../transport/index.js'
import { piSessionInfoStore, piBranchStore, piSessionStateStore } from '../state/index.js'

/**
 * Load all Pi sessions globally.
 */
export async function loadPiSessions(signal?: AbortSignal): Promise<void> {
  try {
    const sessions = await transport.listAllPiSessions(signal)
    piSessionInfoStore.replaceAll(sessions)
  } catch (error) {
    console.error('Failed to load Pi sessions:', error)
    throw error
  }
}

/**
 * Load Pi sessions for specific working directory.
 */
export async function loadPiSessionsForCwd(cwd: string, signal?: AbortSignal): Promise<void> {
  try {
    const sessions = await transport.listPiSessions({ cwd }, signal)
    piSessionInfoStore.replaceForCwd(cwd, sessions)
  } catch (error) {
    console.error(`Failed to load Pi sessions for ${cwd}:`, error)
    throw error
  }
}

/**
 * Open a Pi session and load its initial data.
 */
export async function openPiSession(cwd: string, sessionFile?: string, signal?: AbortSignal): Promise<{ sessionId: string; state: JsonObject }> {
  try {
    const result = await transport.openPiSession({ cwd, sessionFile }, signal)

    if (!result.sessionId) {
      throw new Error('Session open failed: no sessionId returned')
    }

    // Load initial state and branch data
    await loadPiSessionData(result.sessionId, signal)

    return {
      sessionId: result.sessionId,
      state: result.state as JsonObject,
    }
  } catch (error) {
    console.error('Failed to open Pi session:', error)
    throw error
  }
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
    const nextPage = await transport.getPiBranchPage(
      sessionId,
      { cursor: currentBranch.beforeCursor, limit: 200 },
      signal,
    )

    // Merge with existing data
    piBranchStore.setData({
      ...nextPage,
      items: [...currentBranch.items, ...nextPage.items],
    })
  } catch (error) {
    console.error('Failed to load more branch entries:', error)
    throw error
  }
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
