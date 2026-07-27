import { useSyncExternalStore } from "react"

interface SessionEditorDraft {
  text: string
  revision: number
}

const drafts = new Map<string, SessionEditorDraft>()
const listeners = new Set<() => void>()
const syncTimers = new Map<string, ReturnType<typeof setTimeout>>()
let syncDraft: ((sessionId: string, text: string) => void | Promise<void>) | undefined
let revision = 0

function emit() {
  for (const listener of listeners) listener()
}

export function setSessionEditorDraft(sessionId: string, text: string, options: { sync?: boolean } = {}) {
  drafts.set(sessionId, { text, revision: ++revision })
  emit()
  if (options.sync === false || !syncDraft) return
  const previous = syncTimers.get(sessionId)
  if (previous) clearTimeout(previous)
  syncTimers.set(sessionId, setTimeout(() => {
    syncTimers.delete(sessionId)
    void syncDraft?.(sessionId, text)
  }, 100))
}

export function configureSessionEditorDraftSync(
  sync: ((sessionId: string, text: string) => void | Promise<void>) | undefined,
): void {
  syncDraft = sync
  if (sync) return
  for (const timer of syncTimers.values()) clearTimeout(timer)
  syncTimers.clear()
}

export function clearSessionEditorDraft(sessionId: string) {
  if (!drafts.delete(sessionId)) return
  emit()
}

export function useSessionEditorDraft(sessionId: string | null): SessionEditorDraft | null {
  return useSyncExternalStore(
    listener => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => (sessionId ? drafts.get(sessionId) ?? null : null),
    () => null,
  )
}
