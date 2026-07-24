/** Tracks session ids owned by piui-server (not OpenCode). */

const ids = new Set<string>()
const listeners = new Set<() => void>()

function emit() {
  for (const l of listeners) l()
}

export function trackPiSession(id: string) {
  if (!id || ids.has(id)) return
  ids.add(id)
  emit()
}

export function untrackPiSession(id: string) {
  if (ids.delete(id)) emit()
}

export function isTrackedPiSession(id: string | null | undefined): boolean {
  return !!id && ids.has(id)
}

export function listTrackedPiSessions(): string[] {
  return [...ids]
}

export function subscribePiSessionIndex(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
