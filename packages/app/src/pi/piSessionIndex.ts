/** Tracks session ids owned by piui-server (not OpenCode). */

const ids = new Set<string>()
const workspaceBySession = new Map<string, string>()
const listeners = new Set<() => void>()

function emit() {
  for (const l of listeners) l()
}

export function trackPiSession(id: string, workspaceId?: string) {
  if (!id) return
  const added = !ids.has(id)
  const workspaceChanged = Boolean(workspaceId && workspaceBySession.get(id) !== workspaceId)
  ids.add(id)
  if (workspaceId) workspaceBySession.set(id, workspaceId)
  if (added || workspaceChanged) emit()
}

export function untrackPiSession(id: string) {
  workspaceBySession.delete(id)
  if (ids.delete(id)) emit()
}

export function isTrackedPiSession(id: string | null | undefined): boolean {
  return !!id && ids.has(id)
}

export function listTrackedPiSessions(): string[] {
  return [...ids]
}

export function listTrackedPiWorkspaces(): string[] {
  return [...new Set(workspaceBySession.values())]
}

export function clearPiSessionIndex(): void {
  if (ids.size === 0) return
  ids.clear()
  workspaceBySession.clear()
  emit()
}

export function subscribePiSessionIndex(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
