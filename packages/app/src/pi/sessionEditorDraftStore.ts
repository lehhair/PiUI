import { useSyncExternalStore } from "react"

interface SessionEditorDraft {
  text: string
  revision: number
}

const drafts = new Map<string, SessionEditorDraft>()
const listeners = new Set<() => void>()
let revision = 0

function emit() {
  for (const listener of listeners) listener()
}

export function setSessionEditorDraft(sessionId: string, text: string) {
  drafts.set(sessionId, { text, revision: ++revision })
  emit()
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
