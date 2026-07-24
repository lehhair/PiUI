/** Encode workspace id into session.directory without exposing host paths. */
export const PI_WS_PREFIX = "piws:"

export function toPiWorkspaceDirectory(workspaceId: string): string {
  return `${PI_WS_PREFIX}${workspaceId}`
}

export function parsePiWorkspaceId(directory?: string | null): string | null {
  if (!directory || !directory.startsWith(PI_WS_PREFIX)) return null
  const id = directory.slice(PI_WS_PREFIX.length).trim()
  return id || null
}

export function isPiWorkspaceDirectory(directory?: string | null): boolean {
  return parsePiWorkspaceId(directory) != null
}
