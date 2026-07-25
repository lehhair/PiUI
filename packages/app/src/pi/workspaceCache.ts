/** Client-side path ↔ workspaceId cache (local trusted). */

const pathToId = new Map<string, string>()
const idToPath = new Map<string, string>()

function norm(p: string): string {
  const slashed = p.replace(/\\/g, "/")
  const normalized = slashed === "/" ? "/" : slashed.replace(/\/+$/, "")
  return /^[a-zA-Z]:(?:\/|$)/.test(normalized) || normalized.startsWith("//")
    ? normalized.toLowerCase()
    : normalized
}

export function cacheWorkspace(rootPath: string, workspaceId: string) {
  const key = norm(rootPath)
  pathToId.set(key, workspaceId)
  idToPath.set(workspaceId, rootPath)
}

export function getWorkspaceIdByPath(rootPath: string): string | undefined {
  return pathToId.get(norm(rootPath))
}

export function getPathByWorkspaceId(workspaceId: string): string | undefined {
  return idToPath.get(workspaceId)
}
