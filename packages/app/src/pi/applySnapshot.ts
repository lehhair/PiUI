import type { PiNativeEntriesPageV1, SessionSnapshotV1 } from "@piui/protocol"
import { messageStore } from "../store/messageStore"
import { activeSessionStore } from "../store/activeSessionStore"
import { nativeSessionStore } from "./nativeSessionStore"
import { trackPiSession } from "./piSessionIndex"
import { nativeEntriesToUiMessages } from "./nativeEntriesToMessages"
import { fetchPiNativeEntriesPage, fetchSnapshot } from "./sessionApi"

function publishNativeMessages(sessionId: string): void {
  const snapshot = nativeSessionStore.getSnapshot(sessionId)
  if (!snapshot || !nativeSessionStore.hasNativePage(sessionId)) return
  const history = nativeSessionStore.getHistoryState(sessionId)
  const model = snapshot.runtime.model
    ? { providerID: snapshot.runtime.model.provider, modelID: snapshot.runtime.model.id }
    : undefined
  const branch = nativeSessionStore.getActiveBranch(sessionId)
  if (branch.length === 0 && snapshot.native.entryCount > 0 && (messageStore.getSessionState(sessionId)?.messages.length ?? 0) > 0) {
    messageStore.updateSessionMetadata(sessionId, {
      title: snapshot.session.title,
      directory: snapshot.session.directory,
      hasMoreHistory: history.hasMore,
      historyCursor: history.beforeCursor,
    })
    return
  }
  const messages = nativeEntriesToUiMessages(branch, {
    sessionId,
    directory: snapshot.session.directory,
    model,
    streamingEntryIds: nativeSessionStore.getStreamingEntryIds(sessionId),
    liveTools: nativeSessionStore.getLiveTools(sessionId),
  })
  if (nativeSessionStore.hasDisconnectedTransientBranch(sessionId)) {
    const existing = messageStore.getSessionState(sessionId)?.messages ?? []
    const transientIds = new Set(messages.map(message => message.info.id))
    messageStore.setUiMessages(sessionId, [
      ...existing.filter(message => !transientIds.has(message.info.id)),
      ...messages,
    ], {
      title: snapshot.session.title,
      directory: snapshot.session.directory,
      hasMoreHistory: history.hasMore,
      historyCursor: history.beforeCursor,
    })
    messageStore.setStreaming(sessionId, nativeSessionStore.getNativeEventStreaming(sessionId) ?? snapshot.runtime.isStreaming)
    return
  }
  messageStore.setUiMessages(sessionId, messages, {
    title: snapshot.session.title,
    directory: snapshot.session.directory,
    hasMoreHistory: history.hasMore,
    historyCursor: history.beforeCursor,
  })
  const nativeStreaming = nativeSessionStore.getNativeEventStreaming(sessionId)
  messageStore.setStreaming(sessionId, nativeStreaming ?? snapshot.runtime.isStreaming)
}

/** Push a Pi snapshot into the UI stores consumed by ChatArea. */
export function applySnapshotToUi(
  snapshot: SessionSnapshotV1,
  options?: { activate?: boolean; nativePage?: PiNativeEntriesPageV1; refreshNative?: boolean },
) {
  trackPiSession(snapshot.session.id, snapshot.session.directory)
  activeSessionStore.syncPiSnapshot(snapshot)
  const replaced = nativeSessionStore.replace(snapshot, options)
  if (options?.nativePage) nativeSessionStore.replaceFirstPage(snapshot.session.id, options.nativePage)
  publishNativeMessages(snapshot.session.id)
  if (!options?.nativePage && replaced.nativeChanged && options?.refreshNative !== false) {
    void refreshPiNativeEntries(snapshot.session.id).catch(() => undefined)
  }
  return snapshot.session.id
}

export async function loadPiSessionToUi(sessionId: string, options?: { activate?: boolean }): Promise<SessionSnapshotV1> {
  const snapshot = await fetchSnapshot(sessionId)
  const nativePage = await fetchPiNativeEntriesPage(sessionId)
  applySnapshotToUi(snapshot, { ...options, nativePage })
  return snapshot
}

export async function refreshPiNativeEntries(sessionId: string): Promise<void> {
  const page = await fetchPiNativeEntriesPage(sessionId)
  if (nativeSessionStore.replaceFirstPage(sessionId, page)) publishNativeMessages(sessionId)
}

export async function resyncPiSessionToUi(sessionId: string, options?: { activate?: boolean }): Promise<void> {
  const snapshot = await fetchSnapshot(sessionId)
  const nativePage = await fetchPiNativeEntriesPage(sessionId)
  applySnapshotToUi(snapshot, { ...options, nativePage, refreshNative: false })
}

export function appendPiNativeEntriesPageToUi(sessionId: string, page: PiNativeEntriesPageV1): boolean {
  const applied = nativeSessionStore.appendOlderPage(sessionId, page)
  if (applied) publishNativeMessages(sessionId)
  return applied
}

export function applyPiNativeEventToUi(sessionId: string, event: unknown): boolean {
  const applied = nativeSessionStore.applyNativeEvent(sessionId, event)
  if (applied) publishNativeMessages(sessionId)
  return applied
}
