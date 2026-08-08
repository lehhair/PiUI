/** Tracks session ids owned by piui-server (not a legacy transport). */

const ids = new Set<string>()
const workspacePathBySession = new Map<string, string>()
const explicitWorkspacePaths = new Set<string>()
const MAX_EXPLICIT_WORKSPACES = 64
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

export function reconcilePiSessions(currentIds: Iterable<string>, workspacePath?: string): string[] {
  const current = new Set(currentIds)
  const removed: string[] = []
  for (const id of ids) {
    if (current.has(id)) continue
    if (workspacePath && workspacePathBySession.get(id) !== workspacePath) continue
    ids.delete(id)
    workspacePathBySession.delete(id)
    removed.push(id)
  }
  if (removed.length > 0) emit()
  return removed
}

export function listTrackedPiWorkspacePaths(): string[] {
  return [...new Set([...workspacePathBySession.values(), ...explicitWorkspacePaths])]
}

export function trackPiWorkspace(workspacePath: string): void {
  if (!workspacePath || explicitWorkspacePaths.has(workspacePath)) return
  if (explicitWorkspacePaths.size >= MAX_EXPLICIT_WORKSPACES) {
    const oldest = explicitWorkspacePaths.values().next().value
    if (oldest) explicitWorkspacePaths.delete(oldest)
  }
  explicitWorkspacePaths.add(workspacePath)
  emit()
}

export function clearPiSessionIndex(): void {
  if (ids.size === 0 && explicitWorkspacePaths.size === 0) return
  ids.clear()
  workspacePathBySession.clear()
  explicitWorkspacePaths.clear()
  emit()
}

export function subscribePiSessionIndex(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
