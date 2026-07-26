/** Tracks session ids owned by piui-server (not OpenCode). */

const ids = new Set<string>()
const workspacePathBySession = new Map<string, string>()
const listeners = new Set<() => void>()

function emit() {
  for (const l of listeners) l()
}

export function trackPiSession(id: string, workspacePath?: string) {
  if (!id) return
  const added = !ids.has(id)
  const workspaceChanged = Boolean(workspacePath && workspacePathBySession.get(id) !== workspacePath)
  ids.add(id)
  if (workspacePath) workspacePathBySession.set(id, workspacePath)
  if (added || workspaceChanged) emit()
}

export function untrackPiSession(id: string) {
  workspacePathBySession.delete(id)
  if (ids.delete(id)) emit()
}

export function isTrackedPiSession(id: string | null | undefined): boolean {
  return !!id && ids.has(id)
}

export function listTrackedPiSessions(): string[] {
  return [...ids]
}

export function listTrackedPiWorkspacePaths(): string[] {
  return [...new Set(workspacePathBySession.values())]
}

export function clearPiSessionIndex(): void {
  if (ids.size === 0) return
  ids.clear()
  workspacePathBySession.clear()
  emit()
}

export function subscribePiSessionIndex(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
